import { useRef, useState } from 'react';
import { Modal, Field } from '../../shared/ui';
import {
  defaultPreset,
  defaultBlockContent,
  parsePresetJson,
  type PromptPreset,
  type PromptBlock,
} from '../../ai/promptPreset';
import { usePresetSettings, type PresetSettings } from '../../ai/presetSettings';
import { defaultRpPreset, defaultRpBlockContent } from '../../ai/rpPreset';
import { PROMPT_PROCESSING_LABELS, type PromptProcessing } from '../../ai/promptPostProcess';
import { MACRO_HELP } from '../../ai/macros';
import { RegexRulesEditor } from './RegexRulesEditor';
import { usePlayerStore } from '../player/playerStore';
import { useAppMode } from '../../app/appMode';
import { TokenCounter } from '../player/components/TokenCounter';
import { uid } from '../../shared/utils';
import { downloadBlob } from '../../storage/zip';
import type { AdvancedPromptBlock, LlmRole } from '../../shared/types';
import { DEFAULT_TURN_LENGTH, TURN_LENGTH_BOUNDS, TURN_LENGTH_PRESETS, DEFAULT_THINKING_PLAN, normalizeNarrativeMode, type NarrativeMode } from '../../shared/types';

// Редактор пресета промпта (Batch 3 §8) — вынесен в отдельное окно верхней панели,
// отделён от настроек API. Каждый блок: порядок (drag&drop), роль system/user/assistant
// (как в Таверне), редактируемый заголовок и текст, вкл/выкл, сброс, добавление/удаление.
const ROLES: { id: LlmRole; label: string }[] = [
  { id: 'system', label: 'S' },
  { id: 'user', label: 'U' },
  { id: 'assistant', label: 'A' },
];

