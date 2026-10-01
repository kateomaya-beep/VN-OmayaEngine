import type { RuntimeState } from '../shared/types';
import { getDB } from './db';
import { compactState } from '../ai/branching';
import { logEvent } from '../shared/logStore';

// ЖУРНАЛ СНИМКОВ ПО СООБЩЕНИЯМ. Пока сообщение — последнее в ленте, каждое
// автосохранение перезаписывает его снимок: так в снимок попадают и ход, и ручные
// правки Game Master между ходами. Когда игрок откатывается к сообщению или
// делает от него ветку, мир берётся отсюда — ровно таким, каким был тогда.
//
// Живёт только в IndexedDB, без копии на диск: это вспомогательный слой. Пропал —
// ветка всё равно соберётся, просто без точного мира (см. branchState).

const MAX_PER_PROJECT = 400;
let writes = 0;

function key(projectId: string, messageId: string): string {
  return `${projectId}:${messageId}`;
}

export async function putTurnState(projectId: string, messageId: string, state: RuntimeState): Promise<void> {
  try {
    const db = await getDB();
    await db.put('turnStates', {
      key: key(projectId, messageId),
      projectId,
      messageId,
      savedAt: Date.now(),
      state: compactState(state),
    });
    if (++writes % 25 === 0) await prune(projectId);
  } catch (e) {
    logEvent('warn', 'save', 'Снимок мира для отката не записался: ' + (e as Error).message);
  }
}

export async function getTurnState(projectId: string, messageId: string | undefined): Promise<RuntimeState | null> {
  if (!messageId) return null;
  try {
    const db = await getDB();
    const rec = await db.get('turnStates', key(projectId, messageId));
    return rec?.state ?? null;
  } catch {
    return null;
  }
}

async function prune(projectId: string): Promise<void> {
  const db = await getDB();
  const all = await db.getAllFromIndex('turnStates', 'byProject', projectId);
  if (all.length <= MAX_PER_PROJECT) return;
  all.sort((a, b) => a.savedAt - b.savedAt);
  for (const rec of all.slice(0, all.length - MAX_PER_PROJECT)) await db.delete('turnStates', rec.key);
}
