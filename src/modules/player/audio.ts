import { Howl } from 'howler';
import { getAssetUrl } from '../../storage/assetUrls';

// Music manager with crossfade between tracks (see ТЗ §9).
let currentHowl: Howl | null = null;
let currentKey: string | null = null;

export async function playMusic(blobKey: string | null, fadeMs = 800): Promise<void> {
  if (blobKey === currentKey) return;
  const prev = currentHowl;

  if (!blobKey) {
    if (prev) {
      prev.fade(prev.volume(), 0, fadeMs);
      setTimeout(() => prev.unload(), fadeMs);
    }
    currentHowl = null;
    currentKey = null;
    return;
  }

  const url = await getAssetUrl(blobKey);
  if (!url) return;

  const next = new Howl({ src: [url], loop: true, volume: 0, html5: true });
  next.play();
  next.fade(0, 0.6, fadeMs);
  currentHowl = next;
  currentKey = blobKey;

  if (prev) {
    prev.fade(prev.volume(), 0, fadeMs);
    setTimeout(() => prev.unload(), fadeMs);
  }
}

export async function playSfx(blobKey: string | null): Promise<void> {
  if (!blobKey) return;
  const url = await getAssetUrl(blobKey);
  if (!url) return;
  const sfx = new Howl({ src: [url], volume: 0.8, html5: true });
  sfx.play();
}

export function stopAllMusic(): void {
  if (currentHowl) {
    currentHowl.stop();
    currentHowl.unload();
  }
  currentHowl = null;
  currentKey = null;
}
