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
  // Смена темы убрана — приложение всегда тёмное (неоновый дизайн). Стор оставлен
  // для совместимости, но зафиксирован на 'dark'.
  return 'dark';
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
