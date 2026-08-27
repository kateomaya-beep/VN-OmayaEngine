import { create } from 'zustand';
import { defaultPreset, normalizePreset, type PromptPreset } from './promptPreset';
import { defaultRpPreset, normalizeRpPreset } from './rpPreset';
import { defaultLocalPreset, normalizeLocalPreset } from './localPreset';
import { isPromptProcessing, type PromptProcessing } from './promptPostProcess';
import { normalizeRegexRules, type RegexRule } from './regexRules';
import type { AdvancedPromptBlock, NarrativeMode } from '../shared/types';
import {
  DEFAULT_TURN_LENGTH,
  normalizeTurnLength,
  DEFAULT_THINKING_PLAN,
  LEGACY_THINKING_PLANS,
} from '../shared/types';

// ГЛОБАЛЬНЫЕ настройки пресета/генерации — ОДИН пресет на все истории (не на проект).
// Доступны из верхней панели везде и всегда, даже без открытого проекта. В будущем —
// версии пресета / назначение шаблонов на истории; пока один общий. Хранится в
// localStorage, как и подключение к ИИ.
export interface PresetSettings {
  preset: PromptPreset;
  // Отдельный пресет для режима «классический РП»: там нет JSON-контракта, спрайтов
  // и выборов, зато есть жёсткий запрет писать за игрока. Держать оба в одном списке
  // блоков не вышло бы — половина блоков каждого режима мешает другому.
  rpPreset: PromptPreset;
  // Компактный пресет для локальной модели — см. localPreset.ts. Отдельный, а не
  // урезанная копия РП: у маленькой модели другой предел внимания и контекста.
  localPreset: PromptPreset;
  // РЕЖИМ ЛОКАЛЬНОЙ МОДЕЛИ. Один тумблер вместо десятка настроек: включив его,
  // пользователь получает и компактный пресет, и подогнанные параметры генерации
  // (см. LOCAL_OVERRIDES). Сохранённые «облачные» значения при этом НЕ портятся —
  // они просто перекрываются на время, и выключение возвращает всё как было.
  localMode: boolean;
  // Облачные значения, отложенные на время локального режима, — чтобы выключение
  // вернуло ровно то, что было настроено, а не общие дефолты.
  cloudBackup?: Partial<PresetSettings>;
  promptProcessing: PromptProcessing;
  // Страховка от «модель написала за игрока» в РП: срез хвоста ответа, если модель
  // всё же начала реплику героя. Промпт один это не держит.
  impersonationGuard: boolean;
  // Стриминг ответа в РП (по мере генерации, а не целиком в конце). Выключатель на
  // случай шлюза, который на потоке ведёт себя хуже, чем на обычном запросе.
  streamingEnabled: boolean;
  // Правила-регэкспы: правка текста между моделью и экраном (и/или запросом).
  regexRules: RegexRule[];
  // Инфобокс состояния под ответом в режиме РП (в духе Horae). Данные для него
  // приезжают служебным блоком <state>; выключать имеет смысл, если блок отключён.
  showStateInfobox: boolean;
  // Личность ассистента-соавтора — ГЛОБАЛЬНАЯ: это ваш помощник, а не свойство
  // отдельного проекта. Пусто — берётся дефолтная.
  assistantPersona: string;
  // Язык ПОВЕСТВОВАНИЯ (нарратив/реплики/выборы), НЕ язык интерфейса. Влияет на язык,
  // на котором ИИ пишет текст истории. Пока ru/en.
  narrativeLanguage: 'ru' | 'en';
  temperature: number;
  liveWindow: number;
  contextBudget: number;
  turnLength: { min: number; max: number };
  choiceMinGap: number; // 0 = без ограничения
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'max';
  guidedThinking: boolean;
  thinkingPlan?: string;
  prefill?: string;
  // Прятать префилл в показанном ответе. Префилл — наши слова, вписанные в уста
  // модели; «затравке» для джейлбрейка в ленте не место. Выключать имеет смысл,
  // когда префилл открывает разметку (одинокая «*» под курсив): без него она
  // осталась бы незакрытой.
  hidePrefill: boolean;
  advancedBlocks: AdvancedPromptBlock[];
}

const LS_KEY = 'nf_preset';

