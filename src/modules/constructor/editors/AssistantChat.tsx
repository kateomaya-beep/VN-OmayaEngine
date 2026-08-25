import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useProjectStore } from '../projectStore';
import type { Project } from '../../../shared/types';
import { Markdown } from '../../../shared/markdown';
import { runCompletion } from '../../../ai/providers';
import { usePresetSettings } from '../../../ai/presetSettings';
import { pushToast } from '../../../shared/toast';
import { logEvent } from '../../../shared/logStore';
import { MessageMenu, type MessageMenuItem } from '../../../shared/MessageMenu';
import { copyToClipboard } from '../../../shared/utils';
import {
  applyAssistantOps,
  buildAssistantSystem,
  parseAssistantReply,
  revertAssistantChanges,
  streamingAssistantText,
  stripApplyBlock,
  DEFAULT_ASSISTANT_PERSONA,
  type AssistantMessage,
} from '../../../ai/assistant';

// ЧАТ С АССИСТЕНТОМ-СОАВТОРОМ.
//
// Он видит проект целиком (см. projectDigest) и умеет его править — но каждая
// правка показана строкой «что изменилось» и снабжена откатом. Это не украшение:
// помощник, который молча переписывает то, что вы писали руками, хуже, чем никакой.
//
// Личность ассистента — глобальная настройка (это ваш помощник, а не свойство
// проекта), переписка — проектная (разговор про ЭТОТ сеттинг вне его бессмыслен).

const QUICK: { label: string; text: string }[] = [
  { label: 'Персонаж', text: 'Придумай нового персонажа, который органично вписывается в этот мир, и заведи его в проекте. Спроси, если нужна роль.' },
  { label: 'Дожать карточку', text: 'Посмотри карточки персонажей и скажи, где характер заявлен, но не слышен в манере речи. Предложи правки.' },
  { label: 'Лорбук', text: 'Предложи 3–5 записей лорбука по этому миру: места, обычаи, организации. Ключи подбери так, чтобы они реально встречались в тексте.' },
  { label: 'Мир', text: 'Прочитай описание мира и скажи, чего в нём не хватает, чтобы модель не импровизировала лишнего. Не переписывай без просьбы.' },
  { label: 'Стартовая сцена', text: 'Предложи стартовую сцену: где герой, что только что произошло, с чего начинается первый ход.' },
];

