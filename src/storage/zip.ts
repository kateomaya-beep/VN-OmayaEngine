import JSZip from 'jszip';
import type { Project } from '../shared/types';
import { getAssetBlob, putAsset, saveProject } from './db';
import { uid } from '../shared/utils';

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

// Import: reads zip, re-keys ids to avoid collisions, stores blobs + project.
export async function importProjectZip(file: File): Promise<Project> {
  const zip = await JSZip.loadAsync(file);
  const projFile = zip.file('project.json');
  if (!projFile) throw new Error('project.json не найден в архиве');
  const raw = await projFile.async('string');
  const project = JSON.parse(raw) as Project;

  // Re-key project id + blobKeys so imports never clobber existing data.
  const newProjectId = uid('proj');
  const keyMap = new Map<string, string>();

  for (const asset of project.assets) {
    const oldKey = asset.blobKey;
    const newKey = uid('blob');
    keyMap.set(oldKey, newKey);
    const entry = zip.file(`assets/${oldKey}`);
    if (entry) {
      const blob = await entry.async('blob');
      const typed = asset.mime ? new Blob([blob], { type: asset.mime }) : blob;
      await putAsset(newKey, typed);
    }
    asset.blobKey = newKey;
  }

  project.id = newProjectId;
  project.createdAt = Date.now();
  project.updatedAt = Date.now();
  await saveProject(project);
  return project;
}
