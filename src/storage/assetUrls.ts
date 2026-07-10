import { getAssetBlob } from './db';

// Caches object URLs for asset blobKeys so components can render them.
const cache = new Map<string, string>();
const pending = new Map<string, Promise<string | null>>();

export async function getAssetUrl(blobKey: string | undefined | null): Promise<string | null> {
  if (!blobKey) return null;
  if (cache.has(blobKey)) return cache.get(blobKey)!;
  if (pending.has(blobKey)) return pending.get(blobKey)!;
  const p = (async () => {
    const blob = await getAssetBlob(blobKey);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    cache.set(blobKey, url);
    pending.delete(blobKey);
    return url;
  })();
  pending.set(blobKey, p);
  return p;
}

export function revokeAssetUrl(blobKey: string): void {
  const url = cache.get(blobKey);
  if (url) {
    URL.revokeObjectURL(url);
    cache.delete(blobKey);
  }
}
