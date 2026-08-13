import { Howl } from 'howler';
import { getAssetUrl } from '../../storage/assetUrls';

// Music manager with crossfade + a 3-channel volume mixer (music / sfx / master),
// persisted to localStorage (see доработка §5).

interface Volumes {
  master: number;
  music: number;
  sfx: number;
  muted: boolean;
}

const LS_KEY = 'nf_volumes';

function loadVolumes(): Volumes {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const v = JSON.parse(raw);
      return {
        master: typeof v.master === 'number' ? v.master : 0.8,
        music: typeof v.music === 'number' ? v.music : 0.7,
        sfx: typeof v.sfx === 'number' ? v.sfx : 0.8,
        muted: typeof v.muted === 'boolean' ? v.muted : false,
      };
    }
  } catch {
    /* ignore */
  }
  return { master: 0.8, music: 0.7, sfx: 0.8, muted: false };
}

let volumes = loadVolumes();
const listeners = new Set<(v: Volumes) => void>();

let currentHowl: Howl | null = null;
let currentKey: string | null = null;

function effectiveMusic(): number {
  return volumes.muted ? 0 : volumes.master * volumes.music;
}

export function getVolumes(): Volumes {
  return { ...volumes };
}

export function subscribeVolumes(fn: (v: Volumes) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function persistAndNotify() {
  localStorage.setItem(LS_KEY, JSON.stringify(volumes));
  if (currentHowl) currentHowl.volume(effectiveMusic());
  for (const fn of listeners) fn(getVolumes());
}

export function setVolume(channel: 'master' | 'music' | 'sfx', value: number): void {
  volumes = { ...volumes, [channel]: Math.max(0, Math.min(1, value)) };
  persistAndNotify();
}

export function toggleMute(): void {
  volumes = { ...volumes, muted: !volumes.muted };
  persistAndNotify();
}

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

  const target = effectiveMusic();
  const next = new Howl({ src: [url], loop: true, volume: 0, html5: true });
  next.play();
  next.fade(0, target, fadeMs);
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
  if (volumes.muted) return;
  const sfx = new Howl({ src: [url], volume: volumes.master * volumes.sfx, html5: true });
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
