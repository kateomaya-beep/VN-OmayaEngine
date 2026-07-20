import type { SaveSlot } from '../shared/types';
import { listSaves, deleteSave } from './db';

// Batch 5.2 — прохождения/чекпоинты поверх durable-сейвов. Реестр НЕ хранится
// отдельно: он выводится из самих записей сейвов (они уже durable — IndexedDB + диск),
// поэтому переживает очистку браузера так же, как обычные сейвы.

export const LEGACY_PLAYTHROUGH = 'legacy';

export interface PlaythroughInfo {
  id: string;
  label: string;
  createdAt: number;
  autosave: SaveSlot | null; // курсор «последнее состояние» (может отсутствовать у legacy-без-slot0)
  autosnaps: SaveSlot[]; // кольцо последних автосейвов (история), новые первыми
  checkpoints: SaveSlot[]; // ручные ветки, по времени
  lastSavedAt: number; // для выбора активного прохождения
}

function bucketId(s: SaveSlot): string {
  return s.playthroughId || LEGACY_PLAYTHROUGH;
}

// Является ли запись автосейв-курсором прохождения (а не чекпоинтом/автоснимком).
function isAutosave(s: SaveSlot): boolean {
  if (s.kind === 'checkpoint' || s.kind === 'autosnap') return false;
  if (s.kind === 'autosave') return true;
  // Легаси без kind: слот 0 — это старый автосейв; прочие числовые слоты — ручные
  // сейвы старой системы, показываем как чекпоинты legacy-прохождения.
  return !s.playthroughId && s.slot === 0;
}

export async function listPlaythroughs(projectId: string): Promise<PlaythroughInfo[]> {
  const saves = await listSaves(projectId);
  const groups = new Map<string, SaveSlot[]>();
  for (const s of saves) {
    const id = bucketId(s);
    const g = groups.get(id);
    if (g) g.push(s);
    else groups.set(id, [s]);
  }

  const infos: PlaythroughInfo[] = [];
  for (const [id, recs] of groups) {
    const autosave = recs.find(isAutosave) || null;
    const autosnaps = recs
      .filter((s) => s.kind === 'autosnap')
      .sort((a, b) => b.savedAt - a.savedAt); // новые первыми
    const checkpoints = recs
      .filter((s) => !isAutosave(s) && s.kind !== 'autosnap')
      .sort((a, b) => a.savedAt - b.savedAt);
    const label =
      autosave?.playthroughLabel ||
      (id === LEGACY_PLAYTHROUGH ? 'Прежнее прохождение' : 'Прохождение');
    const createdAt =
      autosave?.playthroughCreatedAt ??
      Math.min(...recs.map((r) => r.savedAt), autosave?.savedAt ?? Date.now());
    const lastSavedAt = Math.max(...recs.map((r) => r.savedAt), 0);
    infos.push({ id, label, createdAt, autosave, autosnaps, checkpoints, lastSavedAt });
  }
  // Активное (для «Продолжить») — с самым свежим сохранением — первым.
  return infos.sort((a, b) => b.lastSavedAt - a.lastSavedAt);
}

// Активное прохождение = с самым свежим сохранением.
export async function activePlaythrough(projectId: string): Promise<PlaythroughInfo | null> {
  const all = await listPlaythroughs(projectId);
  return all[0] || null;
}

export async function hasAnyProgress(projectId: string): Promise<boolean> {
  return (await listSaves(projectId)).length > 0;
}

// Удалить целиком прохождение: его автосейв-курсор и все чекпоинты.
export async function deletePlaythrough(projectId: string, info: PlaythroughInfo): Promise<void> {
  const slots = [...info.checkpoints.map((c) => c.slot), ...info.autosnaps.map((a) => a.slot)];
  if (info.autosave) slots.push(info.autosave.slot);
  for (const slot of slots) await deleteSave(projectId, slot);
}

// Удалить все прохождения проекта (для «Начать заново → удалить старый прогресс»).
export async function deleteAllPlaythroughs(projectId: string): Promise<void> {
  for (const s of await listSaves(projectId)) await deleteSave(projectId, s.slot);
}
