import JSZip from 'jszip';
import type { Project } from '../shared/types';
import { getAssetBlob, putAsset, saveProject } from './db';
import { uid } from '../shared/utils';
import { normalizeProject } from '../shared/factory';

// Export project as a single .zip: project.json + assets/<blobKey>
export async function exportProjectZip(project: Project): Promise<Blob> {
  const zip = new JSZip();
  zip.file('project.json', JSON.stringify(project, null, 2));
  const assetsFolder = zip.folder('assets')!;
  for (const asset of project.assets) {
    const blob = await getAssetBlob(asset.blobKey);
    if (blob) assetsFolder.file(asset.blobKey, blob);
  }
  return zip.generateAsync({ type: 'blob' });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export interface ImportResult {
  project: Project;
  warnings: string[];
}

// Лёгкая проверка целостности перед импортом «чужого» проекта (см. CR v2 §L.5):
// отличаем «это вообще не наш проект» от «наш, но нормализация что-то дочинила».
function looksLikeProjectJson(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  return 'meta' in r && 'characters' in r && 'assets' in r && 'aiConfig' in r;
}

// Import: reads zip, re-keys ids to avoid collisions, stores blobs + project.
export async function importProjectZip(file: File): Promise<ImportResult> {
  const zip = await JSZip.loadAsync(file);
  const projFile = zip.file('project.json');
  if (!projFile) throw new Error('project.json не найден в архиве — это не экспорт Novel Forge?');
  const raw = await projFile.async('string');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error('project.json повреждён (невалидный JSON): ' + (e as Error).message);
  }
  if (!looksLikeProjectJson(parsed)) {
    throw new Error('project.json не похож на проект Novel Forge (нет ожидаемых полей).');
  }

  const project = normalizeProject(parsed);
  const warnings: string[] = [];

  // Re-key project id + blobKeys so imports never clobber existing data.
  const newProjectId = uid('proj');
  for (const asset of project.assets) {
    const oldKey = asset.blobKey;
    const newKey = uid('blob');
    const entry = zip.file(`assets/${oldKey}`);
    if (entry) {
      const blob = await entry.async('blob');
      const typed = asset.mime ? new Blob([blob], { type: asset.mime }) : blob;
      await putAsset(newKey, typed);
    } else {
      warnings.push(`Ассет «${asset.name}» — файл в архиве не найден, ссылка будет пустой.`);
    }
    asset.blobKey = newKey;
  }

  project.id = newProjectId;
  project.createdAt = Date.now();
  project.updatedAt = Date.now();
  await saveProject(project);
  return { project, warnings };
}
