import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Project, SaveSlot } from '../shared/types';
import { normalizeProject, normalizeRuntimeState } from '../shared/factory';

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

export async function saveProject(project: Project): Promise<void> {
  const db = await getDB();
  project.updatedAt = Date.now();
  await db.put('projects', project);
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
}

// ---- Saves ----

export async function putSave(save: SaveSlot): Promise<void> {
  const db = await getDB();
  await db.put('saves', { ...save, key: `${save.projectId}:${save.slot}` });
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

export async function getSave(projectId: string, slot: number): Promise<SaveSlot | undefined> {
  const db = await getDB();
  const raw = await db.get('saves', `${projectId}:${slot}`);
  if (!raw) return undefined;
  const project = await getProject(projectId);
  if (!project) return raw;
  return { ...raw, state: normalizeRuntimeState(raw.state, project) };
}

export async function deleteSave(projectId: string, slot: number): Promise<void> {
  const db = await getDB();
  await db.delete('saves', `${projectId}:${slot}`);
}
