import { create } from 'zustand';
import { defaultPreset, normalizePreset, type PromptPreset } from './promptPreset';
import { defaultRpPreset, normalizeRpPreset } from './rpPreset';
import { defaultLocalPreset, normalizeLocalPreset } from './localPreset';
import { defaultDeepseekPreset, normalizeDeepseekPreset } from './deepseekPreset';
import { isPromptProcessing, type PromptProcessing } from './promptPostProcess';
import { normalizeRegexRules, type RegexRule } from './regexRules';
import type { AdvancedPromptBlock, NarrativeMode } from '../shared/types';
import { DEFAULT_TURN_LENGTH, normalizeTurnLength, LEGACY_THINKING_PLANS } from '../shared/types';

// Семейство модели, под которое подогнан пресет и параметры.
export type ModelProfile = 'universal' | 'deepseek' | 'local';

export function isModelProfile(v: unknown): v is ModelProfile {
  return v === 'universal' || v === 'deepseek' || v === 'local';
}

export const MODEL_PROFILES: { id: ModelProfile; label: string; hint: string }[] = [
  {
    id: 'universal',
    label: 'Универсальный (Gemini, Claude, GPT)',
    hint: 'Полный пресет. На этих моделях он и отлаживался.',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    hint:
      'Лечит фирменные привычки DeepSeek: пересказ хода игрока в начале ответа, заедание удачных ' +
      'фраз и одинаковую композицию каждой сцены. Плюс штрафы за повтор и разбор прошлого ответа ' +
      'в думалке — промптом одним это не лечится.',
  },
  {
    id: 'local',
    label: 'Своя модель (LM Studio, Ollama)',
    hint: 'Компактный пресет и малый контекст: маленькая модель не удержит полный свод правил.',
  },
];

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
  // Пресет под болячки DeepSeek — см. deepseekPreset.ts.
  deepseekPreset: PromptPreset;
  // ПРОФИЛЬ МОДЕЛИ. Универсальный пресет «для всех» — компромисс, а модели ломаются
  // по-разному: у DeepSeek эхо и заедание фраз, у локальной — предел контекста.
  // Профиль подставляет и пресет, и параметры генерации под конкретную родню.
  modelProfile: ModelProfile;
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
  // Ядерная выборка. undefined — не шлём вовсе (провайдер решает сам). Крутить
  // ВМЕСТЕ с температурой не стоит: оба режут один и тот же хвост распределения.
  topP?: number;
  // ШТРАФЫ ЗА ПОВТОР (−2…2). Единственный МЕХАНИЧЕСКИЙ рычаг против «модель
  // жуёт одни и те же фразы» — промптом это лечится плохо, потому что модель не
  // видит своей склонности со стороны. frequency бьёт по частоте повторов,
  // presence — по возврату к уже поднятым темам. undefined — не шлём.
  frequencyPenalty?: number;
  presencePenalty?: number;
  // Гасить РОДНУЮ думалку модели там, где она включена по умолчанию и мешает.
  // У DeepSeek V4 это не блажь: в режиме размышления температура и штрафы за
  // повтор не действуют вовсе — принимаются молча и игнорируются. Пока думалка
  // включена, всё, что ниже, не работает.
  disableNativeThinking: boolean;
  liveWindow: number;
  contextBudget: number;
  turnLength: { min: number; max: number };
  choiceMinGap: number; // 0 = без ограничения
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'max';
  guidedThinking: boolean;
  thinkingPlan?: string;
  // Стоп-слова: обороты, которые модель не должна писать. undefined = список по
  // умолчанию (DEFAULT_BAN_WORDS), пустая строка = осознанно выключено, и тогда
  // в запрос не уходит ни блока, ни пункта проверки в чек-листе.
  banWords?: string;
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
    deepseekPreset: defaultDeepseekPreset(),
    modelProfile: 'universal',
    promptProcessing: 'merge',
    impersonationGuard: true,
    streamingEnabled: true,
    hidePrefill: true,
    regexRules: [],
    showStateInfobox: true,
    assistantPersona: '',
    narrativeLanguage: 'ru',
    temperature: 0.9,
    disableNativeThinking: false,
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

