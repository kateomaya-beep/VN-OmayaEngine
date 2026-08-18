import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Project, SaveSlot, Character, AssetMeta } from '../shared/types';
import { normalizeProject, normalizeRuntimeState } from '../shared/factory';
import { uid } from '../shared/utils';
import {
  dataApiAvailable,
  saveProjectToDisk,
  loadProjectFromDisk,
  deleteProjectFromDisk,
  listDiskProjectIds,
  saveSaveToDisk,
  readSavesFromDisk,
  deleteSaveFromDisk,
  logDisk,
} from './fileStore';

interface NovelForgeDB extends DBSchema {
  projects: {
    key: string;
    value: Project;
  };
  assets: {
    key: string; // blobKey
    value: { key: string; blob: Blob; mime: string };
  };
  saves: {
    key: string; // `${projectId}:${slot}`
    value: SaveSlot & { key: string };
    indexes: { byProject: string };
  };
}

let dbPromise: Promise<IDBPDatabase<NovelForgeDB>> | null = null;

export function getDB(): Promise<IDBPDatabase<NovelForgeDB>> {
  if (!dbPromise) {
    dbPromise = openDB<NovelForgeDB>('novel-forge', 1, {
      upgrade(db) {
        db.createObjectStore('projects', { keyPath: 'id' });
        db.createObjectStore('assets', { keyPath: 'key' });
        const saves = db.createObjectStore('saves', { keyPath: 'key' });
        saves.createIndex('byProject', 'projectId');
      },
    });
  }
  return dbPromise;
}

// ---- Троттлинг записи на диск ----
// Диск — источник истины, но частые автосейвы не должны долбить его на каждый чих.
// Debounce с трейлингом на ключ: коалесцируем всплеск, но САМАЯ СВЕЖАЯ задача всегда
// в итоге выполняется (потери максимум на окно debounce, а IndexedDB держит текущее).
const debouncers = new Map<string, { last: number; timer: any; latest: (() => Promise<void>) | null }>();
function diskDebounce(key: string, task: () => Promise<void>, ms: number): void {
  let r = debouncers.get(key);
  if (!r) {
    r = { last: 0, timer: null, latest: null };
    debouncers.set(key, r);
  }
  r.latest = task;
  const fire = () => {
    const t = r!.latest;
    r!.latest = null;
    r!.last = Date.now();
    r!.timer = null;
    if (t) t().catch((e) => logDisk('Запись на диск не удалась: ' + (e as Error).message));
  };
  if (r.timer) return; // всплеск — обновили latest, запись уже запланирована
  const elapsed = Date.now() - r.last;
  if (elapsed >= ms) fire();
  else r.timer = setTimeout(fire, ms - elapsed);
}

let mirrorEnabled: boolean | null = null;
async function mirrorOn(): Promise<boolean> {
  if (mirrorEnabled === null) mirrorEnabled = await dataApiAvailable();
  return mirrorEnabled;
}

// ---- Projects ----

