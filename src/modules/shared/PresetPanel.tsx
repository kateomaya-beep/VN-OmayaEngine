import { useRef, useState } from 'react';
import { Modal, Field } from '../../shared/ui';
import {
  defaultPreset,
  defaultBlockContent,
  parsePresetJson,
  type PromptPreset,
  type PromptBlock,
} from '../../ai/promptPreset';
import { usePresetSettings, MODEL_PROFILES, type PresetSettings, type ModelProfile } from '../../ai/presetSettings';
import { defaultRpPreset, defaultRpBlockContent } from '../../ai/rpPreset';
import { defaultLocalPreset, defaultLocalBlockContent } from '../../ai/localPreset';
import {
  defaultDeepseekPreset,
  defaultDeepseekBlockContent,
  DEEPSEEK_THINKING_PLAN,
} from '../../ai/deepseekPreset';
import { PROMPT_PROCESSING_LABELS, type PromptProcessing } from '../../ai/promptPostProcess';
import { MACRO_HELP } from '../../ai/macros';
import { RegexRulesEditor } from './RegexRulesEditor';
import { usePlayerStore } from '../player/playerStore';
import { useAppMode } from '../../app/appMode';
import { TokenCounter } from '../player/components/TokenCounter';
import { uid } from '../../shared/utils';
import { downloadBlob } from '../../storage/zip';
import type { AdvancedPromptBlock, LlmRole } from '../../shared/types';
import { DEFAULT_TURN_LENGTH, TURN_LENGTH_BOUNDS, TURN_LENGTH_PRESETS, DEFAULT_THINKING_PLAN, DEFAULT_RP_THINKING_PLAN, DEFAULT_BAN_WORDS, normalizeNarrativeMode, type NarrativeMode } from '../../shared/types';

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
  const setModelProfile = usePresetSettings((s) => s.setModelProfile);
  // Пресет ВСЕГДА показывается для текущего режима приложения — того самого, в
  // котором вы работаете. Раньше здесь была вкладка-переключатель, и она сбивала с
  // толку: можно было править пресет одного режима, играя в другом, и удивляться,
  // почему правки ни на что не влияют.
  const mode: NarrativeMode = useAppMode((s) => s.mode) ?? 'vn';
  if (!open) return null;

  const isRp = mode === 'rp';
  // Локальный режим подменяет пресет РП компактным — и панель должна править
  // ИМЕННО ЕГО. Иначе получилось бы худшее из возможного: пользователь правит
  // блоки, а в запрос уходят другие, и правки «не работают».
  const prof = cfg.modelProfile;
  const isLocal = prof === 'local' && isRp;
  const isDs = prof === 'deepseek' && isRp;
  const preset = isLocal ? cfg.localPreset : isDs ? cfg.deepseekPreset : isRp ? cfg.rpPreset : cfg.preset;

  const patch = (p: Partial<PresetSettings>) => patchStore(p);
  const savePreset = (next: PromptPreset) =>
    patchStore(
      isLocal ? { localPreset: next } : isDs ? { deepseekPreset: next } : isRp ? { rpPreset: next } : { preset: next }
    );
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
    const content = isLocal
      ? defaultLocalBlockContent(b.builtinKey)
      : isDs
        ? defaultDeepseekBlockContent(b.builtinKey)
        : isRp
        ? defaultRpBlockContent(b.builtinKey)
        : defaultBlockContent(b.builtinKey);
    if (content !== null) patchBlock(b.id, { content, enabled: true });
  };
  const resetPreset = () => {
    if (confirm('Вернуть весь пресет к OmayaEngine по умолчанию? Правки блоков будут потеряны.'))
      savePreset(
        isLocal
          ? defaultLocalPreset()
          : isDs
            ? defaultDeepseekPreset()
            : isRp
              ? defaultRpPreset()
              : defaultPreset()
      );
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
        {prof !== 'universal' && (
          <span className="chip !px-3 !py-1 text-xs bg-emerald-500/20 border border-emerald-400/40 text-emerald-200">
            {isLocal ? '🖥 Локальная модель' : '🐋 DeepSeek'}
          </span>
        )}
        <span className="text-xs text-gray-500">
          У второго режима свой пресет — он откроется здесь же, когда вы переключите режим
          значком в верхней панели.
        </span>
      </div>

      {/* ПРОФИЛЬ МОДЕЛИ. Универсальный пресет — компромисс: модели ломаются
          по-разному, и лечится это тоже по-разному. */}
      <div className="card !bg-panel2 !p-3 mb-3">
        <label className="label">На какой модели играете</label>
        <select
          className="input !py-1"
          value={prof}
          onChange={(e) => setModelProfile(e.target.value as ModelProfile)}
        >
          {MODEL_PROFILES.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <p className="text-[11px] text-gray-500 mt-1.5">
          {MODEL_PROFILES.find((p) => p.id === prof)?.hint}
        </p>
        <p className="text-[11px] text-gray-500 mt-1">
          Профиль ПОДСТАВЛЯЕТ значения, а не запирает их: всё ниже остаётся вашим и правится как
          обычно. Возврат на «Универсальный» вернёт то, что было настроено до смены профиля.
        </p>

        {isDs && (
          <div className="mt-2.5 rounded-lg border border-emerald-400/25 bg-emerald-500/[0.07] px-3 py-2">
            <div className="text-[11px] font-semibold text-emerald-300 mb-1">Что подставлено под DeepSeek:</div>
            <ul className="text-[11px] text-gray-300 space-y-0.5">
              <li>
                • <b>родная думалка выключена</b> — и это главное: пока она включена, у DeepSeek V4
                температура и штрафы за повтор принимаются молча и не действуют вовсе
              </li>
              <li>• температура {cfg.temperature} — базовая рекомендация DeepSeek для V4 Pro</li>
              <li>
                • штрафы за повтор: частота {cfg.frequencyPenalty}, присутствие {cfg.presencePenalty}.
                Частота намеренно почти нулевая — на больших значениях модель к концу хода
                перестаёт ставить точки и запятые
              </li>
              <li>• разбор своего прошлого ответа в думалке: модель обязана назвать фразы, которые уже использовала, и запретить их себе</li>
              <li>• три блока в пресете: анти-эхо, анти-повторы, против шаблона сцены (правятся ниже)</li>
            </ul>
          </div>
        )}

        {isLocal && (
          <div className="mt-2.5 rounded-lg border border-emerald-400/25 bg-emerald-500/[0.07] px-3 py-2">
            <div className="text-[11px] font-semibold text-emerald-300 mb-1">Что подставлено:</div>
            <ul className="text-[11px] text-gray-300 space-y-0.5">
              <li>
                • <b>бюджет контекста {cfg.contextBudget}</b> — поставьте СТОЛЬКО ЖЕ, сколько выделили
                модели при загрузке (в LM Studio поле рядом с моделью). Угадать за вас нельзя.
              </li>
              <li>• ход {cfg.turnLength.min}–{cfg.turnLength.max} слов, живое окно {cfg.liveWindow}</li>
              <li>• без думалки, без префилла, без сводки состояния</li>
              <li>• компактный пресет: 4 блока вместо тринадцати</li>
            </ul>
          </div>
        )}
        {prof !== 'universal' && !isRp && (
          <p className="text-[11px] text-amber-300 mt-2">
            В новелле пресет НЕ подменяется: он держится на JSON-контракте, выкинуть его нельзя.
            Профиль здесь влияет только на параметры генерации.
          </p>
        )}
      </div>

      {/* БЛОКИ ПРЕСЕТА. Ради них панель и существует: имя пресета, экспорт/импорт,
          список блоков с галочкой, ролью, порядком и текстом. Однажды эта секция
          была снесена целиком — не намеренно, а правкой соседней карточки, которая
          захватила лишнего; хелперы (addBlock, reorder, resetBlock и прочие) остались
          на месте, поэтому ничего не сломалось и не заругалось, панель просто молча
          лишилась главного. Держим её сразу под выбором профиля: профиль решает,
          КАКОЙ пресет правится, и этот ответ должен быть на виду. */}
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
        Порядок = порядок в промпте. Перетаскивайте за ⠿; роль <b>S</b>/<b>U</b>/<b>A</b> =
        system/user/assistant (как в Таверне).{' '}
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
                      (b.role || 'system') === r.id
                        ? 'bg-accent2 text-white'
                        : 'bg-panel hover:bg-white/10'
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
                <code className="text-gray-400">{b.dynamic}</code>). Редактируется порядок, роль и
                вкл/выкл.
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
        {isRp && !!cfg.prefill && (
          <>
            <label className="flex items-start gap-2 mt-3 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={cfg.hidePrefill}
                onChange={(e) => patch({ hidePrefill: e.target.checked })}
              />
              <span>
                Прятать префилл в ответе
                <span className="block text-[11px] text-gray-500">
                  Префилл — ваши слова, вписанные в уста модели, и в ленте «затравка» выглядит
                  инородно. Снимите галочку, если префилл ОТКРЫВАЕТ разметку (одинокая «*» под
                  курсив): спрятав его, вы оставите её незакрытой. В контексте модели префилл
                  остаётся в любом случае — прячется только показ.
                </span>
              </span>
            </label>
          </>
        )}
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
        <p className="text-[11px] text-gray-500 mt-1">
          Для семейства GLM (z-ai) в РП обычно советуют «Полустрогую» — это то же, что
          «Semi-strict (alternating roles)» в Таверне: на ней китайские шлюзы стабильнее держат
          инструкции.
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
              checked={cfg.streamingEnabled}
              onChange={(e) => patch({ streamingEnabled: e.target.checked })}
            />
            <span>
              Стриминг ответа
              <span className="block text-[11px] text-gray-500">
                Текст появляется по мере генерации, а не целиком в конце. Выключите, если конкретный
                шлюз на потоке ведёт себя хуже (чаще рвётся, режет ответ) — тогда ход придёт обычным
                запросом, как в новелле.
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
                Срез хвоста ответа, если модель всё же начала говорить за него. Промпт один это не
                держит — блок «🚫 Не писать за игрока» и эта галочка работают вместе. Обрыв ответа
                на провайдере намеренно не используется — он необратим, если сработает по ложному
                поводу.
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
              <option value="max">Максимальная — очень медленно</option>
            </select>
            <p className="text-xs text-gray-500 mt-1">
              Для «думающих» моделей (Gemini 3 Pro, o-серия): меньше — заметно быстрее ответ. Именно
              скрытое «размышление» даёт задержку в десятки секунд. «Авто» = как у провайдера (у
              thinking-моделей это медленно). Если провайдер не понимает параметр — оставьте «Авто».
            </p>
            <p className="text-xs text-amber-300/80 mt-1">
              Модели, которые думают ВСЕГДА (GLM-5.3 и подобные), «Выкл» и «Средняя» не принимают —
              там допустимы только низкая / высокая / максимальная. Движок это распознаёт по отказу
              и сам переключает такую модель на «низкую», но выбрать её сразу — на один запрос быстрее.
              «Авто» на них означает МАКСИМАЛЬНУЮ глубину: ответ идёт очень долго, а на большом
              контексте шлюз успевает отвалиться по таймауту (502/504).
            </p>
          </div>
          <GuidedThinkingField cfg={cfg} patch={patch} isRp={isRp} />
          <BanWordsField cfg={cfg} patch={patch} />
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

          {/* ШТРАФЫ ЗА ПОВТОР — рядом с температурой и на ЛЮБОМ профиле: заедание
              фраз бывает не только у DeepSeek, а лечится это одними и теми же
              ручками. «—» значит «не шлём вовсе»: у части шлюзов явный ноль и
              отсутствие параметра — не одно и то же. */}
          <PenaltyField
            label="Штраф за частоту"
            value={cfg.frequencyPenalty}
            onChange={(frequencyPenalty) => patch({ frequencyPenalty })}
            hint="Растёт с числом повторов токена. ОСТОРОЖНО: точки и запятые повторяются чаще всего, и на больших значениях к концу длинного хода модель перестаёт их ставить. Выше 0.3 не поднимайте без нужды."
          />
          <PenaltyField
            label="Штраф за присутствие"
            value={cfg.presencePenalty}
            onChange={(presencePenalty) => patch({ presencePenalty })}
            hint="Ровный штраф за уже использованное слово, без накопления. Против заезженных формулировок безопаснее предыдущего — знаки препинания от него не страдают."
          />
          <PenaltyField
            label="top_p (ядерная выборка)"
            value={cfg.topP}
            min={0}
            max={1}
            step={0.05}
            onChange={(topP) => patch({ topP })}
            hint="Крутить ВМЕСТЕ с температурой не стоит: оба режут один и тот же хвост распределения. Меняйте что-то одно."
          />
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
            <div className="w-28">
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
              {/* Режим: блок, написанный под новеллу (биты, спрайты, выборы), в
                  текстовом РП тянет ответ обратно к формату новеллы — и наоборот.
                  Пусто = в обоих, как вели себя все блоки до появления режимов. */}
              <label className="label mt-1">Режим</label>
              <select
                className="input !py-1 text-xs"
                value={b.mode ?? ''}
                onChange={(e) => {
                  const next = [...(cfg.advancedBlocks || [])];
                  const v = e.target.value;
                  next[i] = { ...next[i], mode: v === 'vn' || v === 'rp' ? v : undefined };
                  patchAdvBlocks(next);
                }}
              >
                <option value="">оба</option>
                <option value="vn">🎭 новелла</option>
                <option value="rp">💬 РП</option>
              </select>
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
  isRp,
}: {
  cfg: PresetSettings;
  patch: (p: Partial<PresetSettings>) => void;
  /** План размышления один на все режимы (глобальная настройка), но дефолт и кнопка
   * сброса должны предлагать вариант БЕЗ пункта про выбор — его в РП не существует. */
  isRp: boolean;
}) {
  const on = !!cfg.guidedThinking;
  // Дефолт совпадает с тем, что реально уйдёт в запрос (см. promptBuilder): в РП
  // под профилем DeepSeek это его собственный чек-лист, а не общий.
  const modeDefault = !isRp
    ? DEFAULT_THINKING_PLAN
    : cfg.modelProfile === 'deepseek'
      ? DEEPSEEK_THINKING_PLAN
      : DEFAULT_RP_THINKING_PLAN;
  return (
    <div className="sm:col-span-2 rounded-lg border border-white/10 p-3">
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => patch({ guidedThinking: e.target.checked || undefined })}
        />
        <span className="font-medium text-sm">Управляемое размышление (разбор хода по шагам)</span>
      </label>
      <p className="text-xs text-gray-500 mt-1">
        Перед ответом модель проходит чек-лист в тегах <code>&lt;thinking&gt;</code> (через префилл),
        затем сразу пишет сцену. Родной reasoning при этом принудительно выключается — обычно так
        заметно быстрее «думающих» моделей. У тех, у кого думалку выключить нельзя (GLM-5.x, Kimi,
        R1), тегов и префилла не будет: тот же чек-лист уедет к ним как <b>SELF-CHECK</b> и
        пройдётся в их собственном размышлении.
      </p>
      {on && (
        <>
          <textarea
            className="input h-40 mt-2 text-sm font-mono"
            value={cfg.thinkingPlan ?? modeDefault}
            onChange={(e) => patch({ thinkingPlan: e.target.value })}
          />
          <p className="text-xs text-gray-500 mt-1">
            Это не «план сцены», а <b>разбор по шагам</b>: половина пунктов — проверки против
            конкретных поломок (кто что может знать, эхо хода игрока, заеденные фразы, стоп-слова,
            формат). Правила в пресете модель читает и всё равно нарушает — изнутри генерации она
            этих промахов не видит. Помогает только заставить её выписать проверку явно: выписанное
            «Марк не знает про письмо» меняет ход, прочитанное «соблюдай гигиену» — нет.
          </p>
          <p className="text-xs text-gray-500 mt-1">
            Плата за это честная: каждая строка идёт в запрос и в ответ на <b>каждом</b> ходу.
            Если стало заметно медленно — режьте с конца списка, а не с начала: первые пункты
            (обстановка, кто что знает) окупаются, последние — страховка.
          </p>
          <p className="text-xs text-gray-500 mt-1">
            Что модель по нему надумала — видно в{' '}
            <b>логах</b> (значок на верхней панели), запись «План хода N»: нажмите на неё, чтобы
            развернуть. Так план можно править не вслепую.
          </p>
          <button
            className="btn-ghost !px-3 !py-1 text-xs mt-2"
            onClick={() => patch({ thinkingPlan: modeDefault })}
            disabled={(cfg.thinkingPlan ?? modeDefault) === modeDefault}
          >
            Вернуть стандартный план
          </button>
        </>
      )}
    </div>
  );
}

