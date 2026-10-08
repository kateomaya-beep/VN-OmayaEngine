import { getDB, deleteSave } from './db';
import { logEvent } from '../shared/logStore';

// ЧИСТКА СТАРЫХ АВТОСНИМКОВ. У каждого прохождения кольцо из 15 автоснимков —
// полных копий истории на случай «прогресс слетел, откатиться на пару ходов».
// Нужны они только там, где играют сейчас; у брошенных прохождений это мёртвый вес
// и в браузере, и на диске.
//
// Старым прохождение считается, когда выполнены ОБА условия:
//  - в него не играли 7 дней и больше (по времени последнего сохранения);
//  - оно не последнее, в которое играли в этом проекте (самое свежее не чистится
//    никогда, даже если проект не открывали полгода).
// У старого остаются последние 3 автоснимка. Курсор («Продолжить»), чекпоинты и
// ветки не трогаются. Вернулись к прохождению — кольцо снова наполнится до 15.

export const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
export const KEEP_AUTOSNAPS = 3;
const THROTTLE_MS = 24 * 60 * 60 * 1000;
const LS_KEY = 'nf_prune_v1';

interface SaveMeta {
  slot: number;
  kind?: string;
  playthroughId?: string;
  savedAt: number;
}

function loadMarks(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {};
  } catch {
    return {};
  }
}
function saveMarks(m: Record<string, number>): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(m));
  } catch {
    /* не страшно — просто проверим ещё раз */
  }
}

/** Какие автоснимки удалить — чистая функция, без базы (её и проверяют тесты). */
export function staleAutosnaps(saves: SaveMeta[], now = Date.now()): SaveMeta[] {
  const groups = new Map<string, SaveMeta[]>();
  for (const s of saves) {
    const k = s.playthroughId || 'legacy';
    const g = groups.get(k);
    if (g) g.push(s);
    else groups.set(k, [s]);
  }
  let latestKey = '';
  let latestAt = -1;
  for (const [k, g] of groups) {
    const at = Math.max(...g.map((s) => s.savedAt || 0));
    if (at > latestAt) {
      latestAt = at;
      latestKey = k;
    }
  }
  const out: SaveMeta[] = [];
  for (const [k, g] of groups) {
    if (k === latestKey) continue;
    const last = Math.max(...g.map((s) => s.savedAt || 0));
    if (now - last < STALE_AFTER_MS) continue;
    const snaps = g.filter((s) => s.kind === 'autosnap').sort((a, b) => b.savedAt - a.savedAt);
    out.push(...snaps.slice(KEEP_AUTOSNAPS));
  }
  return out;
}

/** Чистка одного проекта — не чаще раза в сутки. Возвращает, сколько удалено. */
export async function pruneProject(projectId: string, force = false): Promise<number> {
  const marks = loadMarks();
  if (!force && Date.now() - (marks[projectId] || 0) < THROTTLE_MS) return 0;
  const db = await getDB();
  // Курсором и только метаданные: целиком сейвы большого проекта — десятки мегабайт.
  const metas: SaveMeta[] = [];
  let cur = await db.transaction('saves').store.index('byProject').openCursor(projectId);
  while (cur) {
    const v = cur.value;
    metas.push({ slot: v.slot, kind: v.kind, playthroughId: v.playthroughId, savedAt: v.savedAt });
    cur = await cur.continue();
  }
  const stale = staleAutosnaps(metas);
  for (const s of stale) await deleteSave(projectId, s.slot);
  marks[projectId] = Date.now();
  saveMarks(marks);
  if (stale.length) logEvent('info', 'save', `Чистка: у старых прохождений удалено автоснимков — ${stale.length} (оставлено по ${KEEP_AUTOSNAPS})`);
  return stale.length;
}

/** Все проекты по очереди, в фоне. */
export async function pruneAllStale(): Promise<void> {
  try {
    const db = await getDB();
    const ids = (await db.getAllKeys('projects')) as string[];
    for (const id of ids) await pruneProject(id);
  } catch (e) {
    logEvent('warn', 'save', 'Чистка старых автоснимков не удалась: ' + (e as Error).message);
  }
}