export async function listProjects(): Promise<Project[]> {
  const db = await getDB();
  const all = await db.getAll('projects');
  return all.map(normalizeProject).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getProject(id: string): Promise<Project | undefined> {
  const db = await getDB();
  const raw = await db.get('projects', id);
  return raw ? normalizeProject(raw) : undefined;
}

// Только IndexedDB (без зеркала на диск) — для внутреннего использования и sync.
async function putProjectIdb(project: Project): Promise<void> {
  const db = await getDB();
  await db.put('projects', project);
}

export async function saveProject(project: Project): Promise<void> {
  project.updatedAt = Date.now();
  await putProjectIdb(project);
  if (await mirrorOn()) {
    const snap: Project = JSON.parse(JSON.stringify(project));
    diskDebounce(`proj:${project.id}`, () => saveProjectToDisk(snap), 1200);
  }
}

// Полная независимая копия проекта (игры) — «вторая история на тех же данных».
// Новый id проекта, СКОПИРОВАННЫЕ blob'ы под новыми ключами (чтобы удаление копии не
// задело оригинал и наоборот). id ассетов и персонажей НАМЕРЕННО сохраняются: на них
// ссылается всё остальное — обложка, спрайты, иконки статов, референсы и галерея
// CG-студии, обои и аватарки телефона, а в сейвах ещё и фон сцены, играющий трек,
// вложения в переписке. id проектно-локальные, конфликтовать между проектами им негде,
// зато перенумерация требовала бы вручную перепривязать КАЖДУЮ такую ссылку — и раньше
// половина из них (референсы CG, галерея, телефон) действительно терялась при копии.
// includeProgress=true переносит и прохождения (все сейвы) — копия продолжается с того
// же места, но дальше живёт своей жизнью.
export interface DuplicateResult {
  project: Project;
  savesCopied: number;
  assetsMissing: number; // ассеты, чей файл не нашёлся (ссылка останется пустой)
}

export async function duplicateProject(
  source: Project,
  newTitle?: string,
  opts: { includeProgress?: boolean } = {}
): Promise<DuplicateResult> {
  const clone: Project = JSON.parse(JSON.stringify(source));
  clone.id = uid('proj');
  clone.createdAt = Date.now();
  clone.updatedAt = Date.now();
  clone.meta.title = (newTitle || `${source.meta.title || 'Проект'} (копия)`).slice(0, 200);

  let assetsMissing = 0;
  for (const a of clone.assets) {
    const newBlobKey = uid('blob');
    const blob = await getAssetBlob(a.blobKey);
    if (blob) await putAsset(newBlobKey, blob);
    else assetsMissing++;
    // Ключ меняем даже когда файла нет: оставить старый — значит связать копию с
    // blob'ом оригинала, и удаление оригинала выбило бы картинки из копии.
    a.blobKey = newBlobKey;
  }

  await saveProject(clone);

  let savesCopied = 0;
  if (opts.includeProgress) {
    for (const s of await listSaves(source.id)) {
      // Слот и все метаданные прохождения сохраняем как есть: ключ записи включает
      // projectId, так что пересечься с оригиналом слоты не могут.
      const { key: _key, ...rest } = s as SaveSlot & { key?: string };
      await putSave({ ...rest, projectId: clone.id });
      savesCopied++;
    }
  }

  return { project: clone, savesCopied, assetsMissing };
}

// Перенос персонажа в другой проект. Спрайты копируются как НОВЫЕ blob'ы + ассеты
// (по образцу duplicateProject): переиспользовать blobKey нельзя — удаление
// исходного проекта стёрло бы картинки и в проекте-получателе.
export async function copyCharacterToProject(
  source: Project,
  characterId: string,
  targetProjectId: string
): Promise<{ ok: boolean; error?: string }> {
  const character = source.characters.find((c) => c.id === characterId);
  if (!character) return { ok: false, error: 'Персонаж не найден' };
  const target = await getProject(targetProjectId);
  if (!target) return { ok: false, error: 'Проект-получатель не найден' };

  const clone: Character = JSON.parse(JSON.stringify(character));
  clone.id = uid('char');
  // Протагонист в проекте может быть только один — переносим как важного персонажа.
  if (clone.role === 'protagonist' && target.characters.some((c) => c.role === 'protagonist')) {
    clone.role = 'important_character';
  }
  // Имя-дубль — помечаем, чтобы в списке было видно, что это перенос.
  if (target.characters.some((c) => c.name.trim().toLowerCase() === clone.name.trim().toLowerCase())) {
    clone.name = `${clone.name} (копия)`;
  }

  // Копируем задействованные ассеты-спрайты под новыми ключами.
  const assetCache = new Map<string, string>(); // старый assetId → новый assetId
  const copyAsset = async (oldAssetId: string): Promise<string | undefined> => {
    if (assetCache.has(oldAssetId)) return assetCache.get(oldAssetId);
    const meta = source.assets.find((a) => a.id === oldAssetId);
    if (!meta) return undefined;
    const blob = await getAssetBlob(meta.blobKey);
    if (!blob) return undefined;
    const newBlobKey = uid('blob');
    await putAsset(newBlobKey, blob);
    const newMeta: AssetMeta = { ...meta, id: uid('asset'), blobKey: newBlobKey };
    target.assets.push(newMeta);
    assetCache.set(oldAssetId, newMeta.id);
    return newMeta.id;
  };
  const remapSprites = async (m: Record<string, string>) => {
    for (const k of Object.keys(m)) {
      const next = await copyAsset(m[k]);
      if (next) m[k] = next;
      else delete m[k]; // битая ссылка — не тащим в новый проект
    }
  };
  await remapSprites(clone.sprites as Record<string, string>);
  for (const o of clone.outfits || []) await remapSprites(o.sprites as Record<string, string>);

  target.characters.push(clone);
  await saveProject(target);
  return { ok: true };
}

/**
 * Перенос ТОЛЬКО СПРАЙТОВ на уже существующего персонажа в другом проекте.
 * Личность не едет: имя, карточка, роль и отношения получателя остаются его
 * собственными — меняются картинки, наряды и личная подгонка спрайта.
 * Нужен, когда персонаж в новом проекте другой человек, а рисовки те же.
 */
export async function copySpritesToCharacter(
  source: Project,
  characterId: string,
  targetProjectId: string,
  targetCharacterId: string
): Promise<{ ok: boolean; error?: string }> {
  const from = source.characters.find((c) => c.id === characterId);
  if (!from) return { ok: false, error: 'Персонаж-источник не найден' };
  const target = await getProject(targetProjectId);
  if (!target) return { ok: false, error: 'Проект-получатель не найден' };
  const to = target.characters.find((c) => c.id === targetCharacterId);
  if (!to) return { ok: false, error: 'Персонаж-получатель не найден' };

  const assetCache = new Map<string, string>();
  const copyAsset = async (oldAssetId: string): Promise<string | undefined> => {
    if (assetCache.has(oldAssetId)) return assetCache.get(oldAssetId);
    const meta = source.assets.find((a) => a.id === oldAssetId);
    if (!meta) return undefined;
    const blob = await getAssetBlob(meta.blobKey);
    if (!blob) return undefined;
    const newBlobKey = uid('blob');
    await putAsset(newBlobKey, blob);
    const newMeta: AssetMeta = { ...meta, id: uid('asset'), blobKey: newBlobKey };
    target.assets.push(newMeta);
    assetCache.set(oldAssetId, newMeta.id);
    return newMeta.id;
  };
  const remap = async (m: Record<string, string>) => {
    const out: Record<string, string> = {};
    for (const k of Object.keys(m)) {
      const next = await copyAsset(m[k]);
      if (next) out[k] = next; // битую ссылку не тащим
    }
    return out;
  };

  const sprites = await remap((from.sprites || {}) as Record<string, string>);
  if (!Object.keys(sprites).length && !(from.outfits || []).length) {
    return { ok: false, error: 'У персонажа-источника нет спрайтов' };
  }
  const outfits: NonNullable<Character['outfits']> = [];
  for (const o of from.outfits || []) {
    outfits.push({ ...o, sprites: (await remap(o.sprites as Record<string, string>)) as Character['sprites'] });
  }

  // Прежние спрайты получателя отвязываем, но ассеты НЕ удаляем: они могут быть
  // нужны где-то ещё (галерея, другой наряд), а чистка ассетов — отдельная операция.
  to.sprites = sprites as Character['sprites'];
  to.outfits = outfits.length ? outfits : undefined;
  to.defaultOutfit = from.defaultOutfit;
  // Личную подгонку тащим вместе с картинками: она подгоняет именно ЭТИ рисовки.
  to.spriteDisplay = from.spriteDisplay ? { ...from.spriteDisplay } : undefined;

  await saveProject(target);
  return { ok: true };
}

export async function deleteProject(id: string): Promise<void> {
  const db = await getDB();
  const project = await db.get('projects', id);
  if (project) {
    for (const asset of project.assets) {
      await db.delete('assets', asset.blobKey).catch(() => {});
    }
  }
  const saveKeys = await db.getAllKeysFromIndex('saves', 'byProject', id);
  for (const k of saveKeys) await db.delete('saves', k);
  await db.delete('projects', id);
  if (await mirrorOn()) void deleteProjectFromDisk(id);
}

// ---- Assets (blobs) ----

export async function putAsset(key: string, blob: Blob): Promise<void> {
  const db = await getDB();
  await db.put('assets', { key, blob, mime: blob.type });
}

export async function getAssetBlob(key: string): Promise<Blob | undefined> {
  const db = await getDB();
  const rec = await db.get('assets', key);
  return rec?.blob;
}

export async function deleteAsset(key: string): Promise<void> {
  const db = await getDB();
  await db.delete('assets', key);
  // Файлы ассетов на диске чистятся при следующем saveProjectToDisk (по факту диффа).
}

// ---- Saves ----

async function putSaveIdb(save: SaveSlot): Promise<void> {
  const db = await getDB();
  await db.put('saves', { ...save, key: `${save.projectId}:${save.slot}` });
}

export async function putSave(save: SaveSlot): Promise<void> {
  await putSaveIdb(save);
  if (await mirrorOn()) {
    const snap: SaveSlot = JSON.parse(JSON.stringify(save));
    diskDebounce(`save:${save.projectId}:${save.slot}`, () => saveSaveToDisk(snap), 1500);
  }
}

export async function listSaves(projectId: string): Promise<SaveSlot[]> {
  const db = await getDB();
  const all = await db.getAllFromIndex('saves', 'byProject', projectId);
  const project = await getProject(projectId);
  if (!project) return all.sort((a, b) => a.slot - b.slot);
  return all
    .map((s) => ({ ...s, state: normalizeRuntimeState(s.state, project) }))
    .sort((a, b) => a.slot - b.slot);
}

export async function deleteSave(projectId: string, slot: number): Promise<void> {
  const db = await getDB();
  await db.delete('saves', `${projectId}:${slot}`);
  if (await mirrorOn()) void deleteSaveFromDisk(projectId, slot);
}

// ---- Синхронизация с диском (файловый источник истины) ----
// Вызывается один раз при старте. Аддитивно: IndexedDB остаётся рабочим слоем.
// 1) Проекты только в IndexedDB → мигрируем на диск (существующие тест-проекты).
// 2) Проекты с диска → прогреваем IndexedDB (диск переживает очистку браузера).
// 3) Сейвы сверяем по времени: где новее — то и оставляем (защита от debounce-окна).
export async function syncStorage(): Promise<void> {
  if (!(await dataApiAvailable())) {
    mirrorEnabled = false;
    logDisk('Файловый сервер недоступен — работаем только на IndexedDB (открыто без лаунчера).');
    return;
  }
  mirrorEnabled = true;
  try {
    const diskIds = await listDiskProjectIds();
    const diskSet = new Set(diskIds);
    const idbProjects = await listProjects();

    // 1) Миграция IndexedDB → диск (то, чего на диске ещё нет).
    for (const p of idbProjects) {
      if (!diskSet.has(p.id)) {
        await saveProjectToDisk(p);
        for (const s of await listSaves(p.id)) await saveSaveToDisk(s);
        logDisk(`Миграция на диск: «${p.meta.title}»`);
      }
    }

    // 2) Загрузка с диска → IndexedDB (диск — источник истины).
    const db = await getDB();
    for (const id of diskIds) {
      const dp = await loadProjectFromDisk(id);
      if (!dp) continue;
      await putProjectIdb(dp);
      // 3) Сейвы: диск, но если в IndexedDB новее — оставляем новее.
      const diskSaves = await readSavesFromDisk(id);
      for (const ds of diskSaves) {
        const cur = await db.get('saves', `${ds.projectId}:${ds.slot}`);
        if (!cur || (ds.savedAt || 0) >= ((cur as any).savedAt || 0)) await putSaveIdb(ds);
      }
    }
    logDisk(`Синхронизация с диском завершена (${diskIds.length} проектов на диске).`);
  } catch (e) {
    logDisk('Ошибка синхронизации с диском: ' + (e as Error).message);
  }
}
