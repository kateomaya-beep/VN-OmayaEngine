import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { usePlayerStore } from '../playerStore';
import { Console } from './Console';
import { Markdown } from '../../../shared/markdown';
import { stripMoveTag } from '../../../ai/responseParser';
import { parseRpResponse } from '../../../ai/rpResponse';
import { protagonistName } from '../../../ai/macros';
import { applyRegexRules } from '../../../ai/regexRules';
import { usePresetSettings } from '../../../ai/presetSettings';
import { uploadAsset } from '../../../storage/assetOps';
import type { Project, WorldStateUpdate } from '../../../shared/types';
import { Avatar, characterAvatarKey, heroAvatarKey } from './Avatar';
import { StateInfobox } from './StateInfobox';

// ЛЕНТА ПЕРЕПИСКИ — экран режима «классический РП».
//
// Показывает то же самое, что уходит в контекст: state.history. Никакого второго
// хранилища у чата нет намеренно — иначе экран и промпт разъезжались бы после
// правки сообщения, свёртки памяти или загрузки сейва.
//
// Сообщения, свёрнутые в память, здесь не видны: они физически удалены из истории
// и живут в журнале эпизодов (Game Master → Память). Так и должно быть — лента
// показывает ровно то, что модель ещё помнит дословно.

interface Rendered {
  /** Проза для показа: без служебного блока, после правил-регэкспов. */
  text: string;
  /** Разобранная сводка мира этого хода — из неё рисуется инфобокс. */
  world?: WorldStateUpdate;
}

