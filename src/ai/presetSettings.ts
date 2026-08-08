import { create } from 'zustand';
import { defaultPreset, normalizePreset, type PromptPreset } from './promptPreset';
import type { AdvancedPromptBlock } from '../shared/types';
import { DEFAULT_TURN_LENGTH, normalizeTurnLength } from '../shared/types';

// ГЛОБАЛЬНЫЕ настройки пресета/генерации — ОДИН пресет на все истории (не на проект).
// Доступны из верхней панели везде и всегда, даже без открытого проекта. В будущем —
// версии пресета / назначение шаблонов на истории; пока один общий. Хранится в
// localStorage, как и подключение к ИИ.
export interface PresetSettings {
  preset: PromptPreset;
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
    narrativeLanguage: 'ru',
    temperature: 0.9,
    liveWindow: 12,
    // Бюджет контекста ЖЁСТКО ограничивает запрос (см. promptBuilder), а не только
    // красит счётчик. Он же задаёт, сколько истории живёт дословно: память
    // сворачивается, когда живая история перестаёт помещаться в свою долю бюджета.
    // 24000 при системной части в ~14k оставляли всего 5–6 ходов дословно — модель
    // выглядела амнезиком. 40000 — примерно 11–12 ходов на типичной длине хода.
    contextBudget: 40000,
    turnLength: { ...DEFAULT_TURN_LENGTH },
    choiceMinGap: 0,
    guidedThinking: false,
    advancedBlocks: [],
  };
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
      narrativeLanguage: v.narrativeLanguage === 'en' ? 'en' : 'ru',
      temperature: num(v.temperature, d.temperature),
      liveWindow: num(v.liveWindow, d.liveWindow),
      // Прежние дефолты (8000, 24000) считаем «пользователь не настраивал» и
      // поднимаем до нового: на них живая история резалась до 5–6 ходов.
      contextBudget: [8000, 24000].includes(num(v.contextBudget, d.contextBudget))
        ? d.contextBudget
        : num(v.contextBudget, d.contextBudget),
      turnLength: v.turnLength ? normalizeTurnLength(v.turnLength) : d.turnLength,
      choiceMinGap: Math.max(0, Math.min(20, Math.round(num(v.choiceMinGap, 0)))),
      reasoningEffort: ['none', 'low', 'medium', 'high'].includes(v.reasoningEffort)
        ? v.reasoningEffort
        : undefined,
      guidedThinking: !!v.guidedThinking,
      thinkingPlan: typeof v.thinkingPlan === 'string' ? v.thinkingPlan : undefined,
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