function defaults(): PresetSettings {
  return {
    preset: defaultPreset(),
    rpPreset: defaultRpPreset(),
    localPreset: defaultLocalPreset(),
    localMode: false,
    promptProcessing: 'merge',
    impersonationGuard: true,
    streamingEnabled: true,
    hidePrefill: true,
    regexRules: [],
    showStateInfobox: true,
    assistantPersona: '',
    narrativeLanguage: 'ru',
    temperature: 0.9,
    liveWindow: 12,
    // Бюджет контекста ЖЁСТКО ограничивает запрос (см. promptBuilder), а не только
    // красит счётчик. Он же задаёт, сколько истории живёт дословно: память
    // сворачивается, когда живая история перестаёт помещаться в свою долю бюджета.
    // Замер на типичном проекте (системная часть ~15k, ход ~700 слов): 24000 и 40000
    // дают одинаковые 9–17 ходов дословно (упирается в другой лимит), 80000 — уже
    // 12–32 хода и втрое меньше свёрток, 120000 сверх этого почти ничего не добавляет.
    // Запрос при 80000 — в среднем ~46k токенов: нужна модель со 128k контекста.
    contextBudget: 80000,
    turnLength: { ...DEFAULT_TURN_LENGTH },
    choiceMinGap: 0,
    guidedThinking: false,
    advancedBlocks: [],
  };
}

function refreshThinkingPlan(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  return LEGACY_THINKING_PLANS.some((old) => old.trim() === v.trim()) ? DEFAULT_THINKING_PLAN : v;
}

function load(): PresetSettings {
  const d = defaults();
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return d;
    const v = JSON.parse(raw);
    const num = (x: unknown, def: number) => (typeof x === 'number' && !Number.isNaN(x) ? x : def);
    return {
      preset: normalizePreset(v.preset),
      rpPreset: normalizeRpPreset(v.rpPreset),
      localPreset: normalizeLocalPreset(v.localPreset),
      localMode: !!v.localMode,
      cloudBackup: v.cloudBackup && typeof v.cloudBackup === 'object' ? v.cloudBackup : undefined,
      promptProcessing: isPromptProcessing(v.promptProcessing) ? v.promptProcessing : d.promptProcessing,
      impersonationGuard: typeof v.impersonationGuard === 'boolean' ? v.impersonationGuard : true,
      streamingEnabled: typeof v.streamingEnabled === 'boolean' ? v.streamingEnabled : true,
      hidePrefill: typeof v.hidePrefill === 'boolean' ? v.hidePrefill : true,
      regexRules: normalizeRegexRules(v.regexRules),
      showStateInfobox: typeof v.showStateInfobox === 'boolean' ? v.showStateInfobox : true,
      assistantPersona: typeof v.assistantPersona === 'string' ? v.assistantPersona : '',
      narrativeLanguage: v.narrativeLanguage === 'en' ? 'en' : 'ru',
      temperature: num(v.temperature, d.temperature),
      liveWindow: num(v.liveWindow, d.liveWindow),
      // Прежние дефолты (8000, 24000, 40000) считаем «пользователь не настраивал» и
      // поднимаем до нового: на них живая история была заметно короче.
      contextBudget: [8000, 24000, 40000].includes(num(v.contextBudget, d.contextBudget))
        ? d.contextBudget
        : num(v.contextBudget, d.contextBudget),
      turnLength: v.turnLength ? normalizeTurnLength(v.turnLength) : d.turnLength,
      choiceMinGap: Math.max(0, Math.min(20, Math.round(num(v.choiceMinGap, 0)))),
      reasoningEffort: ['none', 'low', 'medium', 'high', 'max'].includes(v.reasoningEffort)
        ? v.reasoningEffort
        : undefined,
      guidedThinking: !!v.guidedThinking,
      // План размышления: если лежит РОВНО прежний дефолт — автор его не писал, он
      // просто сохранился при открытии панели; обновляем на новый чек-лист. Всё,
      // что отличается хоть символом, считаем авторским и не трогаем.
      thinkingPlan: refreshThinkingPlan(v.thinkingPlan),
      prefill: typeof v.prefill === 'string' ? v.prefill : undefined,
      advancedBlocks: Array.isArray(v.advancedBlocks)
        ? v.advancedBlocks
            .filter((b: any) => b && typeof b.content === 'string')
            .map((b: any) => ({ content: b.content, depth: num(b.depth, 0) }))
        : [],
    };
  } catch {
    return d;
  }
}

