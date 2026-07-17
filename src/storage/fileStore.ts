import type { Project, SaveSlot, AssetMeta, RuntimeState, LlmMessage } from '../shared/types';
import { getAssetBlob, putAsset } from './db';
import { normalizeProject } from '../shared/factory';
import { logEvent } from '../shared/logStore';

// Файловое хранилище (источник истины на диске, как папка data/ у SillyTavern).
// Работает поверх локального сервера (launcher/serve.mjs, эндпоинты /__data/*).
// IndexedDB остаётся быстрым кэшем; этот модуль зеркалит проекты/ассеты/сейвы в
// реальные файлы, чтобы очистка данных браузера не уносила прогресс.
//
// Раскладка (близко к ST):
//   <projectId>/
//     project.json                       — метаданные/лор/статы/конфиг/персонажи/ассеты(мета)
//     characters/<имя>/expressions/<эмоция>.<ext>
//     backgrounds|music|cg|sfx|icons/<имя>-<id>.<ext>
//     saves/<slot>.jsonl                 — построчный формат (meta + state + history по строкам)

let dataState: 'unknown' | 'on' | 'off' = 'unknown';
let dataProbe: Promise<void> | null = null;

export async function dataApiAvailable(): Promise<boolean> {
  if (dataState === 'unknown') {
    if (!dataProbe) {
      dataProbe = (async () => {
        try {
          const r = await fetch('/__data/health', { method: 'GET' });
          dataState = r.ok && r.headers.get('x-vn-data') === '1' ? 'on' : 'off';
        } catch {
          dataState = 'off';
        }
      })();
    }
    await dataProbe;
  }
  return dataState === 'on';
}