// Стоп-слова. Не цензура, а список оборотов, которые модель тянет в каждый второй
// ход независимо от сцены: поодиночке они не режут глаз, но на двадцатом ходу
// читаются как подпись генератора. Список уходит в запрос отдельным блоком, и при
// включённом управляемом размышлении в чек-листе появляется пункт «сверься с ним».
// Пустое поле = осознанно выключено: тогда не уходит ни блок, ни пункт проверки.
function BanWordsField({
  cfg,
  patch,
}: {
  cfg: PresetSettings;
  patch: (p: Partial<PresetSettings>) => void;
}) {
  const value = cfg.banWords ?? DEFAULT_BAN_WORDS;
  const isDefault = value === DEFAULT_BAN_WORDS;
  const count = value.split(/[,\n]/).map((x) => x.trim()).filter(Boolean).length;
  return (
    <div className="sm:col-span-2 rounded-lg border border-white/10 p-3">
      <label className="label">Стоп-слова {count ? `(${count})` : '(выключены)'}</label>
      <p className="text-xs text-gray-500 mb-2">
        Обороты, которые модель не должна писать ни в каком виде — ни переформулировав, ни
        синонимом той же картинки. Через запятую или с новой строки, на любом языке. Пустое поле —
        блок вообще не уходит в запрос.
      </p>
      <textarea
        className="input h-28 text-sm"
        value={value}
        onChange={(e) => patch({ banWords: e.target.value })}
        placeholder="воздух загустел, повисла тишина, по спине пробежал холодок"
      />
      <div className="flex gap-2 mt-2">
        <button
          className="btn-ghost !px-3 !py-1 text-xs"
          onClick={() => patch({ banWords: DEFAULT_BAN_WORDS })}
          disabled={isDefault}
        >
          Вернуть стандартный список
        </button>
        <button
          className="btn-ghost !px-3 !py-1 text-xs"
          onClick={() => patch({ banWords: '' })}
          disabled={!value.trim()}
        >
          Очистить
        </button>
      </div>
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


// Одно необязательное числовое поле параметров выборки. Ключевое отличие от
// обычного ползунка — состояние «не задано»: у части шлюзов явный ноль и
// отсутствие параметра ведут себя по-разному, и подменять одно другим нельзя.
function PenaltyField({
  label,
  value,
  onChange,
  hint,
  min = -2,
  max = 2,
  step = 0.1,
}: {
  label: string;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  hint: string;
  min?: number;
  max?: number;
  step?: number;
}) {
  const on = value !== undefined;
  return (
    <Field label={`${label}: ${on ? value.toFixed(2) : '— (не шлём)'}`}>
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          className="flex-1"
          value={on ? value : 0}
          disabled={!on}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <button
          className="btn-ghost !px-2 !py-0.5 text-[11px] shrink-0"
          onClick={() => onChange(on ? undefined : 0)}
          title={on ? 'Не слать этот параметр' : 'Задать значение'}
        >
          {on ? 'сбросить' : 'задать'}
        </button>
      </div>
      <p className="text-[11px] text-gray-500 mt-1">{hint}</p>
    </Field>
  );
}
