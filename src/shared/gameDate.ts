// Внутриигровая дата — строго "ДД/ММ/ГГГГ" (Batch 8, Часть II). Утилиты парсинга и
// арифметики через UTC-Date (без часовых поясов). Всё мягко: невалидное → null.

export interface Ymd {
  d: number;
  m: number; // 1..12
  y: number;
}

const RE = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/;

export function parseDate(s: unknown): Ymd | null {
  if (typeof s !== 'string') return null;
  const m = s.trim().match(RE);
  if (!m) return null;
  const d = Number(m[1]);
  const mo = Number(m[2]);
  let y = Number(m[3]);
  if (m[3].length <= 2) y += 2000; // "26" → 2026
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  // Проверка через Date (отсекает 31/02 и т.п.).
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return { d, m: mo, y };
}

export function isValidDate(s: unknown): boolean {
  return parseDate(s) !== null;
}

export function formatDate(v: Ymd): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(v.d)}/${pad(v.m)}/${v.y}`;
}

function toUTC(v: Ymd): number {
  return Date.UTC(v.y, v.m - 1, v.d);
}

// Количество полных суток от a до b (b - a). Отрицательное, если b раньше a.
export function diffDays(a: Ymd, b: Ymd): number {
  return Math.round((toUTC(b) - toUTC(a)) / 86400000);
}

export function addDays(v: Ymd, n: number): Ymd {
  const dt = new Date(toUTC(v) + n * 86400000);
  return { d: dt.getUTCDate(), m: dt.getUTCMonth() + 1, y: dt.getUTCFullYear() };
}

// Валидное время "ЧЧ:ММ" или null.
export function parseTime(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const m = s.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}
