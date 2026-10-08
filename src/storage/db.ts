import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Project, SaveSlot, Character, AssetMeta, NarrativeMode, RuntimeState } from '../shared/types';
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
  statTree,
  ledgerMatches,
  ledgerSet,
  readSaveFile,
  warmProjectAssets,
  flushLedger,
} from './fileStore';
import { pushToast, updateToast } from '../shared/toast';

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
  // Архив проектов, когда лаунчера нет: проект целиком одним zip (см. archive.ts).
  archive: {
    key: string; // projectId
    value: { id: string; title: string; mode: string; archivedAt: number; size: number; blob: Blob };
  };
  // Снимки мира по сообщениям ленты (см. turnLedger.ts).
  turnStates: {
    key: string; // `${projectId}:${messageId}`
    value: { key: string; projectId: string; messageId: string; savedAt: number; state: RuntimeState };
    indexes: { byProject: string };
  };
}

let dbPromise: Promise<IDBPDatabase<NovelForgeDB>> | null = null;

export function getDB(): Promise<IDBPDatabase<NovelForgeDB>> {
  if (!dbPromise) {
    dbPromise = openDB<NovelForgeDB>('novel-forge', 3, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          db.createObjectStore('projects', { keyPath: 'id' });
          db.createObjectStore('assets', { keyPath: 'key' });
          const saves = db.createObjectStore('saves', { keyPath: 'key' });
          saves.createIndex('byProject', 'projectId');
        }
        if (oldVersion < 2) {
          const turns = db.createObjectStore('turnStates', { keyPath: 'key' });
          turns.createIndex('byProject', 'projectId');
        }
        if (oldVersion < 3) db.createObjectStore('archive', { keyPath: 'id' });
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

/** Отменить отложенные записи проекта на диск (перед переносом в архив). */
export function cancelDiskWrites(projectId: string): void {
  for (const [k, r] of debouncers) {
    if (!k.includes(`:${projectId}`) && !k.endsWith(projectId)) continue;
    if (r.timer) clearTimeout(r.timer);
    debouncers.delete(k);
  }
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
  // Сейвы и ассеты проекта подтягиваются с диска при первом обращении к нему, а не
  // на старте (см. ensureProjectSynced).
  await ensureProjectSynced(id);
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

// АДАПТАЦИЯ ПРОЕКТА В ДРУГОЙ РЕЖИМ. Делает КОПИЮ, а не переключает флажок: у
// режимов раздельные библиотеки, свои сейвы и своя судьба, и молчаливый переезд
// проекта из одной в другую выглядел бы как пропажа.
//
// Что переезжает: сеттинг, лор, лорбук, персонажи с карточками и статами, свои
// макросы, финансы. Что НЕ переезжает в текстовый РП: спрайты, фоны, музыка, звуки
// и CG — им там негде показаться, и тащить за собой мегабайты картинок незачем.
// Аватарки (ассеты-иконки) остаются: они как раз для ленты переписки.
export async function adaptProjectToMode(
  source: Project,
  mode: NarrativeMode,
  newTitle?: string
): Promise<DuplicateResult> {
  const clone: Project = JSON.parse(JSON.stringify(source));
  clone.id = uid('proj');
  clone.createdAt = Date.now();
  clone.updatedAt = Date.now();
  clone.mode = mode === 'rp' ? 'rp' : undefined;
  clone.meta.title = (newTitle || `${source.meta.title || 'Проект'} — ${mode === 'rp' ? 'РП' : 'новелла'}`).slice(0, 200);

  if (mode === 'rp') {
    clone.assets = clone.assets.filter((a) => a.type === 'icon');
    const keep = new Set(clone.assets.map((a) => a.id));
    clone.characters = clone.characters.map((c) => ({
      ...c,
      sprites: {},
      outfits: undefined,
      defaultOutfit: undefined,
      spriteDisplay: undefined,
    }));
    if (clone.meta.coverAssetId && !keep.has(clone.meta.coverAssetId)) clone.meta.coverAssetId = undefined;
    // Иконки статов — тоже ассеты-иконки, они уцелели; но битую ссылку всё равно чистим.
    clone.stats = clone.stats.map((st) =>
      st.iconAssetId && !keep.has(st.iconAssetId) ? { ...st, iconAssetId: undefined } : st
    );
  }

  let assetsMissing = 0;
  for (const a of clone.assets) {
    const newBlobKey = uid('blob');
    const blob = await getAssetBlob(a.blobKey);
    if (blob) await putAsset(newBlobKey, blob);
    else assetsMissing++;
    a.blobKey = newBlobKey;
  }

  await saveProject(clone);
  // Прогресс не копируем никогда: история новеллы состоит из JSON-ходов со
  // спрайтами и выборами, и в ленте переписки она читалась бы как мусор (и наоборот).
  return { project: clone, savesCopied: 0, assetsMissing };
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
  const turnKeys = await db.getAllKeysFromIndex('turnStates', 'byProject', id);
  for (const k of turnKeys) await db.delete('turnStates', k);
  await db.delete('projects', id);
  if (await mirrorOn()) void deleteProjectFromDisk(id);
}

/**
 * Убрать проект из браузера, НЕ трогая диск (архив): сейвы, снимки мира, сам проект
 * и блобы ассетов, на которые не ссылается ни один другой проект.
 */
export async function removeProjectFromIdb(id: string): Promise<void> {
  const db = await getDB();
  const project = await db.get('projects', id);
  for (const k of await db.getAllKeysFromIndex('saves', 'byProject', id)) await db.delete('saves', k);
  for (const k of await db.getAllKeysFromIndex('turnStates', 'byProject', id)) await db.delete('turnStates', k);
  await db.delete('projects', id);
  if (project) {
    const used = new Set<string>();
    for (const other of await db.getAll('projects')) for (const a of other.assets || []) used.add(a.blobKey);
    for (const a of project.assets) if (!used.has(a.blobKey)) await db.delete('assets', a.blobKey).catch(() => {});
  }
  projectSync.delete(id);
}

/** Положить проект только в браузерную базу (возврат из архива с диска). */
export async function putProjectLocal(project: Project): Promise<void> {
  await putProjectIdb(project);
}

/** Включено ли зеркало на диск (есть лаунчер). */
export async function diskMirrorOn(): Promise<boolean> {
  return mirrorOn();
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
  await ensureProjectSynced(projectId);
  const db = await getDB();
  const all = await db.getAllFromIndex('saves', 'byProject', projectId);
  const project = await getProject(projectId);
  if (!project) return all.sort((a, b) => a.slot - b.slot);
  return all
    .map((s) => ({ ...s, state: normalizeRuntimeState(s.state, project) }))
    .sort((a, b) => a.slot - b.slot);
}

/** Сейвы проекта как лежат в базе — без нормализации и без синхронизации с диском. */
export async function listSavesRaw(projectId: string): Promise<SaveSlot[]> {
  const db = await getDB();
  return db.getAllFromIndex('saves', 'byProject', projectId);
}

export async function deleteSave(projectId: string, slot: number): Promise<void> {
  const db = await getDB();
  await db.delete('saves', `${projectId}:${slot}`);
  if (await mirrorOn()) void deleteSaveFromDisk(projectId, slot);
}

// ---- Синхронизация с диском (файловый источник истины) ----
//
// БЫСТРЫЙ СТАРТ. Раньше при каждом открытии, ДО показа экрана, читались с диска все
// сейвы всех проектов целиком (у каждого прохождения ещё и 15 автоснимков — полных
// копий истории) и переписывались в IndexedDB, даже если там лежало то же самое.
// Чем больше и дольше игры, тем дольше белый экран.
//
// Теперь на старте — только карточки проектов (project.json), и то лишь изменившиеся.
// Сейвы и ассеты проекта подтягиваются, когда к проекту обращаются (ensureProjectSynced),
// и читаются только файлы, которых нет в журнале (см. fileStore: ledger). Последний
// проект, в который играли, синхронизируется в фоне сразу после показа экрана.

/** Есть ли в браузере хоть один проект: если нет, старт ждёт диска (иначе пустая библиотека). */
export async function hasLocalProjects(): Promise<boolean> {
  const db = await getDB();
  return (await db.count('projects')) > 0;
}

let latestDiskProject: string | null = null;

export async function syncStorage(): Promise<void> {
  if (!(await dataApiAvailable())) {
    mirrorEnabled = false;
    logDisk('Файловый сервер недоступен — работаем только на IndexedDB (открыто без лаунчера).');
    return;
  }
  mirrorEnabled = true;
  const t0 = Date.now();
  try {
    const diskIds = await listDiskProjectIds();
    const diskSet = new Set(diskIds);
    const db = await getDB();

    // 1) Миграция IndexedDB → диск (то, чего на диске ещё нет).
    for (const raw of await db.getAll('projects')) {
      if (!diskSet.has(raw.id)) {
        const p = normalizeProject(raw);
        await saveProjectToDisk(p);
        for (const s of await listSavesRaw(p.id)) await saveSaveToDisk(s);
        logDisk(`Миграция на диск: «${p.meta.title}»`);
      }
    }

    // 2) Карточки проектов с диска — только изменившиеся.
    let read = 0;
    let latestAt = 0;
    for (const id of diskIds) {
      const files = await statTree(id);
      if (!files) {
        // Старый лаунчер без размеров и времени — по-старому, целиком.
        await syncProjectFully(id);
        read++;
        continue;
      }
      for (const f of files) {
        if (f.f.startsWith('saves/') && f.mtime > latestAt) {
          latestAt = f.mtime;
          latestDiskProject = id;
        }
      }
      const pj = files.find((f) => f.f === 'project.json');
      if (!pj) continue;
      const have = await db.getKey('projects', id);
      if (have && ledgerMatches(id, 'project.json', pj.size, pj.mtime)) continue;
      const dp = await loadProjectFromDisk(id, { warmAssets: false });
      if (!dp) continue;
      await putProjectIdb(dp);
      // Обложку — сразу, чтобы карточка в библиотеке была с картинкой.
      await warmProjectAssets(dp, (a) => a.id === dp.meta.coverAssetId);
      ledgerSet(id, 'project.json', pj.size, pj.mtime);
      read++;
    }
    flushLedger();
    logDisk(`Старт: ${diskIds.length} проектов на диске, прочитано карточек: ${read}, за ${Date.now() - t0} мс.`);
  } catch (e) {
    logDisk('Ошибка синхронизации с диском: ' + (e as Error).message);
  }
}

/** Проект, в который играли последним (по времени сейвов на диске), — для фоновой подгрузки. */
export function latestProjectOnDisk(): string | null {
  return latestDiskProject;
}

// Старое поведение — для лаунчера, который не отдаёт размеры и время файлов.
async function syncProjectFully(id: string): Promise<void> {
  const db = await getDB();
  const dp = await loadProjectFromDisk(id);
  if (!dp) return;
  await putProjectIdb(dp);
  for (const ds of await readSavesFromDisk(id)) {
    const cur = await db.get('saves', `${ds.projectId}:${ds.slot}`);
    if (!cur || (ds.savedAt || 0) > ((cur as any).savedAt || 0)) await putSaveIdb(ds);
  }
}

const projectSync = new Map<string, Promise<void>>();

/**
 * Сейвы и ассеты проекта с диска — один раз за сеанс и только изменившиеся файлы.
 * Новее в браузере (ещё не долетело до диска) — остаётся браузерное.
 */
export function ensureProjectSynced(id: string): Promise<void> {
  const known = projectSync.get(id);
  if (known) return known;
  const job = (async () => {
    if (!(await mirrorOn())) return;
    const files = await statTree(id);
    if (!files) return; // старый лаунчер: проект уже прочитан целиком на старте
    const db = await getDB();
    const t0 = Date.now();
    let toastId: string | null = null;
    const slow = setTimeout(() => {
      toastId = pushToast('info', 'Загружаю историю с диска…');
    }, 400);
    let read = 0;
    try {
      for (const f of files) {
        if (!/^saves\/.+\.jsonl$/.test(f.f)) continue;
        const slot = Number(f.f.slice('saves/'.length, -'.jsonl'.length));
        if (!Number.isFinite(slot)) continue;
        const key = `${id}:${slot}`;
        if (ledgerMatches(id, f.f, f.size, f.mtime) && (await db.getKey('saves', key))) continue;
        const ds = await readSaveFile(id, f.f);
        read++;
        if (!ds) continue;
        const cur = await db.get('saves', key);
        if (!cur || (ds.savedAt || 0) > ((cur as any).savedAt || 0)) await putSaveIdb(ds);
        ledgerSet(id, f.f, f.size, f.mtime);
      }
      const raw = await db.get('projects', id);
      if (raw) await warmProjectAssets(normalizeProject(raw));
      if (read) logDisk(`Проект ${id}: с диска прочитано сейвов ${read} за ${Date.now() - t0} мс.`);
    } finally {
      flushLedger();
      clearTimeout(slow);
      if (toastId) updateToast(toastId, 'success', 'История загружена');
    }
  })().catch((e) => {
    projectSync.delete(id); // в следующий раз попробуем снова
    logDisk('Не удалось подтянуть проект с диска: ' + (e as Error).message);
  });
  projectSync.set(id, job);
  return job;
}

/** Забыть, что проект синхронизирован (после возврата из архива). */
export function forgetProjectSync(id: string): void {
  projectSync.delete(id);
}
