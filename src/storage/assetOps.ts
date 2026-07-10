import type { AssetMeta, AssetType, Project } from '../shared/types';
import { putAsset, deleteAsset } from './db';
import { uid, autoTagsFromName } from '../shared/utils';

// Store a File as a blob and return its AssetMeta (not yet attached to a project).
export async function uploadAsset(file: File, type: AssetType): Promise<AssetMeta> {
  const blobKey = uid('blob');
  await putAsset(blobKey, file);
  return {
    id: uid(assetPrefix(type)),
    type,
    name: file.name.replace(/\.[^.]+$/, ''),
    tags: autoTagsFromName(file.name),
    blobKey,
    mime: file.type,
  };
}

function assetPrefix(type: AssetType): string {
  switch (type) {
    case 'background':
      return 'bg';
    case 'sprite':
      return 'spr';
    case 'music':
      return 'mus';
    case 'sfx':
      return 'sfx';
    case 'cg':
      return 'cg';
    case 'icon':
      return 'icon';
  }
}

// Remove an asset from a project (mutates draft synchronously) and delete its blob.
export function removeAsset(project: Project, assetId: string): void {
  const asset = project.assets.find((a) => a.id === assetId);
  if (!asset) return;
  project.assets = project.assets.filter((a) => a.id !== assetId);
  if (project.meta.coverAssetId === assetId) project.meta.coverAssetId = undefined;
  for (const c of project.characters) {
    c.sprites = c.sprites.filter((s) => s.assetId !== assetId);
  }
  for (const s of project.stats) {
    if (s.iconAssetId === assetId) s.iconAssetId = undefined;
  }
  void deleteAsset(asset.blobKey);
}
