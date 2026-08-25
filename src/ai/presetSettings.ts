import { create } from 'zustand';
import { defaultPreset, normalizePreset, type PromptPreset } from './promptPreset';
import { defaultRpPreset, normalizeRpPreset } from './rpPreset';
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
  promptProcessing: PromptProcessing;
  // Страховка от «модель написала за игрока» в РП: стоп-строки провайдеру плюс срез
  // хвоста ответа, если модель всё же начала реплику героя. Промпт один это не держит.
  impersonationGuard: boolean;
  // Правила-регэкспы: правка текста между моделью и экраном (и/или запросом).
  regexRules: RegexRule[];
  // Инфобокс состояния под ответом в режиме РП (в духе Horae). Данные для него
  // приезжают служебным блоком <state>; выключать имеет смысл, если блок отключён.
  showStateInfobox: boolean;
  // Язык ПОВЕСТВОВАНИЯ (нарратив/реплики/выборы), НЕ язык интерфейса. Влияет на язык,
  // на котором ИИ пишет текст истории. Пока ru/en.
  narrativeLanguage: 'ru' | 'en';
  temperature: number;
  liveWindow: number;
  contextBudget: number;
  turnLength: { min: number; max: number };
  choiceMinGap: number; // 0 = без ограничения
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
  guidedThinking: boolean;
  thinkingPlan?: string;
  prefill?: string;
  advancedBlocks: AdvancedPromptBlock[];
}

const LS_KEY = 'nf_preset';

function defaults(): PresetSettings {
  return {
    preset: defaultPreset(),
    rpPreset: defaultRpPreset(),
    promptProcessing: 'merge',
    impersonationGuard: true,
    regexRules: [],
    showStateInfobox: true,
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
      promptProcessing: isPromptProcessing(v.promptProcessing) ? v.promptProcessing : d.promptProcessing,
      impersonationGuard: typeof v.impersonationGuard === 'boolean' ? v.impersonationGuard : true,
      regexRules: normalizeRegexRules(v.regexRules),
      showStateInfobox: typeof v.showStateInfobox === 'boolean' ? v.showStateInfobox : true,
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
      reasoningEffort: ['none', 'low', 'medium', 'high'].includes(v.reasoningEffort)
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

let current = load();

// Не-хук доступ для движка (buildRequest/runTurn/memoryEngine).
export function getPresetSettings(): PresetSettings {
  return current;
}

// Пресет, действующий для данного режима повествования. Один и тот же проект можно
// вести и новеллой, и текстовым РП — блоки при этом берутся разные.
export function presetForMode(s: PresetSettings, mode: NarrativeMode): PromptPreset {
  return mode === 'rp' ? s.rpPreset : s.preset;
}

interface PresetStore {
  settings: PresetSettings;
  patch: (p: Partial<PresetSettings>) => void;
}

export const usePresetSettings = create<PresetStore>((set) => ({
  settings: current,
  patch: (p) => {
    current = { ...current, ...p };
    localStorage.setItem(LS_KEY, JSON.stringify(current));
    set({ settings: current });
  },
}));