// НАСТРОЙКИ ПОД ЛОКАЛЬНУЮ МОДЕЛЬ. Не «поменьше на всякий случай», а ответ на
// конкретные беды маленькой модели на своём железе:
//
//  contextBudget — главное и самое личное. Он должен совпадать с тем, сколько
//    контекста вы выделили модели при загрузке (в LM Studio это поле рядом с
//    моделью). Больше — запрос не влезет; сильно меньше — история будет рваться
//    там, где могла бы жить. Угадать за вас невозможно, поэтому 16000 — это
//    разумная отправная точка, а не приговор: поправьте под свою сборку.
//  turnLength — короче облачного, но не куце: длинный ход маленькая модель к
//    концу разваливает, начиная повторяться.
//  guidedThinking / prefill — она их чаще ломает, чем выполняет.
//  showStateInfobox — служебный JSON в конце хода портит и сводку, и прозу.
//  promptProcessing — 'semi': локальные сборки строги к чередованию ролей.
const LOCAL_DEFAULTS: Partial<PresetSettings> = {
  contextBudget: 16000,
  liveWindow: 10,
  turnLength: { min: 300, max: 600 },
  guidedThinking: false,
  prefill: undefined,
  showStateInfobox: false,
  reasoningEffort: 'none',
  promptProcessing: 'semi',
};

// Какие поля тумблер подменяет — и, значит, какие надо сохранить, чтобы вернуть.
const LOCAL_KEYS = Object.keys(LOCAL_DEFAULTS) as (keyof PresetSettings)[];

let current = load();

// Не-хук доступ для движка (buildRequest/runTurn/memoryEngine).
export function getPresetSettings(): PresetSettings {
  return current;
}

// Пресет, действующий для данного режима повествования. Один и тот же проект можно
// вести и новеллой, и текстовым РП — блоки при этом берутся разные.
export function presetForMode(s: PresetSettings, mode: NarrativeMode): PromptPreset {
  // Локальный режим подменяет пресет только в РП. В новелле подменять нечем:
  // там ход держится на JSON-контракте, и выкинуть его — значит не получить
  // ход вовсе. Маленькой модели новелла даётся тяжело в принципе, но это
  // честнее, чем молча отдать ей пресет, по которому она заведомо не ответит.
  if (s.localMode && mode === 'rp') return s.localPreset;
  return mode === 'rp' ? s.rpPreset : s.preset;
}

interface PresetStore {
  settings: PresetSettings;
  patch: (p: Partial<PresetSettings>) => void;
  setLocalMode: (on: boolean) => void;
}

export const usePresetSettings = create<PresetStore>((set) => ({
  settings: current,
  patch: (p) => {
    current = { ...current, ...p };
    localStorage.setItem(LS_KEY, JSON.stringify(current));
    set({ settings: current });
  },
  // ПЕРЕКЛЮЧЕНИЕ РЕЖИМА. Тумблер не накрывает настройки невидимым слоем, а
  // ПОДСТАВЛЯЕТ значения в те же самые поля: дальше они обычные и правятся как
  // всегда — иначе «удобный тумблер» отнимал бы возможность подогнать движок под
  // своё железо, а угадать его за пользователя нельзя. Прежние (облачные)
  // значения при этом откладываются и возвращаются при выключении.
  setLocalMode: (on) => {
    if (on === current.localMode) return;
    let next: PresetSettings;
    if (on) {
      const backup: Partial<PresetSettings> = {};
      for (const k of LOCAL_KEYS) (backup as any)[k] = current[k];
      next = { ...current, ...LOCAL_DEFAULTS, cloudBackup: backup, localMode: true };
    } else {
      // Возвращаем отложенное. Нет его (режим включили в старой версии) — просто
      // снимаем флаг: молча подставлять чужие дефолты хуже, чем оставить как есть.
      next = { ...current, ...(current.cloudBackup ?? {}), cloudBackup: undefined, localMode: false };
    }
    current = next;
    localStorage.setItem(LS_KEY, JSON.stringify(current));
    set({ settings: current });
  },
}));
