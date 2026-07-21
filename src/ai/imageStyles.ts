import { create } from 'zustand';
import { uid } from '../shared/utils';

// Пресеты стиля изображения для CG-студии. ГЛОБАЛЬНЫЕ (переиспользуются между
// проектами), хранятся в localStorage. Стиль — независимая от системного промпта
// строка; сохраняется с именем и потом выбирается из выпадающего меню.

export interface StylePreset {
  id: string;
  name: string;
  style: string;
}

const LS_KEY = 'nf_cg_styles';

function load(): StylePreset[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((p) => p && typeof p.name === 'string' && typeof p.style === 'string')
      .map((p) => ({ id: typeof p.id === 'string' ? p.id : uid('style'), name: p.name, style: p.style }));
  } catch {
    return [];
  }
}

function persist(list: StylePreset[]) {
  localStorage.setItem(LS_KEY, JSON.stringify(list));
}

interface StylePresetStore {
  presets: StylePreset[];
  add: (name: string, style: string) => void;
  remove: (id: string) => void;
}

export const useStylePresets = create<StylePresetStore>((set, get) => ({
  presets: load(),
  add: (name, style) => {
    const clean = name.trim();
    if (!clean) return;
    // Перезаписываем пресет с тем же именем, иначе добавляем.
    const existing = get().presets.find((p) => p.name.toLowerCase() === clean.toLowerCase());
    const next = existing
      ? get().presets.map((p) => (p.id === existing.id ? { ...p, style } : p))
      : [...get().presets, { id: uid('style'), name: clean, style }];
    persist(next);
    set({ presets: next });
  },
  remove: (id) => {
    const next = get().presets.filter((p) => p.id !== id);
    persist(next);
    set({ presets: next });
  },
}));
