import type { CSSProperties } from 'react';
import { DEFAULT_PLAYER_THEME, normalizePlayerTheme, type PlayerTheme } from '../../shared/types';

// Мини-мастерская оформления ПЛЕЕРА (только экран игры). Тема хранится В ПРОЕКТЕ
// (project.playerTheme) → едет с ним при копировании/экспорте/шаринге. Здесь —
// только view-хелперы: вычисление CSS-переменных и инжект шрифта.

export { DEFAULT_PLAYER_THEME, normalizePlayerTheme };
export type { PlayerTheme };

const LEGACY_LS_KEY = 'nf_player_theme';

// Back-compat: если у проекта темы нет, берём прежнюю глобальную (localStorage) как
// стартовую точку, иначе дефолт. Так старый выбор пользователя не теряется.
export function loadGlobalTheme(): PlayerTheme {
  try {
    const raw = localStorage.getItem(LEGACY_LS_KEY);
    if (raw) return normalizePlayerTheme(JSON.parse(raw));
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_PLAYER_THEME };
}

// hex (#rgb/#rrggbb) → [r,g,b]; при мусоре — дефолт.
function hexToRgb(hex: string, fallback: [number, number, number]): [number, number, number] {
  let h = hex.trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = Number.parseInt(h, 16);
  if (h.length !== 6 || Number.isNaN(n)) return fallback;
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
  const clean = (url || '').trim();
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
  const acc = hexToRgb(t.accent, [177, 140, 255]);
  const [ar, ag, ab] = acc;
  const [br, bg, bb] = hexToRgb(t.bubbleColor, [16, 13, 24]);
  const op = Math.max(0, Math.min(1, t.bubbleOpacity));
  return {
    '--pl-accent': `rgb(${ar}, ${ag}, ${ab})`,
    '--pl-accent-bright': mixWhite(acc, 0.35),
    '--pl-accent-glow': `rgba(${ar}, ${ag}, ${ab}, 0.5)`,
    '--pl-accent-soft': `rgba(${ar}, ${ag}, ${ab}, 0.16)`,
    '--pl-bubble-bg': `rgba(${br}, ${bg}, ${bb}, ${op})`,
    '--pl-font-scale': String(t.fontScale),
    ...(t.fontFamily ? { fontFamily: `'${t.fontFamily}', 'Inter', system-ui, sans-serif` } : {}),
  } as CSSProperties;
}