// План, совпадающий со СТАРЫМ дефолтом, автор не правил — он просто сохранился
// при первом открытии панели. Стираем такой в undefined, а не подменяем текстом:
// дефолт зависит и от режима, и от профиля модели (см. promptBuilder), и записать
// сюда один конкретный вариант значило бы навязать РП-игроку план новеллы.
function refreshThinkingPlan(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  return LEGACY_THINKING_PLANS.some((old) => old.trim() === v.trim()) ? undefined : v;
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
      deepseekPreset: normalizeDeepseekPreset(v.deepseekPreset),
      // Миграция: раньше был один тумблер «локальная модель», теперь профиль.
      modelProfile: isModelProfile(v.modelProfile) ? v.modelProfile : v.localMode ? 'local' : 'universal',
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
      topP: typeof v.topP === 'number' ? v.topP : undefined,
      frequencyPenalty: typeof v.frequencyPenalty === 'number' ? v.frequencyPenalty : undefined,
      presencePenalty: typeof v.presencePenalty === 'number' ? v.presencePenalty : undefined,
      disableNativeThinking: !!v.disableNativeThinking,
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
      banWords: typeof v.banWords === 'string' ? v.banWords : undefined,
      prefill: typeof v.prefill === 'string' ? v.prefill : undefined,
      advancedBlocks: Array.isArray(v.advancedBlocks)
        ? v.advancedBlocks
            .filter((b: any) => b && typeof b.content === 'string')
            .map((b: any) => ({
              content: b.content,
              depth: num(b.depth, 0),
              mode: b.mode === 'rp' || b.mode === 'vn' ? b.mode : undefined,
            }))
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

// НАСТРОЙКИ ПОД DEEPSEEK. Ключевое здесь — не числа сами по себе, а то, что они
// вообще начинают действовать: у DeepSeek V4 думалка включена по умолчанию, а в
// режиме думалки температура и штрафы за повтор принимаются молча и игнорируются.
// Поэтому первым делом гасим родную думалку — иначе весь остальной список ниже
// был бы бесполезной декорацией.
//
//  temperature 1.0 — БАЗОВАЯ рекомендация DeepSeek для V4 Pro. Фигура «1.5 для
//    художественного текста» из их старой таблицы сюда не годится: она про
//    короткие тексты, а ход РП длинный, и к его концу шум накапливается —
//    первым сыплется пунктуация.
//  frequencyPenalty 0.1 — НАМЕРЕННО почти ноль. Этот штраф растёт с числом
//    повторов токена, а чаще всего в тексте повторяются точка и запятая: на
//    заметных значениях модель к концу длинного хода буквально перестаёт их
//    ставить (начало ответа хорошее, конец — сплошным потоком). Против заедания
//    ФРАЗ он всё равно почти бесполезен: штрафы работают на уровне токенов, а не
//    оборотов, — эту работу делают блоки пресета и разбор прошлого ответа.
//  presencePenalty 0.3 — ровный штраф без накопления: за уже использованное слово
//    он одинаков и первый раз, и десятый, поэтому знаки препинания от него не
//    страдают. Из двух штрафов на длинном тексте безопасен именно этот.
//  topP не трогаем: крутить его вместе с температурой не надо, оба режут один
//    хвост распределения.
const DEEPSEEK_DEFAULTS: Partial<PresetSettings> = {
  disableNativeThinking: true,
  temperature: 1.0,
  frequencyPenalty: 0.1,
  presencePenalty: 0.3,
  guidedThinking: true,
  // План НЕ записываем: под профилем DeepSeek promptBuilder и так берёт свой
  // (DEEPSEEK_THINKING_PLAN) как дефолт. Записанная копия застыла бы в той версии,
  // что была на момент переключения профиля, и правки чек-листа до неё не доехали бы.
  thinkingPlan: undefined,
  reasoningEffort: 'none',
};

const UNIVERSAL_DEFAULTS: Partial<PresetSettings> = {
  disableNativeThinking: false,
  frequencyPenalty: undefined,
  presencePenalty: undefined,
};

const PROFILE_DEFAULTS: Record<ModelProfile, Partial<PresetSettings>> = {
  universal: UNIVERSAL_DEFAULTS,
  deepseek: DEEPSEEK_DEFAULTS,
  local: LOCAL_DEFAULTS,
};

// Какие поля профиль подменяет — и, значит, какие надо сохранить, чтобы вернуть.
// Объединение по ВСЕМ профилям: иначе переключение deepseek → local оставило бы
// висеть штрафы за повтор, которых в локальном профиле нет.
const PROFILE_KEYS = Array.from(
  new Set(Object.values(PROFILE_DEFAULTS).flatMap((d) => Object.keys(d)))
) as (keyof PresetSettings)[];

let current = load();

// Не-хук доступ для движка (buildRequest/runTurn/memoryEngine).
export function getPresetSettings(): PresetSettings {
  return current;
}

// Пресет, действующий для данного режима повествования. Один и тот же проект можно
// вести и новеллой, и текстовым РП — блоки при этом берутся разные.
export function presetForMode(s: PresetSettings, mode: NarrativeMode): PromptPreset {
  // Профиль подменяет пресет только в РП. В новелле подменять нечем: там ход
  // держится на JSON-контракте, и выкинуть его — значит не получить ход вовсе.
  if (mode === 'rp') {
    if (s.modelProfile === 'local') return s.localPreset;
    if (s.modelProfile === 'deepseek') return s.deepseekPreset;
    return s.rpPreset;
  }
  return s.preset;
}

interface PresetStore {
  settings: PresetSettings;
  patch: (p: Partial<PresetSettings>) => void;
  setModelProfile: (p: ModelProfile) => void;
}

export const usePresetSettings = create<PresetStore>((set) => ({
  settings: current,
  patch: (p) => {
    current = { ...current, ...p };
    localStorage.setItem(LS_KEY, JSON.stringify(current));
    set({ settings: current });
  },
  // СМЕНА ПРОФИЛЯ. Профиль не накрывает настройки невидимым слоем, а ПОДСТАВЛЯЕТ
  // значения в те же самые поля: дальше они обычные и правятся как всегда —
  // иначе «удобный выбор» отнимал бы возможность подогнать движок под себя.
  // Прежние значения откладываются и возвращаются при возврате на универсальный.
  setModelProfile: (profile) => {
    if (profile === current.modelProfile) return;
    // Откладываем ОДИН раз — на первом уходе с универсального. Иначе прыжок
    // deepseek → local сохранил бы поверх бэкапа уже профильные значения, и
    // возврат отдал бы не то, что настраивал пользователь, а чужие дефаулты.
    const backup =
      current.modelProfile === 'universal'
        ? (Object.fromEntries(PROFILE_KEYS.map((k) => [k, current[k]])) as Partial<PresetSettings>)
        : current.cloudBackup;
    // Отложенное накатываем ПЕРЕД профильным — иначе профили наслаивались бы друг
    // на друга: переход deepseek → local оставлял бы висеть штрафы за повтор,
    // которых в локальном профиле нет.
    //
    // Но накатываем НЕ ЦЕЛИКОМ, а только то, что подменял ПОКИДАЕМЫЙ профиль. Иначе
    // смена профиля откатывала и то, чего профили не касаются: выставил длину хода
    // «полотно», сходил в другой профиль и обратно — и она молча вернулась к
    // отложенной. Со стороны это выглядит как «настройка не работает, ход всегда
    // одинаковый», и найти причину невозможно: поле в панели показывает уже
    // откаченное значение.
    const leaving = PROFILE_DEFAULTS[current.modelProfile];
    const restore = Object.fromEntries(
      Object.keys(leaving)
        .filter((k) => backup && k in backup)
        .map((k) => [k, (backup as any)[k]])
    ) as Partial<PresetSettings>;
    const base = { ...current, ...restore, ...PROFILE_DEFAULTS[profile] };
    // Отложенное тоже подтягиваем: поля, которые покидаемый профиль НЕ подменял,
    // пользователь правил сам — значит это и есть его значение, и вернуть его при
    // следующем возврате надо именно таким.
    const ownEdits = Object.fromEntries(
      PROFILE_KEYS.filter((k) => !(k in leaving)).map((k) => [k, current[k]])
    ) as Partial<PresetSettings>;
    const nextBackup = backup ? { ...backup, ...ownEdits } : backup;
    current = {
      ...base,
      modelProfile: profile,
      localMode: profile === 'local',
      cloudBackup: profile === 'universal' ? undefined : nextBackup,
    };
    localStorage.setItem(LS_KEY, JSON.stringify(current));
    set({ settings: current });
  },
}));