export function RpChat({ hasNotes, onOpenNotes }: { hasNotes: boolean; onOpenNotes: () => void }) {
  const s = usePlayerStore();
  const cfg = usePresetSettings((x) => x.settings);
  const scrollRef = useRef<HTMLDivElement>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [editText, setEditText] = useState('');

  const state = s.state;
  const project = s.project;
  const history = state?.history ?? [];
  const lastIndex = history.length - 1;
  const heroName = project && state ? protagonistName(project, state) : 'Герой';

  // Разбор всей ленты — заметная работа (регэкспы плюс JSON сводки на каждое
  // сообщение), поэтому считаем один раз на изменение истории, а не на каждый кадр
  // перерисовки: во время стриминга кадров десятки в секунду.
  const rendered: Rendered[] = useMemo(() => {
    return history.map((m) => {
      if (m.role === 'user') {
        return {
          text: applyRegexRules(stripMoveTag(m.content), cfg.regexRules, {
            role: 'user',
            scope: 'display',
          }),
        };
      }
      // guard: false — обрезать «письмо за игрока» на показе поздно и вредно: ход
      // уже применён, и текст на экране разошёлся бы с текстом в контексте.
      const rp = parseRpResponse(m.content, { guard: false });
      return {
        text: applyRegexRules(rp.prose, cfg.regexRules, { role: 'ai', scope: 'display' }),
        world: rp.worldState,
      };
    });
  }, [history, cfg.regexRules]);

  // Прокрутка вниз при новом сообщении и по мере набора текста. useLayoutEffect, а
  // не useEffect: иначе кадр между вёрсткой и прокруткой видно как рывок вверх.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [history.length, s.thinking, s.pendingMove, s.streamingText]);

  // Правка закрывается сама, если сообщение исчезло (свайп, свёртка, загрузка
  // сейва) — иначе открытая форма начала бы редактировать чужой текст под тем же
  // индексом.
  useEffect(() => {
    if (editing !== null && editing >= history.length) setEditing(null);
  }, [history.length, editing]);

  if (!project || !state) return null;

  const startEdit = (i: number, text: string) => {
    setEditing(i);
    setEditText(text);
  };
  const commitEdit = () => {
    if (editing === null) return;
    s.editHistoryMessage(editing, editText);
    setEditing(null);
  };

  // Аватарка героя грузится прямо из чата: это самое очевидное место, где о ней
  // вспоминают, и гонять игрока за ней в конструктор незачем.
  async function pickHeroAvatar(file: File) {
    const asset = await uploadAsset(file, 'icon');
    await s.patchProject((p) => {
      p.assets = [...p.assets, asset];
    });
    usePlayerStore.setState((st) =>
      st.state ? { state: { ...st.state, protagonistAvatarAssetId: asset.id } } : {}
    );
    void s.autosave();
  }

  const last = history[lastIndex];
  const swipeCount = last?.role === 'assistant' ? last.swipes?.length ?? 0 : 0;
  const swipeAt = last?.swipe ?? 0;

  return (
    <div className="absolute inset-0 pt-14 flex flex-col">
      <input
        ref={avatarInputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void pickHeroAvatar(f);
          e.target.value = '';
        }}
      />

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 sm:px-4 py-5">
        <div className="max-w-3xl mx-auto space-y-4">
          {history.length === 0 && !s.pendingMove && (
            <p className="text-center text-sm text-gray-500 py-10">
              История пустая. Напишите первую реплику — или нажмите ▶ в строке ввода, и мир начнёт сам.
            </p>
          )}

          {history.map((m, i) => {
            const mine = m.role === 'user';
            const r = rendered[i];
            const isLast = i === lastIndex;
            return (
              <Message
                key={i}
                mine={mine}
                who={mine ? heroName : 'Рассказчик'}
                text={r?.text ?? ''}
                avatar={
                  mine ? (
                    <Avatar
                      name={heroName}
                      blobKey={heroAvatarKey(project, state)}
                      title="Сменить аватарку героя"
                      onClick={() => avatarInputRef.current?.click()}
                    />
                  ) : (
                    <NarratorAvatar project={project} world={r?.world} />
                  )
                }
                infobox={
                  !mine && cfg.showStateInfobox && r?.world ? (
                    <StateInfobox project={project} state={r.world} />
                  ) : null
                }
                editing={editing === i}
                editText={editText}
                onEditText={setEditText}
                onStartEdit={() => startEdit(i, m.content)}
                onCommitEdit={commitEdit}
                onCancelEdit={() => setEditing(null)}
                onDelete={() => {
                  if (confirm('Удалить это сообщение из истории? Модель перестанет его помнить.'))
                    s.deleteHistoryMessage(i);
                }}
                // Варианты — только у последнего ответа: откат состояния движок
                // умеет ровно на один ход назад, для середины ленты снимка нет.
                swipes={!mine && isLast && !s.thinking ? { count: Math.max(1, swipeCount), at: swipeAt } : undefined}
                onSwipe={(dir) => {
                  if (dir === 1 && swipeAt >= swipeCount - 1) void s.addSwipe();
                  else void s.setSwipe(swipeAt + dir);
                }}
                onNewSwipe={!mine && isLast && !s.thinking ? () => void s.addSwipe() : undefined}
                busy={s.thinking}
              />
            );
          })}

          {/* Отправленный ход, пока идёт генерация: в историю он попадёт только
              вместе с ответом, а исчезать с экрана на полминуты ему нельзя. */}
          {s.pendingMove && s.thinking && (
            <Message
              mine
              who={heroName}
              text={stripMoveTag(s.pendingMove)}
              avatar={<Avatar name={heroName} blobKey={heroAvatarKey(project, state)} />}
              pending
              busy
            />
          )}

          {/* Ответ, который набирается прямо сейчас. */}
          {s.thinking && !!s.streamingText && (
            <Message
              mine={false}
              who="Рассказчик"
              text={applyRegexRules(s.streamingText, cfg.regexRules, { role: 'ai', scope: 'display' })}
              avatar={<NarratorAvatar project={project} />}
              streaming
              busy
            />
          )}

          {s.thinking && (
            <div className="flex items-center gap-2 text-sm text-gray-400 pl-1">
              <span className="inline-block w-3 h-3 border-2 border-[var(--pl-accent)] border-t-transparent rounded-full animate-spin" />
              <span>{s.streamingText ? 'печатает…' : 'думает…'}</span>
              <button
                className="ml-1 rounded-full bg-white/10 hover:bg-white/20 px-2.5 py-1 text-xs"
                onClick={() => s.cancel()}
              >
                ✕ Отменить
              </button>
            </div>
          )}
        </div>
      </div>

      <Console
        disabled={s.thinking}
        value={s.draft}
        onValueChange={(t) => s.setDraft(t)}
        canContinue={!s.thinking}
        onSubmit={(txt) => s.submitFreeInput(txt)}
        onContinue={() => s.continueStory()}
        hasNotes={hasNotes}
        onOpenNotes={onOpenNotes}
      />
    </div>
  );
}

// Лицо у ответа модели не одно: за ход говорят несколько персонажей. Показываем
// тех, кого модель назвала в сводке ЭТОГО хода, стопкой; сводки нет — нейтральный
// значок, а не случайно выбранный персонаж.
function NarratorAvatar({ project, world }: { project: Project; world?: WorldStateUpdate }) {
  const names = (world?.characters || []).map((c) => c.name).filter(Boolean).slice(0, 3);
  if (!names.length) {
    return (
      <div
        className="shrink-0 rounded-full flex items-center justify-center border border-white/15 bg-white/[0.05] text-sm"
        style={{ width: 34, height: 34 }}
        title="Рассказчик"
      >
        ✎
      </div>
    );
  }
  return (
    <div className="shrink-0 flex -space-x-2.5">
      {names.map((n) => (
        <Avatar key={n} name={n} blobKey={characterAvatarKey(project, n)} size={34} />
      ))}
    </div>
  );
}

