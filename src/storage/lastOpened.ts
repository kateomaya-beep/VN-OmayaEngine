// Когда проект открывали последний раз — для тихой пометки «давно не открывали»
// в библиотеке. Сама система ничего не архивирует: пометка только подсказывает.
const LS_KEY = 'nf_last_opened_v1';
const STALE_MS = 30 * 24 * 60 * 60 * 1000;

function load(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {};
  } catch {
    return {};
  }
}
function save(m: Record<string, number>): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(m));
  } catch {
    /* не страшно */
  }
}

export function markOpened(id: string): void {
  const m = load();
  m[id] = Date.now();
  save(m);
}

/**
 * Давно ли не открывали проект. Проекту без отметки (появился до этой функции)
 * ставим «сейчас» при первом взгляде: о прошлом мы ничего не знаем, и пометка
 * появится, только если его действительно не откроют месяц.
 */
export function staleSince(id: string, now = Date.now()): boolean {
  const m = load();
  if (!m[id]) {
    m[id] = now;
    save(m);
    return false;
  }
  return now - m[id] > STALE_MS;
}
