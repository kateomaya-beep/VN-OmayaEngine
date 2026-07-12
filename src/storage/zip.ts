import JSZip from 'jszip';
import type { Project, SaveSlot } from '../shared/types';
import { getAssetBlob, putAsset, saveProject, listSaves, putSave } from './db';
import { uid } from '../shared/utils';
import { normalizeProject } from '../shared/factory';

// Export project as a single .zip: project.json + assets/<blobKey>.
// includeProgress=true также кладёт saves.json — все сохранения (автосейв + слоты):
// история, статусы, отношения, память, Game Master, календарь/события. Это ПОЛНЫЙ
// бэкап прохождения. Без прогресса — чистый проект «для новых игроков» / для шаринга.
export async function exportProjectZip(
  project: Project,
  opts: { includeProgress?: boolean } = {}
): Promise<Blob> {
  const zip = new JSZip();
  zip.file('project.json', JSON.stringify(project, null, 2));
  const assetsFolder = zip.folder('assets')!;
  for (const asset of project.assets) {
    const blob = await getAssetBlob(asset.blobKey);
    if (blob) assetsFolder.file(asset.blobKey, blob);
  }
  if (opts.includeProgress) {
    const saves = await listSaves(project.id);
    if (saves.length) zip.file('saves.json', JSON.stringify(saves, null, 2));
  }
  return zip.generateAsync({ type: 'blob' });
}

// Сколько сохранений у проекта (для подписи в окне экспорта).
export async function countSaves(projectId: string): Promise<number> {
  return (await listSaves(projectId)).length;
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

  // Прогресс (если в архиве есть saves.json). Внутренние ссылки RuntimeState — на
  // asset.id / character.id, которые при импорте НЕ перекеиваются, поэтому сейвы
  // остаются валидными; перекеиваем только projectId и ключ сейва.
  const savesFile = zip.file('saves.json');
  if (savesFile) {
    try {
      const rawSaves = JSON.parse(await savesFile.async('string'));
      if (Array.isArray(rawSaves)) {
        let imported = 0;
        for (const s of rawSaves as SaveSlot[]) {
          if (!s || typeof s.slot !== 'number' || !s.state) continue;
          await putSave({
            slot: s.slot,
            projectId: newProjectId,
            savedAt: typeof s.savedAt === 'number' ? s.savedAt : Date.now(),
            title: typeof s.title === 'string' ? s.title : `Импорт · слот ${s.slot}`,
            state: s.state,
          });
          imported++;
        }
        if (imported) warnings.push(`Импортирован прогресс: сохранений — ${imported}.`);
      }
    } catch {
      warnings.push('Не удалось прочитать сохранения из архива — импортирован только проект.');
    }
  }

  return { project, warnings };
}
