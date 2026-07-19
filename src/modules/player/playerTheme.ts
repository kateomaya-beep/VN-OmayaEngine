import { create } from 'zustand';
import type { CSSProperties } from 'react';

// Мини-мастерская оформления ПЛЕЕРА (только экран игры): акцентный цвет, шрифт
// (по ссылке-импорту, напр. Google Fonts) и масштаб текста. Хранится в localStorage,
// применяется как CSS-переменные на корне плеера — конструктора/библиотеки не касается.

export interface PlayerTheme {
  accent: string; // hex, напр. '#b18cff'
  fontUrl: string; // ссылка на таблицу стилей шрифта (Google Fonts и т.п.), опц.
  fontFamily: string; // CSS font-family, напр. 'Roboto Slab', опц.
  fontScale: number; // множитель размера читаемого текста (0.8–1.6)
}

export const DEFAULT_THEME: PlayerTheme = {
  accent: '#b18cff',
  fontUrl: '',
  fontFamily: '',
  fontScale: 1,
};

const LS_KEY = 'nf_player_theme';

function load(): PlayerTheme {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { ...DEFAULT_THEME };
    const p = JSON.parse(raw);
    return {
      accent: typeof p.accent === 'string' ? p.accent : DEFAULT_THEME.accent,
      fontUrl: typeof p.fontUrl === 'string' ? p.fontUrl : '',
      fontFamily: typeof p.fontFamily === 'string' ? p.fontFamily : '',
      fontScale:
        typeof p.fontScale === 'number' && p.fontScale >= 0.6 && p.fontScale <= 2
          ? p.fontScale
          : 1,
    };
  } catch {
    return { ...DEFAULT_THEME };
  }
}

// hex (#rgb/#rrggbb) → [r,g,b]; при мусоре — дефолтный акцент.
function hexToRgb(hex: string): [number, number, number] {
  let h = hex.trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = Number.parseInt(h, 16);
  if (h.length !== 6 || Number.isNaN(n)) return [177, 140, 255];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mixWhite([r, g, b]: [number, number, number], amt: number): string {
  const m = (c: number) => Math.round(c + (255 - c) * amt);
  return `rgb(${m(r)}, ${m(g)}, ${m(b)})`;
}

// Инжектит/обновляет <link> шрифта в <head>. Пустой URL — удаляет ссылку.
export function ensureFontLink(url: string): void {
  const id = 'nf-player-font';
  const existing = document.getElementById(id) as HTMLLinkElement | null;
  const clean = url.trim();
  if (!clean) {
    existing?.remove();
    return;
  }
  if (existing) {
    if (existing.href !== clean) existing.href = clean;
    return;
  }
  const link = document.createElement('link');
  link.id = id;
  link.rel = 'stylesheet';
  link.href = clean;
  document.head.appendChild(link);
}

// CSS-переменные корня плеера, вычисленные из темы.
export function themeVars(t: PlayerTheme): CSSProperties {
  const rgb = hexToRgb(t.accent);
  const [r, g, b] = rgb;
  return {
    '--pl-accent': `rgb(${r}, ${g}, ${b})`,
    '--pl-accent-bright': mixWhite(rgb, 0.35),
    '--pl-accent-glow': `rgba(${r}, ${g}, ${b}, 0.5)`,
    '--pl-accent-soft': `rgba(${r}, ${g}, ${b}, 0.16)`,
    '--pl-font-scale': String(t.fontScale),
    ...(t.fontFamily ? { fontFamily: `'${t.fontFamily}', 'Inter', system-ui, sans-serif` } : {}),
  } as CSSProperties;
}

interface ThemeStore {
  theme: PlayerTheme;
  set: (patch: Partial<PlayerTheme>) => void;
  reset: () => void;
}

export const usePlayerTheme = create<ThemeStore>((set, get) => ({
  theme: load(),
  set: (patch) => {
    const theme = { ...get().theme, ...patch };
    localStorage.setItem(LS_KEY, JSON.stringify(theme));
    ensureFontLink(theme.fontUrl);
    set({ theme });
  },
  reset: () => {
    localStorage.setItem(LS_KEY, JSON.stringify(DEFAULT_THEME));
    ensureFontLink('');
    set({ theme: { ...DEFAULT_THEME } });
  },
}));
