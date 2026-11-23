import { create } from 'zustand';
import { uid } from '../shared/utils';
import type { NaiImageConfig } from '../shared/types';

// Пресеты стиля изображения для CG-студии. ГЛОБАЛЬНЫЕ (переиспользуются между
// проектами), хранятся в localStorage. Два вида — у них разные поля:
//  • text — для Nano Banana / OpenAI: стиль фразой + «Чего быть не должно»;
//  • nai  — для NovelAI: теги стиля, свои теги «нежелательного», пресет UC, качество.
// Старые пресеты (только стиль) — вида text без «нежелательного»: при выборе
// меняют только стиль, как и раньше.

export type NaiStyleFields = Pick<NaiImageConfig, 'styleTags' | 'negativeTags' | 'ucPreset' | 'quality'>;

export interface StylePreset {
  id: string;
  name: string;
  kind: 'text' | 'nai';
  /** text: стиль фразой. */
  style: string;
  /** text: «Чего быть не должно»; undefined — пресет старый, без него. */
  negative?: string;
  /** nai: все поля стиля NovelAI. */
  nai?: NaiStyleFields;
}

const LS_KEY = 'nf_cg_styles';
const UC = ['heavy', 'light', 'human', 'none'];

function parseNai(v: any): NaiStyleFields | undefined {
  if (!v || typeof v !== 'object') return undefined;
  return {
    styleTags: typeof v.styleTags === 'string' ? v.styleTags : '',
    negativeTags: typeof v.negativeTags === 'string' ? v.negativeTags : '',
    ucPreset: UC.includes(v.ucPreset) ? v.ucPreset : 'heavy',
    quality: v.quality !== false,
  };
}

export function parseStylePresets(arr: unknown): StylePreset[] {
  if (!Array.isArray(arr)) return [];
  const out: StylePreset[] = [];
  for (const p of arr) {
    if (!p || typeof p.name !== 'string') continue;
    const id = typeof p.id === 'string' ? p.id : uid('style');
    if (p.kind === 'nai') {
      const nai = parseNai(p.nai);
      if (nai) out.push({ id, name: p.name, kind: 'nai', style: '', nai });
    } else if (typeof p.style === 'string') {
      out.push({ id, name: p.name, kind: 'text', style: p.style, ...(typeof p.negative === 'string' ? { negative: p.negative } : {}) });
    }
  }
  return out;
}

function load(): StylePreset[] {
  try {
    return parseStylePresets(JSON.parse(localStorage.getItem(LS_KEY) || '[]'));
  } catch {
    return [];
  }
}

function persist(list: StylePreset[]) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

export type StylePresetInput = { kind: 'text'; style: string; negative: string } | { kind: 'nai'; nai: NaiStyleFields };

interface StylePresetStore {
  presets: StylePreset[];
  /** Сохранить под именем; пресет того же вида с тем же именем перезаписывается. Возвращает id. */
  save: (name: string, data: StylePresetInput) => string;
  remove: (id: string) => void;
}

export const useStylePresets = create<StylePresetStore>((set, get) => ({
  presets: load(),
  save: (name, data) => {
    const clean = name.trim();
    if (!clean) return '';
    const fields: Omit<StylePreset, 'id' | 'name'> =
      data.kind === 'nai'
        ? { kind: 'nai', style: '', nai: { ...data.nai } }
        : { kind: 'text', style: data.style, negative: data.negative };
    const existing = get().presets.find((p) => p.kind === data.kind && p.name.toLowerCase() === clean.toLowerCase());
    const id = existing?.id ?? uid('style');
    const next = existing
      ? get().presets.map((p) => (p.id === id ? { id, name: p.name, ...fields } : p))
      : [...get().presets, { id, name: clean, ...fields }];
    persist(next);
    set({ presets: next });
    return id;
  },
  remove: (id) => {
    const next = get().presets.filter((p) => p.id !== id);
    persist(next);
    set({ presets: next });
  },
}));