// ---- low-level file ops ----
const enc = (s: string) => new TextEncoder().encode(s);
function fpath(id: string, rel: string): string {
  return `/__data/f/${encodeURIComponent(id)}/${rel.split('/').map(encodeURIComponent).join('/')}`;
}
async function putBytes(id: string, rel: string, bytes: BlobPart): Promise<void> {
  const r = await fetch(fpath(id, rel), { method: 'PUT', body: bytes as BodyInit });
  if (!r.ok) throw new Error(`disk write failed ${rel}: ${r.status}`);
}
async function getBytes(id: string, rel: string): Promise<ArrayBuffer | null> {
  const r = await fetch(fpath(id, rel), { method: 'GET' });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`disk read failed ${rel}: ${r.status}`);
  return await r.arrayBuffer();
}
async function delFile(id: string, rel: string): Promise<void> {
  await fetch(fpath(id, rel), { method: 'DELETE' }).catch(() => {});
}
async function tree(id: string): Promise<string[]> {
  const r = await fetch(`/__data/tree/${encodeURIComponent(id)}`);
  if (!r.ok) return [];
  return (await r.json()).files || [];
}
export async function listDiskProjectIds(): Promise<string[]> {
  const r = await fetch('/__data/projects');
  if (!r.ok) return [];
  return (await r.json()).ids || [];
}
export async function deleteProjectFromDisk(id: string): Promise<void> {
  await fetch(`/__data/p/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
}

// ---- asset path derivation ----
const MIME_EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp',
  'image/gif': 'gif', 'image/svg+xml': 'svg', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
  'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/webm': 'webm',
};
function safe(s: string): string {
  return (s || '').replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'x';
}
function extOf(a: AssetMeta): string {
  if (a.mime && MIME_EXT[a.mime]) return MIME_EXT[a.mime];
  const m = /\.([a-z0-9]{1,5})$/i.exec(a.name || '');
  return m ? m[1].toLowerCase() : 'bin';
}
const ASSET_DIRS = ['backgrounds/', 'music/', 'cg/', 'sfx/', 'icons/', 'sprites/', 'characters/'];
const TYPE_DIR: Record<string, string> = {
  background: 'backgrounds', music: 'music', cg: 'cg', sfx: 'sfx', icon: 'icons', sprite: 'sprites',
};

// Карта assetId → путь спрайта эмоции (characters/<имя>/expressions/<эмоция>.<ext>).
function spriteMap(project: Project): Map<string, string> {
  const byId = new Map(project.assets.map((a) => [a.id, a]));
  const map = new Map<string, string>();
  for (const c of project.characters) {
    const dir = safe(c.name) || c.id;
    // Дефолтный наряд: characters/<имя>/expressions/<эмоция>.<ext> (без изменений).
    for (const [emotion, assetId] of Object.entries(c.sprites || {})) {
      const a = assetId ? byId.get(assetId) : undefined;
      if (!a) continue;
      map.set(a.id, `characters/${dir}/expressions/${safe(emotion)}.${extOf(a)}`);
    }
    // Доп. наряды (Batch 5.3): characters/<имя>/outfits/<наряд>/<эмоция>.<ext>.
    for (const o of c.outfits || []) {
      for (const [emotion, assetId] of Object.entries(o.sprites || {})) {
        const a = assetId ? byId.get(assetId) : undefined;
        if (!a) continue;
        map.set(a.id, `characters/${dir}/outfits/${safe(o.outfit)}/${safe(emotion)}.${extOf(a)}`);
      }
    }
  }
  return map;
}
function assetRelPath(a: AssetMeta, sprites: Map<string, string>): string {
  const s = sprites.get(a.id);
  if (s) return s;
  const dir = TYPE_DIR[a.type] || 'assets';
  return `${dir}/${safe(a.name)}-${a.id.slice(-6)}.${extOf(a)}`;
}

// ---- Project <-> disk ----
export async function saveProjectToDisk(project: Project): Promise<void> {
  const id = project.id;
  const sprites = spriteMap(project);
  const desired = new Map<string, AssetMeta>(); // relpath -> asset
  for (const a of project.assets) desired.set(assetRelPath(a, sprites), a);

  const existing = await tree(id);
  const existingAssetFiles = existing.filter((f) => ASSET_DIRS.some((d) => f.startsWith(d)));

  // project.json — вся структура (мета/лор/статы/персонажи/мета ассетов), без блобов.
  await putBytes(id, 'project.json', enc(JSON.stringify(project, null, 2)));

  // Пишем недостающие файлы ассетов (блобы берём из IndexedDB).
  for (const [rel, a] of desired) {
    if (existing.includes(rel)) continue; // уже на диске
    const blob = await getAssetBlob(a.blobKey);
    if (!blob) continue;
    await putBytes(id, rel, blob);
  }
  // Чистим «осиротевшие» файлы ассетов (удалённые из проекта).
  for (const f of existingAssetFiles) {
    if (!desired.has(f)) await delFile(id, f);
  }
}

export async function loadProjectFromDisk(id: string): Promise<Project | null> {
  const buf = await getBytes(id, 'project.json');
  if (!buf) return null;
  let raw: any;
  try {
    raw = JSON.parse(new TextDecoder().decode(buf));
  } catch {
    return null;
  }
  const project = normalizeProject(raw);
  const sprites = spriteMap(project);
  // Прогреваем IndexedDB блобами ассетов из файлов — но только те, которых в кэше
  // ещё нет (тёплый кэш → быстрый старт; читаем файлы только после очистки данных).
  for (const a of project.assets) {
    try {
      if (await getAssetBlob(a.blobKey)) continue;
      const bytes = await getBytes(id, assetRelPath(a, sprites));
      if (bytes) await putAsset(a.blobKey, new Blob([bytes], { type: a.mime || 'application/octet-stream' }));
    } catch {
      /* нет файла — ассет просто не отобразится, проект не падает */
    }
  }
  return project;
}

// ---- Saves (JSONL) ----
// Формат: строка meta + строка head(state без history) + по строке на сообщение
// истории. Повреждение затрагивает максимум одну строку, а не весь сейв.
function saveToJsonl(save: SaveSlot): string {
  const { history, ...head } = save.state as RuntimeState;
  const lines: string[] = [];
  lines.push(
    JSON.stringify({
      t: 'meta',
      slot: save.slot,
      projectId: save.projectId,
      title: save.title,
      savedAt: save.savedAt,
      // Batch 5.2 — метаданные прохождения/чекпоинта (сохраняются в durable-слое).
      kind: save.kind,
      playthroughId: save.playthroughId,
      playthroughLabel: save.playthroughLabel,
      playthroughCreatedAt: save.playthroughCreatedAt,
      checkpointId: save.checkpointId,
      parentCheckpointId: save.parentCheckpointId,
      branchName: save.branchName,
    })
  );
  lines.push(JSON.stringify({ t: 'head', state: head }));
  for (const m of history) lines.push(JSON.stringify({ t: 'h', m }));
  return lines.join('\n') + '\n';
}
function jsonlToSave(text: string): SaveSlot | null {
  let meta: any = null;
  let head: any = null;
  const history: LlmMessage[] = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let obj: any;
    try {
      obj = JSON.parse(s);
    } catch {
      continue; // битую строку пропускаем, остальные читаем
    }
    if (obj.t === 'meta') meta = obj;
    else if (obj.t === 'head') head = obj.state;
    else if (obj.t === 'h' && obj.m) history.push(obj.m);
  }
  if (!meta || !head) return null;
  return {
    slot: meta.slot,
    projectId: meta.projectId,
    title: meta.title || '',
    savedAt: meta.savedAt || Date.now(),
    kind: meta.kind,
    playthroughId: meta.playthroughId,
    playthroughLabel: meta.playthroughLabel,
    playthroughCreatedAt: meta.playthroughCreatedAt,
    checkpointId: meta.checkpointId,
    parentCheckpointId: meta.parentCheckpointId,
    branchName: meta.branchName,
    state: { ...head, history } as RuntimeState,
  };
}

export async function saveSaveToDisk(save: SaveSlot): Promise<void> {
  await putBytes(save.projectId, `saves/${save.slot}.jsonl`, enc(saveToJsonl(save)));
}
export async function readSavesFromDisk(id: string): Promise<SaveSlot[]> {
  const files = (await tree(id)).filter((f) => /^saves\/.+\.jsonl$/.test(f));
  const out: SaveSlot[] = [];
  for (const f of files) {
    const buf = await getBytes(id, f);
    if (!buf) continue;
    const s = jsonlToSave(new TextDecoder().decode(buf));
    if (s) out.push(s);
  }
  return out.sort((a, b) => a.slot - b.slot);
}
export async function deleteSaveFromDisk(id: string, slot: number): Promise<void> {
  await delFile(id, `saves/${slot}.jsonl`);
}

// Диагностика.
export function logDisk(msg: string): void {
  logEvent('info', 'disk', msg);
}
