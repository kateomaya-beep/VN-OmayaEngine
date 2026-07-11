import JSZip from 'jszip';
import type { AssetMeta, Emotion } from '../shared/types';
import { EMOTIONS } from '../shared/types';
import { putAsset } from './db';
import { uid } from '../shared/utils';

// Parse a zip of sprites named `<name>_<emotion>.<ext>` (см. доработка §3).
// Recognised files are grouped by emotion; the rest go to `unrecognized`.

export interface ParsedSprites {
  recognized: { emotion: Emotion; asset: AssetMeta }[];
  unrecognized: AssetMeta[];
}

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|avif)$/i;
const EMOTION_SET = new Set<string>(EMOTIONS);

function mimeForExt(name: string): string {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || 'png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'svg') return 'image/svg+xml';
  return `image/${ext}`;
}

export async function parseSpriteZip(file: File): Promise<ParsedSprites> {
  const zip = await JSZip.loadAsync(file);
  const recognized: { emotion: Emotion; asset: AssetMeta }[] = [];
  const unrecognized: AssetMeta[] = [];

  const entries = Object.values(zip.files).filter(
    (f) => !f.dir && IMAGE_EXT.test(f.name)
  );

  for (const entry of entries) {
    const blob = await entry.async('blob');
    const baseName = entry.name.split('/').pop() || entry.name;
    const nameNoExt = baseName.replace(IMAGE_EXT, '');
    const mime = mimeForExt(baseName);
    const typed = new Blob([blob], { type: mime });
    const blobKey = uid('blob');
    await putAsset(blobKey, typed);

    const asset: AssetMeta = {
      id: uid('spr'),
      type: 'sprite',
      name: nameNoExt,
      blobKey,
      mime,
    };

    // Эмоция — суффикс после последнего '_'.
    const suffix = nameNoExt.split('_').pop()?.toLowerCase() || '';
    if (EMOTION_SET.has(suffix)) {
      recognized.push({ emotion: suffix as Emotion, asset });
    } else {
      unrecognized.push(asset);
    }
  }

  return { recognized, unrecognized };
}