// Компонент используется и в конструкторе (без пропсов — берёт проект из
// projectStore), и в плеере во время игры (Task 15): там своё хранилище
// (playerStore), поэтому проект и мутатор можно передать явно.
export function AssistantChat(props?: {
  project?: Project | null;
  update?: (mutator: (p: Project) => void) => void;
}) {
  const store = useProjectStore();
  const project = props?.project !== undefined ? props.project : store.project;
  const update = props?.update ?? store.update;
  const cfg = usePresetSettings((s) => s.settings);
  const patchCfg = usePresetSettings((s) => s.patch);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [stream, setStream] = useState('');
  const [personaOpen, setPersonaOpen] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [editText, setEditText] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  const chat = (project?.assistantChat as AssistantMessage[] | undefined) ?? [];

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.length, stream, busy]);

  // Правка закрывается сама, если сообщение исчезло (удаление, перегенерация,
  // очистка переписки) — иначе открытая форма правила бы чужой текст под тем же
  // индексом.
  useEffect(() => {
    if (editing !== null && editing >= chat.length) setEditing(null);
  }, [chat.length, editing]);

  if (!project) return null;

  const setChat = (next: AssistantMessage[]) =>
    update((p) => {
      p.assistantChat = next;
    });

  // Общий вызов модели: принимает переписку, ЗАКАНЧИВАЮЩУЮСЯ вопросом игрока, и
  // дописывает в неё ответ ассистента. Отдельная функция — чтобы обычная отправка
  // и перегенерация (тот же запрос, без нового сообщения игрока) не расходились.
  async function ask(history: AssistantMessage[]) {
    if (!project) return;
    setBusy(true);
    setStream('');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      // Служебный блок правок в контекст не пересылаем: применённые изменения уже
      // видны в слепке проекта, а второй копией они только путают.
      const messages = history.map((m) => ({
        role: m.role,
        content: m.role === 'assistant' ? stripApplyBlock(m.content) : m.content,
      }));
      let acc = '';
      const raw = await runCompletion({
        system: buildAssistantSystem(project, cfg.assistantPersona),
        messages,
        temperature: Math.min(cfg.temperature, 1),
        maxTokens: 4000,
        signal: controller.signal,
        onDelta: (chunk) => {
          acc += chunk;
          setStream(streamingAssistantText(acc));
        },
      });

      const parsed = parseAssistantReply(raw);
      let changes: ReturnType<typeof applyAssistantOps> = [];
      if (parsed.ops.length) {
        update((p) => {
          changes = applyAssistantOps(p, parsed.ops);
        });
        if (changes.length) logEvent('info', 'prompt', `Ассистент внёс правок: ${changes.length}`);
      }
      setChat([
        ...history,
        { role: 'assistant', content: raw, changes: changes.length ? changes : undefined },
      ]);
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') {
        // Отмена — не ошибка: вопрос остаётся в переписке, ответа просто нет.
        logEvent('info', 'prompt', 'Ответ ассистента отменён');
      } else {
        pushToast('error', 'Ассистент не ответил: ' + (e as Error).message);
        logEvent('error', 'prompt', 'Ассистент: ' + (e as Error).message);
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
      setStream('');
    }
  }

  async function send(text: string) {
    const body = text.trim();
    if (!body || busy || !project) return;
    const history: AssistantMessage[] = [...chat, { role: 'user', content: body }];
    setChat(history);
    setDraft('');
    await ask(history);
  }

  // Перегенерация — только для последнего ответа ассистента: откатить правки,
  // применённые прежним ответом (иначе они осядут в проекте без сообщения, к
  // которому привязана кнопка отмены), убрать его из переписки и спросить заново.
  async function regenerate(index: number) {
    const msg = chat[index];
    if (busy || !project || msg?.role !== 'assistant' || index !== chat.length - 1) return;
    if (msg.changes?.length && !msg.reverted) {
      update((p) => revertAssistantChanges(p, msg.changes!));
    }
    const history = chat.slice(0, index);
    setChat(history);
    await ask(history);
  }

  function deleteMessage(index: number) {
    const msg = chat[index];
    if (!msg) return;
    if (!confirm('Удалить это сообщение из переписки?')) return;
    if (msg.changes?.length && !msg.reverted) {
      update((p) => revertAssistantChanges(p, msg.changes!));
    }
    setChat(chat.filter((_, i) => i !== index));
    if (editing === index) setEditing(null);
  }

  function startEdit(index: number) {
    setEditing(index);
    setEditText(chat[index]?.content ?? '');
  }

  function commitEdit() {
    if (editing === null) return;
    setChat(chat.map((m, i) => (i === editing ? { ...m, content: editText } : m)));
    setEditing(null);
  }

  function undo(index: number) {
    const msg = chat[index];
    if (!msg?.changes?.length || msg.reverted) return;
    update((p) => {
      revertAssistantChanges(p, msg.changes!);
      const next = [...((p.assistantChat as AssistantMessage[]) ?? [])];
      next[index] = { ...next[index], reverted: true };
      p.assistantChat = next;
    });
    pushToast('success', 'Правки отменены — проект вернулся к тому, что было.');
  }

  return (
    <div className="grid lg:grid-cols-[1fr_280px] gap-4">
      <div className="card flex flex-col" style={{ minHeight: '60vh' }}>
        <div ref={scrollRef} className="flex-1 overflow-y-auto space-y-3 pr-1" style={{ maxHeight: '60vh' }}>
          {chat.length === 0 && !busy && (
            <div className="text-sm text-gray-500 py-8 text-center">
              Спросите совета или попросите что-нибудь завести — персонажа, запись лорбука, стартовую
              сцену. Ассистент видит весь проект и меняет его только явно, показывая, что именно
              изменил.
            </div>
          )}

          {chat.map((m, i) => {
            const displayText = m.role === 'assistant' ? stripApplyBlock(m.content) : m.content;
            const menuItems: MessageMenuItem[] = [
              { label: 'Редактировать', icon: '✎', onClick: () => startEdit(i) },
              { label: 'Копировать', icon: '⧉', onClick: () => copyToClipboard(displayText) },
            ];
            if (m.role === 'assistant' && i === chat.length - 1) {
              menuItems.push({ label: 'Перегенерировать', icon: '↻', onClick: () => void regenerate(i) });
            }
            menuItems.push({ label: 'Удалить', icon: '✕', onClick: () => deleteMessage(i), danger: true });
            return (
            <div
              key={i}
              className={`group relative rounded-xl px-3.5 py-2.5 border ${
                m.role === 'user'
                  ? 'bg-accent2/10 border-accent2/25'
                  : 'bg-panel2 border-white/10'
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <div className="text-[11px] font-semibold tracking-wide text-gray-400">
                  {m.role === 'user' ? 'Вы' : 'Ассистент'}
                </div>
                {editing !== i && (
                  <div className="opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                    <MessageMenu items={menuItems} disabled={busy} />
                  </div>
                )}
              </div>
              {editing === i ? (
                <div>
                  <textarea
                    className="input w-full h-32 text-sm font-mono"
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                  />
                  <div className="flex gap-2 justify-end mt-2">
                    <button className="btn-ghost !py-1 !px-3 text-xs" onClick={() => setEditing(null)}>
                      Отмена
                    </button>
                    <button className="btn-primary !py-1 !px-3 text-xs" onClick={commitEdit}>
                      Сохранить
                    </button>
                  </div>
                </div>
              ) : (
              <Markdown
                text={displayText}
                className="block text-sm leading-relaxed whitespace-pre-wrap"
              />
              )}
              {!!m.changes?.length && (
                <div
                  className={`mt-2.5 rounded-lg border p-2.5 ${
                    m.reverted
                      ? 'border-white/10 bg-black/20 opacity-60'
                      : 'border-emerald-400/30 bg-emerald-500/10'
                  }`}
                >
                  <div className="text-[11px] font-semibold mb-1 text-emerald-300">
                    {m.reverted ? 'Правки отменены' : `Изменено в проекте (${m.changes.length})`}
                  </div>
                  <ul className="text-xs space-y-0.5 text-gray-300">
                    {m.changes.map((c, j) => (
                      <li key={j}>• {c.label}</li>
                    ))}
                  </ul>
                  {!m.reverted && (
                    <button className="btn-ghost !py-1 !px-2.5 text-xs mt-2" onClick={() => undo(i)}>
                      ↩ Отменить эти правки
                    </button>
                  )}
                </div>
              )}
            </div>
            );
          })}

          {busy && (
            <div className="rounded-xl px-3.5 py-2.5 border bg-panel2 border-white/10">
              <div className="text-[11px] font-semibold tracking-wide mb-1 text-gray-400">Ассистент</div>
              {stream ? (
                <Markdown text={stream} className="block text-sm leading-relaxed whitespace-pre-wrap" />
              ) : (
                <div className="text-sm text-gray-500">думает…</div>
              )}
            </div>
          )}
        </div>

        <div className="pt-3 mt-3 border-t border-white/10">
          <div className="flex gap-1.5 flex-wrap mb-2">
            {QUICK.map((q) => (
              <button
                key={q.label}
                className="chip !px-2.5 !py-1 text-xs"
                disabled={busy}
                title={q.text}
                onClick={() => send(q.text)}
              >
                {q.label}
              </button>
            ))}
          </div>
          <div className="flex gap-2 items-end">
            <textarea
              className="input flex-1 h-20 text-sm"
              placeholder="Что обсудим? (Enter — отправить, Shift+Enter — перенос строки)"
              value={draft}
              disabled={busy}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send(draft);
                }
              }}
            />
            {busy ? (
              <button className="btn-ghost !py-2" onClick={() => abortRef.current?.abort()}>
                ✕ Стоп
              </button>
            ) : (
              <button className="btn-primary !py-2" onClick={() => void send(draft)}>
                Отправить
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <div className="card">
          <button
            className="w-full text-left font-semibold text-sm flex items-center justify-between"
            onClick={() => setPersonaOpen((v) => !v)}
          >
            <span>Личность ассистента</span>
            <span className="text-gray-500">{personaOpen ? '▲' : '▼'}</span>
          </button>
          <p className="text-xs text-gray-500 mt-1">
            Общая для всех проектов — это ваш помощник, а не свойство сеттинга.
          </p>
          {personaOpen && (
            <>
              <textarea
                className="input h-44 text-sm mt-2"
                placeholder={DEFAULT_ASSISTANT_PERSONA}
                value={cfg.assistantPersona}
                onChange={(e) => patchCfg({ assistantPersona: e.target.value })}
              />
              <div className="flex gap-2 mt-2">
                <button
                  className="btn-ghost !py-1 !px-2.5 text-xs"
                  onClick={() => patchCfg({ assistantPersona: DEFAULT_ASSISTANT_PERSONA })}
                >
                  Вписать дефолтную
                </button>
                {!!cfg.assistantPersona && (
                  <button className="btn-ghost !py-1 !px-2.5 text-xs" onClick={() => patchCfg({ assistantPersona: '' })}>
                    Очистить
                  </button>
                )}
              </div>
              <p className="text-[11px] text-gray-500 mt-2">
                Пусто — работает дефолтная: спокойный редактор без воды. Правила про то, КАК он
                правит проект, добавляются поверх и не отключаются.
              </p>
            </>
          )}
        </div>

        <div className="card">
          <h4 className="font-semibold text-sm mb-1">Что он видит</h4>
          <p className="text-xs text-gray-500">
            Описание мира, арку, стартовую сцену, правила повествования, все карточки персонажей,
            заголовки и ключи лорбука, статы. Содержимое записей лорбука — по запросу: иначе каждый
            вопрос стоил бы как целый ход игры.
          </p>
        </div>

        <div className="card">
          <h4 className="font-semibold text-sm mb-1">Что он может изменить</h4>
          <ul className="text-xs text-gray-500 space-y-0.5">
            <li>• завести и править персонажей</li>
            <li>• добавлять и править записи лорбука</li>
            <li>• заменять описание мира, арку, стартовую сцену, правила</li>
            <li>• заводить статы</li>
          </ul>
          <p className="text-[11px] text-gray-500 mt-2">
            Каждая правка показана списком и отменяется кнопкой. Ассеты, спрайты и настройки
            подключения он не трогает.
          </p>
        </div>

        {chat.length > 0 && (
          <button
            className="btn-ghost w-full !py-1.5 text-xs"
            onClick={() => {
              if (confirm('Очистить переписку с ассистентом? Внесённые правки останутся в проекте.'))
                setChat([]);
            }}
          >
            Очистить переписку
          </button>
        )}
      </div>
    </div>
  );
}