export function PresetPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [dragId, setDragId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // ГЛОБАЛЬНЫЙ пресет — один на все истории, доступен везде и всегда.
  const cfg = usePresetSettings((s) => s.settings);
  const patchStore = usePresetSettings((s) => s.patch);
  // Пресет ВСЕГДА показывается для текущего режима приложения — того самого, в
  // котором вы работаете. Раньше здесь была вкладка-переключатель, и она сбивала с
  // толку: можно было править пресет одного режима, играя в другом, и удивляться,
  // почему правки ни на что не влияют.
  const mode: NarrativeMode = useAppMode((s) => s.mode) ?? 'vn';
  if (!open) return null;

  const isRp = mode === 'rp';
  const preset = isRp ? cfg.rpPreset : cfg.preset;

  const patch = (p: Partial<PresetSettings>) => patchStore(p);
  const savePreset = (next: PromptPreset) => patchStore(isRp ? { rpPreset: next } : { preset: next });
  const patchBlock = (id: string, p: Partial<PromptBlock>) =>
    savePreset({ ...preset, blocks: preset.blocks.map((b) => (b.id === id ? { ...b, ...p } : b)) });
  const removeBlock = (id: string) =>
    savePreset({ ...preset, blocks: preset.blocks.filter((b) => b.id !== id) });
  const addBlock = () =>
    savePreset({
      ...preset,
      blocks: [...preset.blocks, { id: uid('blk'), name: 'Новый блок', enabled: true, content: '', role: 'system' }],
    });
  const resetBlock = (b: PromptBlock) => {
    if (!b.builtinKey) return;
    const content = isRp ? defaultRpBlockContent(b.builtinKey) : defaultBlockContent(b.builtinKey);
    if (content !== null) patchBlock(b.id, { content, enabled: true });
  };
  const resetPreset = () => {
    if (confirm('Вернуть весь пресет к OmayaEngine по умолчанию? Правки блоков будут потеряны.'))
      savePreset(isRp ? defaultRpPreset() : defaultPreset());
  };
  const reorder = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    const blocks = [...preset.blocks];
    const from = blocks.findIndex((b) => b.id === fromId);
    const to = blocks.findIndex((b) => b.id === toId);
    if (from === -1 || to === -1) return;
    const [moved] = blocks.splice(from, 1);
    blocks.splice(to, 0, moved);
    savePreset({ ...preset, blocks });
  };
  const exportPreset = () =>
    downloadBlob(
      new Blob([JSON.stringify(preset, null, 2)], { type: 'application/json' }),
      `${preset.name || 'preset'}.json`
    );
  const importPresetFile = async (file: File) => {
    try {
      const parsed = parsePresetJson(JSON.parse(await file.text()));
      if (!parsed) throw new Error('Невалидный файл пресета (нет массива blocks)');
      savePreset(parsed);
    } catch (e) {
      alert('Не удалось импортировать пресет: ' + (e as Error).message);
    }
  };
  const patchAdvBlocks = (blocks: AdvancedPromptBlock[]) => patch({ advancedBlocks: blocks });

  return (
    <Modal open={open} onClose={onClose} title="Пресет промпта" wide>
      {/* У каждого режима свой набор блоков: половина блоков новеллы (JSON-контракт,
          эмоции, музыка) в текстовом РП только мешает, а запрет писать за игрока
          новелле, наоборот, противопоказан. Показываем пресет текущего режима. */}
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <span className="chip !px-3 !py-1 text-xs bg-accent2 text-white">
          {isRp ? '💬 Классический РП' : '🎭 Визуальная новелла'}
        </span>
        <span className="text-xs text-gray-500">
          У второго режима свой пресет — он откроется здесь же, когда вы переключите режим
          значком в верхней панели.
        </span>
      </div>
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <input
          className="input !py-1 text-sm max-w-xs"
          value={preset.name}
          onChange={(e) => savePreset({ ...preset, name: e.target.value })}
        />
        <div className="flex gap-2 flex-wrap">
          <button className="btn-ghost !px-3 !py-1 text-xs" onClick={addBlock}>
            + Блок
          </button>
          <button className="btn-ghost !px-3 !py-1 text-xs" onClick={exportPreset}>
            Экспорт
          </button>
          <button className="btn-ghost !px-3 !py-1 text-xs" onClick={() => fileRef.current?.click()}>
            Импорт
          </button>
          <button className="btn-ghost !px-3 !py-1 text-xs" onClick={resetPreset}>
            По умолчанию
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) importPresetFile(f);
              e.target.value = '';
            }}
          />
        </div>
      </div>
      <p className="text-xs text-gray-500 mb-3">
        Порядок = порядок в промпте. Перетаскивайте за ⠿; роль{' '}
        <b>S</b>/<b>U</b>/<b>A</b> = system/user/assistant (как в Таверне).{' '}
        <span className="text-amber-400">↳ блоки</span> наполняет движок (мир, персонажи, память).
      </p>

      <div className="space-y-2">
        {preset.blocks.map((b) => (
          <div
            key={b.id}
            draggable
            onDragStart={() => setDragId(b.id)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => {
              if (dragId) reorder(dragId, b.id);
              setDragId(null);
            }}
            className={`rounded-lg border p-3 bg-panel2 ${
              b.flagged ? 'border-amber-500/40' : 'border-white/10'
            } ${dragId === b.id ? 'opacity-50' : ''}`}
          >
            <div className="flex items-center gap-2 flex-wrap">
              <span className="cursor-grab select-none text-gray-500" title="Перетащить">
                ⠿
              </span>
              <input
                type="checkbox"
                checked={b.enabled}
                onChange={(e) => patchBlock(b.id, { enabled: e.target.checked })}
                title="Вкл/выкл блок"
              />
              <input
                className="input !py-1 text-sm flex-1 min-w-[8rem]"
                value={b.name}
                onChange={(e) => patchBlock(b.id, { name: e.target.value })}
              />
              {/* Роль блока S/U/A */}
              <div className="inline-flex rounded-lg overflow-hidden border border-white/10 text-xs">
                {ROLES.map((r) => (
                  <button
                    key={r.id}
                    title={r.id}
                    className={`px-2 py-1 ${
                      (b.role || 'system') === r.id ? 'bg-accent2 text-white' : 'bg-panel hover:bg-white/10'
                    }`}
                    onClick={() => patchBlock(b.id, { role: r.id })}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
              {b.builtinKey && !b.dynamic && (
                <button
                  className="btn-ghost !px-2 !py-1 text-xs"
                  title="Вернуть текст блока к дефолту"
                  onClick={() => resetBlock(b)}
                >
                  ↺
                </button>
              )}
              {!b.builtinKey && !b.dynamic && (
                <button
                  className="btn-danger !px-2 !py-1 text-xs"
                  title="Удалить блок"
                  onClick={() => removeBlock(b.id)}
                >
                  ✕
                </button>
              )}
            </div>

            {b.flagged && (
              <p className="text-xs text-amber-400 mt-2">
                {isRp
                  ? '⚠ Этот блок кормит движок сводкой мира (часы, досье, память). Выключить можно — история продолжит идти, но Game Master перестанет обновляться сам.'
                  : '⚠ Этот блок обеспечивает работу движка (JSON-контракт). Менять можно, но при поломке формата парсер откатится на безопасный разбор.'}
              </p>
            )}

            {b.dynamic ? (
              <p className="text-xs text-gray-500 mt-2">
                Контент собирает движок из данных проекта (источник:{' '}
                <code className="text-gray-400">{b.dynamic}</code>). Редактируется порядок, роль и вкл/выкл.
              </p>
            ) : (
              b.enabled && (
                <textarea
                  className="input h-28 mt-2 text-sm font-mono"
                  value={b.content}
                  onChange={(e) => patchBlock(b.id, { content: e.target.value })}
                />
              )
            )}
          </div>
        ))}
      </div>

      {/* Префилл — отдельным блоком, чтобы был на виду */}
      <div className="card !bg-panel2 mt-4">
        <h4 className="font-semibold mb-1">Префилл ответа (prefill)</h4>
        <p className="text-xs text-gray-500 mb-2">
          Текст, которым НАЧИНАЕТСЯ ответ ассистента (добавляется как assistant-сообщение
          в конец). Стабилизирует формат — напр. <code>{isRp ? '*' : '{"scene":'}</code> — и часто
          используется как «затравка» для джейлбрейка. Пусто — не используется.
        </p>
        <textarea
          className="input h-20 font-mono text-sm"
          value={cfg.prefill || ''}
          placeholder={isRp ? '*' : '{"scene":'}
          onChange={(e) => patch({ prefill: e.target.value || undefined })}
        />
      </div>

      {/* Совместимость со шлюзом: метод обработки промпта + защита от письма за игрока */}
      <div className="card !bg-panel2 mt-4">
        <h4 className="font-semibold mb-1">Обработка промпта</h4>
        <p className="text-xs text-gray-500 mb-2">
          Как собранный запрос приводится к форме, которую принимает ваш шлюз. Меняйте, только
          если провайдер отвечает ошибкой формата: почти всем подходит «Склейка ролей», а Claude
          и Gemini напрямую иногда требуют «Строгую».
        </p>
        <select
          className="input !py-1"
          value={cfg.promptProcessing}
          onChange={(e) => patch({ promptProcessing: e.target.value as PromptProcessing })}
        >
          {PROMPT_PROCESSING_LABELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <p className="text-[11px] text-gray-500 mt-1">
          {PROMPT_PROCESSING_LABELS.find((m) => m.id === cfg.promptProcessing)?.hint}
        </p>

        {isRp && (
          <label className="flex items-start gap-2 mt-3 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={cfg.showStateInfobox}
              onChange={(e) => patch({ showStateInfobox: e.target.checked })}
            />
            <span>
              Показывать инфобокс состояния под ответом
              <span className="block text-[11px] text-gray-500">
                Часы, место, кто в сцене и что с ними — из служебной сводки, которую модель
                дописывает в конец ответа. Выключите блок «🗂 Служебная сводка состояния» выше —
                показывать станет нечего.
              </span>
            </span>
          </label>
        )}

        {isRp && (
          <label className="flex items-start gap-2 mt-3 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={cfg.impersonationGuard}
              onChange={(e) => patch({ impersonationGuard: e.target.checked })}
            />
            <span>
              Не давать модели писать за героя
              <span className="block text-[11px] text-gray-500">
                Стоп-строка на реплику героя плюс срез хвоста, если модель всё же начала за него
                говорить. Промпт один это не держит — блок «🚫 Не писать за игрока» и эта галочка
                работают вместе.
              </span>
            </span>
          </label>
        )}
      </div>

      <RegexRulesEditor rules={cfg.regexRules} onChange={(next) => patch({ regexRules: next })} />

      {/* Справка по макросам — рядом с блоками, где их и пишут */}
      <details className="card !bg-panel2 mt-4">
        <summary className="font-semibold cursor-pointer">Макросы</summary>
        <p className="text-xs text-gray-500 mt-2 mb-2">
          Работают в блоках пресета, в лорбуке, в описаниях мира и персонажей. Имена совпадают
          с Таверной там, где смысл тот же. Свои макросы задаются в проекте.
        </p>
        <div className="grid sm:grid-cols-2 gap-x-4 gap-y-1 text-xs">
          {MACRO_HELP.map((m) => (
            <div key={m.name} className="flex gap-2">
              <code className="text-accent2 whitespace-nowrap">{m.name}</code>
              <span className="text-gray-500">— {m.what}</span>
            </div>
          ))}
        </div>
      </details>

      {/* Параметры генерации */}
      <div className="card !bg-panel2 mt-4">
        <div className="flex items-center justify-between mb-3">
          <h4 className="font-semibold">Параметры генерации</h4>
          <ContextSizeBadge />
        </div>
        <div className="grid sm:grid-cols-2 gap-3">
          <TurnLengthField cfg={cfg} patch={patch} />
          {/* Выборов в текстовом РП нет вовсе — настраивать их частоту незачем. */}
          {!isRp && <ChoiceFrequencyField cfg={cfg} patch={patch} />}
          <div className="sm:col-span-2">
            <label className="label">Глубина размышления модели (reasoning)</label>
            <select
              className="input !py-1"
              value={cfg.reasoningEffort ?? ''}
              onChange={(e) =>
                patch({ reasoningEffort: (e.target.value || undefined) as PresetSettings['reasoningEffort'] })
              }
            >
              <option value="">Авто (как у провайдера)</option>
              <option value="none">Выкл — быстрее всего</option>
              <option value="low">Низкая — быстро</option>
              <option value="medium">Средняя</option>
              <option value="high">Высокая — вдумчиво, медленно</option>
            </select>
            <p className="text-xs text-gray-500 mt-1">
              Для «думающих» моделей (Gemini 3 Pro, o-серия): меньше — заметно быстрее ответ. Именно
              скрытое «размышление» даёт задержку в десятки секунд. «Авто» = как у провайдера (у
              thinking-моделей это медленно). Если провайдер не понимает параметр — оставьте «Авто».
            </p>
          </div>
          <GuidedThinkingField cfg={cfg} patch={patch} />
          <Field label="Язык повествования (язык текста истории, не интерфейса)">
            <div className="flex gap-2">
              {(['ru', 'en'] as const).map((lg) => (
                <button
                  key={lg}
                  className={`chip !px-3 !py-1.5 ${cfg.narrativeLanguage === lg ? 'bg-accent2 text-white' : ''}`}
                  onClick={() => patch({ narrativeLanguage: lg })}
                >
                  {lg === 'ru' ? 'Русский' : 'English'}
                </button>
              ))}
            </div>
          </Field>
          <Field label={`Температура: ${cfg.temperature.toFixed(2)}`}>
            <input
              type="range"
              min={0}
              max={1.5}
              step={0.05}
              className="w-full"
              value={cfg.temperature}
              onChange={(e) => patch({ temperature: Number(e.target.value) })}
            />
          </Field>
          <Field label={`Живое окно: ${cfg.liveWindow} ходов дословно после свёртки`}>
            <input
              type="range"
              min={4}
              max={30}
              step={1}
              className="w-full"
              value={cfg.liveWindow}
              onChange={(e) => patch({ liveWindow: Number(e.target.value) })}
            />
          </Field>
          <Field label={`Бюджет контекста: ${cfg.contextBudget} ток. (жёсткий потолок запроса)`}>
            <input
              type="range"
              min={4000}
              max={200000}
              step={2000}
              className="w-full"
              value={cfg.contextBudget}
              onChange={(e) => patch({ contextBudget: Number(e.target.value) })}
            />
            <p className="text-[11px] text-gray-500 mt-1">
              Он же задаёт, сколько истории живёт дословно: как только живая история перестаёт
              помещаться в свободное место бюджета, память сворачивается в журнал эпизодов — раньше,
              чем хоть один ход выпадет из контекста. «Живое окно» выше — сколько ходов остаётся
              сразу после свёртки; между свёртками их копится больше, насколько хватит бюджета.
            </p>
            <div className="flex gap-2 mt-2 flex-wrap">
              {BUDGET_PRESETS.map((b) => (
                <button
                  key={b.value}
                  className={`chip !px-3 !py-1.5 text-xs ${cfg.contextBudget === b.value ? 'bg-accent2 text-white' : ''}`}
                  onClick={() => patch({ contextBudget: b.value })}
                  title={b.hint}
                >
                  {b.name}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-gray-500 mt-2">
              {BUDGET_PRESETS.map((b) => `${b.name} (${b.value / 1000}k) — ${b.hint}`).join(' · ')}
            </p>
            <p className="text-[11px] text-gray-500 mt-1">
              <b>Почему первые ходов сорок игра отвечает быстрее.</b> Ничего не ломается: запрос
              растёт вместе с историей, пока не упрётся в этот потолок, и дальше держится ровно.
              Замер на типичном проекте: ход 5 — 18 тыс. токенов, ход 30 — 61 тыс., ход 45 — 80 тыс.,
              и с этого места до трёхсотого хода те же 79 тыс. Ждать приходится примерно во столько
              же раз дольше, во сколько вырос запрос. Хотите одинаковое время с самой первой сцены —
              ставьте бюджет ниже: он упрётся в потолок сразу.
            </p>
            <p className="text-[11px] text-gray-500 mt-1">
              Дефолт 80 000 — это запрос примерно на 45–80 тыс. токенов, то есть нужна модель со
              128k контекста (Gemini, Claude, GPT-4o и новее). Если провайдер отвечает «не
              помещается в контекст» — снизьте бюджет. Выше ~120 000 прибавка почти незаметна.
            </p>
          </Field>
        </div>
      </div>

      {/* Кастомные вставки по глубине */}
      <div className="card !bg-panel2 mt-4">
        <div className="flex items-center justify-between mb-2">
          <h4 className="font-semibold">Кастомные вставки (по глубине)</h4>
          <button
            className="btn-ghost !px-3 !py-1 text-xs"
            onClick={() => patchAdvBlocks([...(cfg.advancedBlocks || []), { content: '', depth: 1 }])}
          >
            + Вставка
          </button>
        </div>
        <p className="text-xs text-gray-500 mb-2">
          Вставляются в историю сообщений. Глубина = сколько сообщений от конца (0 — в самый конец).
        </p>
        {(cfg.advancedBlocks || []).map((b, i) => (
          <div key={i} className="flex gap-2 mb-2">
            <textarea
              className="input h-16 flex-1"
              value={b.content}
              placeholder="Текст вставки (макросы поддерживаются)"
              onChange={(e) => {
                const next = [...(cfg.advancedBlocks || [])];
                next[i] = { ...next[i], content: e.target.value };
                patchAdvBlocks(next);
              }}
            />
            <div className="w-20">
              <label className="label">Глубина</label>
              <input
                type="number"
                min={0}
                className="input"
                value={b.depth}
                onChange={(e) => {
                  const next = [...(cfg.advancedBlocks || [])];
                  next[i] = { ...next[i], depth: Number(e.target.value) };
                  patchAdvBlocks(next);
                }}
              />
              <button
                className="btn-danger !px-2 !py-1 text-xs mt-1 w-full"
                onClick={() => patchAdvBlocks((cfg.advancedBlocks || []).filter((_, j) => j !== i))}
              >
                Удалить
              </button>
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

// Счётчик размера контекста (перенесён из плеера сюда). Считает по текущей игре,
// если она открыта; иначе — подсказка. Порог = бюджет контекста из пресета.
function ContextSizeBadge() {
  const project = usePlayerStore((s) => s.project);
  const state = usePlayerStore((s) => s.state);
  if (!project || !state) {
    return <span className="text-[11px] text-gray-500">размер контекста — виден в игре</span>;
  }
  return <TokenCounter project={project} state={state} />;
}

// Быстрые пресеты бюджета контекста. Числа не на глаз: замер на смоделированном
// проекте (60 персонажей в картотеке, событие на ход, переписка) на ходу 150.
// «Дословно» — сколько последних ходов уходит в запрос целиком; всё, что старше,
// живёт в журнале эпизодов и снапшоте.
const BUDGET_PRESETS = [
  { value: 40000, name: 'Быстро', hint: 'запрос вдвое меньше дефолта, дословно ~12 последних ходов' },
  { value: 60000, name: 'Поровну', hint: 'три четверти дефолта, дословно ~25 ходов' },
  { value: 80000, name: 'Глубоко', hint: 'дефолт, дословно ~37 ходов' },
];

// Управляемое размышление: заменяет медленную родную «думалку» модели коротким
// планом в <thinking> через префилл. Родной reasoning при этом форсится в none.
function GuidedThinkingField({
  cfg,
  patch,
}: {
  cfg: PresetSettings;
  patch: (p: Partial<PresetSettings>) => void;
}) {
  const on = !!cfg.guidedThinking;
  return (
    <div className="sm:col-span-2 rounded-lg border border-white/10 p-3">
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => patch({ guidedThinking: e.target.checked || undefined })}
        />
        <span className="font-medium text-sm">Управляемое размышление (свой короткий план)</span>
      </label>
      <p className="text-xs text-gray-500 mt-1">
        Вместо медленной родной «думалки» модель пишет короткий план в тегах{' '}
        <code>&lt;thinking&gt;</code> (через префилл), затем сразу ответ. Обычно это заметно быстрее
        «думающих» моделей. Родной reasoning при этом принудительно выключается.
      </p>
      {on && (
        <>
          <textarea
            className="input h-40 mt-2 text-sm font-mono"
            value={cfg.thinkingPlan ?? DEFAULT_THINKING_PLAN}
            onChange={(e) => patch({ thinkingPlan: e.target.value })}
          />
          <p className="text-xs text-gray-500 mt-1">
            Каждая строка плана оплачивается на <b>каждом</b> ходу — и деньгами, и ожиданием.
            Поэтому список закрытый: добавляйте пункт слиянием с соседним, а не сверху. План на
            пятнадцать пунктов — это уже та самая медленная «думалка», от которой мы уходим.
          </p>
          <p className="text-xs text-gray-500 mt-1">
            Что модель по нему надумала — видно в{' '}
            <b>логах</b> (значок на верхней панели), запись «План хода N»: нажмите на неё, чтобы
            развернуть. Так план можно править не вслепую.
          </p>
          <button
            className="btn-ghost !px-3 !py-1 text-xs mt-2"
            onClick={() => patch({ thinkingPlan: DEFAULT_THINKING_PLAN })}
            disabled={(cfg.thinkingPlan ?? DEFAULT_THINKING_PLAN) === DEFAULT_THINKING_PLAN}
          >
            Вернуть стандартный план
          </button>
        </>
      )}
    </div>
  );
}

// Частота выборов: минимальный интервал в ходах между показами выбора. 0 (дефолт) =
// выборы КАЖДЫЙ ход — движок гарантирует их сам, даже если ИИ прислал пустой список.
// N > 0 — осознанное прореживание: лишние выборы движок глушит, значение уходит в промпт.
function ChoiceFrequencyField({
  cfg,
  patch,
}: {
  cfg: PresetSettings;
  patch: (p: Partial<PresetSettings>) => void;
}) {
  const gap = cfg.choiceMinGap ?? 0;
  const plural = (n: number) =>
    n % 10 === 1 && n % 100 !== 11 ? 'ход' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'хода' : 'ходов';
  const label = gap === 0 ? 'каждый ход (гарантировано)' : `не чаще раза в ${gap} ${plural(gap)}`;
  const set = (n: number) => {
    const v = Math.max(0, Math.min(20, Math.round(Number.isFinite(n) ? n : 0)));
    patch({ choiceMinGap: v || undefined });
  };
  return (
    <div className="sm:col-span-2">
      <label className="label">Частота выборов: {label}</label>
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={0}
          max={10}
          step={1}
          className="flex-1"
          value={Math.min(gap, 10)}
          onChange={(e) => set(Number(e.target.value))}
        />
        <input
          type="number"
          min={0}
          max={20}
          className="input !py-1 w-20"
          value={gap}
          onChange={(e) => set(Number(e.target.value))}
        />
      </div>
      <p className="text-xs text-gray-500 mt-1">
        0 — каждый ход заканчивается выборами (если ИИ их не прислал, движок подставит
        нейтральные). N — не чаще одного раза в N ходов (лишние выборы движок убирает сам).
      </p>
    </div>
  );
}

// Длина хода: диапазон в СЛОВАХ (min..max) — двумя ползунками и вводом чисел.
// Значение переопределяет числа в тексте блоков и уходит в промпт как авторитетное.
function TurnLengthField({
  cfg,
  patch,
}: {
  cfg: PresetSettings;
  patch: (p: Partial<PresetSettings>) => void;
}) {
  const tl = cfg.turnLength || DEFAULT_TURN_LENGTH;
  const B = TURN_LENGTH_BOUNDS;
  const clampW = (n: number) =>
    Math.min(Math.max(Math.round(Number.isFinite(n) ? n : 0), B.min), B.max);
  const setMin = (n: number) => patch({ turnLength: { min: Math.min(clampW(n), tl.max), max: tl.max } });
  const setMax = (n: number) => patch({ turnLength: { min: tl.min, max: Math.max(clampW(n), tl.min) } });
  return (
    <div className="sm:col-span-2">
      <label className="label">Длина хода (слов истории за ход): {tl.min}–{tl.max}</label>
      {/* Пресеты размера. Ползунки ниже никуда не делись — просто «сколько слов»
          проще выбрать примером, чем числом. */}
      <div className="flex gap-1.5 flex-wrap mb-2">
        {TURN_LENGTH_PRESETS.map((pr) => (
          <button
            key={pr.id}
            title={pr.hint}
            className={`chip !px-2.5 !py-1 text-xs ${
              tl.min === pr.min && tl.max === pr.max ? 'bg-accent2 text-white' : ''
            }`}
            onClick={() => patch({ turnLength: { min: pr.min, max: pr.max } })}
          >
            {pr.name}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2 mb-2">
        <input
          type="number"
          className="input !py-1 w-24"
          min={B.min}
          max={B.max}
          step={50}
          value={tl.min}
          onChange={(e) => setMin(Number(e.target.value))}
        />
        <span className="text-gray-500">—</span>
        <input
          type="number"
          className="input !py-1 w-24"
          min={B.min}
          max={B.max}
          step={50}
          value={tl.max}
          onChange={(e) => setMax(Number(e.target.value))}
        />
        <span className="text-xs text-gray-500">слов</span>
      </div>
      <div className="space-y-1">
        <input
          type="range"
          className="w-full"
          min={B.min}
          max={B.max}
          step={50}
          value={tl.min}
          onChange={(e) => setMin(Number(e.target.value))}
        />
        <input
          type="range"
          className="w-full"
          min={B.min}
          max={B.max}
          step={50}
          value={tl.max}
          onChange={(e) => setMax(Number(e.target.value))}
        />
      </div>
      <p className="text-xs text-gray-500 mt-1">
        Ориентир объёма истории за один ход — нижняя и верхняя граница. Меньше — быстрее ответ; больше —
        длиннее сцены между действиями.
      </p>
    </div>
  );
}
