import { create } from 'zustand';

// Тема приложения (см. CR v2 §H.3): тёмная/светлая, сохраняется между сессиями.
// Применяется к «хрому» приложения (библиотека/конструктор) через CSS-переменные
// в index.css — иммерсивная сцена плеера остаётся тёмной по дизайну (это игровой
// экран поверх пользовательских фонов/арта, а не UI-хром).
export type Theme = 'dark' | 'light';

const LS_KEY = 'nf_theme';

function applyTheme(t: Theme) {
  document.documentElement.setAttribute('data-theme', t);
}

function detectInitial(): Theme {
  const saved = localStorage.getItem(LS_KEY);
  if (saved === 'dark' || saved === 'light') return saved;
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

interface ThemeStore {
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggleTheme: () => void;
}

const initial = detectInitial();
if (typeof document !== 'undefined') applyTheme(initial);

export const useTheme = create<ThemeStore>((set, get) => ({
  theme: initial,
  setTheme: (t) => {
    localStorage.setItem(LS_KEY, t);
    applyTheme(t);
    set({ theme: t });
  },
  toggleTheme: () => get().setTheme(get().theme === 'dark' ? 'light' : 'dark'),
}));