function Message({
  mine,
  who,
  text,
  avatar,
  infobox,
  pending,
  streaming,
  busy,
  editing,
  editText,
  onEditText,
  onStartEdit,
  onCommitEdit,
  onCancelEdit,
  onDelete,
  swipes,
  onSwipe,
  onNewSwipe,
}: {
  mine: boolean;
  who: string;
  text: string;
  avatar?: React.ReactNode;
  infobox?: React.ReactNode;
  pending?: boolean;
  streaming?: boolean;
  busy?: boolean;
  editing?: boolean;
  editText?: string;
  onEditText?: (t: string) => void;
  onStartEdit?: () => void;
  onCommitEdit?: () => void;
  onCancelEdit?: () => void;
  onDelete?: () => void;
  swipes?: { count: number; at: number };
  onSwipe?: (dir: -1 | 1) => void;
  onNewSwipe?: () => void;
}) {
  return (
    <div className={`flex gap-2.5 ${pending ? 'opacity-60' : ''}`}>
      {avatar}
      <div
        className={`group flex-1 min-w-0 rounded-2xl px-4 py-3 border ${
          mine
            ? 'bg-[var(--pl-accent-soft)] border-[rgba(180,150,255,0.28)]'
            : 'bg-[var(--pl-bubble-bg)] border-[rgba(180,150,255,0.14)]'
        }`}
      >
        <div className="flex items-center gap-2 mb-1.5">
          {/* Не берём --pl-name: цвет имени темы рассчитан на светлую плашку в
              диалоговом окне новеллы и на тёмном пузыре чата почти не читается. */}
          <span
            className={`text-xs font-semibold tracking-wide ${mine ? '' : 'opacity-70'}`}
            style={{ color: mine ? 'var(--pl-accent-bright)' : 'var(--pl-text)' }}
          >
            {who}
          </span>

          {!pending && !streaming && (
            <div className="ml-auto flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
              {swipes && (
                <span className="flex items-center gap-0.5 mr-1">
                  <button
                    className="text-xs px-1.5 py-0.5 rounded hover:bg-white/10 disabled:opacity-30"
                    title="Предыдущий вариант"
                    disabled={swipes.at <= 0}
                    onClick={() => onSwipe?.(-1)}
                  >
                    ‹
                  </button>
                  <span className="text-[11px] text-gray-500 tabular-nums">
                    {swipes.at + 1}/{swipes.count}
                  </span>
                  <button
                    className="text-xs px-1.5 py-0.5 rounded hover:bg-white/10"
                    title={
                      swipes.at >= swipes.count - 1 ? 'Сгенерировать новый вариант' : 'Следующий вариант'
                    }
                    onClick={() => onSwipe?.(1)}
                  >
                    ›
                  </button>
                </span>
              )}
              {onNewSwipe && (
                <button
                  className="text-xs px-2 py-0.5 rounded hover:bg-white/10"
                  title="Ещё один вариант ответа"
                  onClick={onNewSwipe}
                >
                  ↻
                </button>
              )}
              {onStartEdit && !editing && (
                <button
                  className="text-xs px-2 py-0.5 rounded hover:bg-white/10"
                  title="Редактировать"
                  onClick={onStartEdit}
                >
                  ✎
                </button>
              )}
              {onDelete && !editing && (
                <button
                  className="text-xs px-2 py-0.5 rounded hover:bg-white/10 text-red-300"
                  title="Удалить сообщение"
                  onClick={onDelete}
                  disabled={busy}
                >
                  ✕
                </button>
              )}
            </div>
          )}
        </div>

        {editing ? (
          <div>
            {/* Правим СЫРОЙ текст сообщения — с технической пометкой хода и со
                служебной сводкой. Именно он уходит в контекст, и прятать его в
                редакторе значило бы молча стирать при сохранении. */}
            <textarea
              className="input w-full h-40 text-sm font-mono"
              value={editText ?? ''}
              onChange={(e) => onEditText?.(e.target.value)}
            />
            <div className="flex gap-2 justify-end mt-2">
              <button className="btn-ghost !py-1 !px-3 text-xs" onClick={onCancelEdit}>
                Отмена
              </button>
              <button className="btn-primary !py-1 !px-3 text-xs" onClick={onCommitEdit}>
                Сохранить
              </button>
            </div>
          </div>
        ) : (
          <>
            <Markdown
              text={text}
              className="block leading-relaxed whitespace-pre-wrap text-[color:var(--pl-text)]"
            />
            {streaming && (
              <span className="inline-block w-1.5 h-4 align-text-bottom ml-0.5 bg-[var(--pl-accent)] animate-pulse" />
            )}
            {infobox}
          </>
        )}
      </div>
    </div>
  );
}
