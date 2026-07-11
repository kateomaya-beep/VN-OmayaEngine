import { useEffect, useRef, useState } from 'react';
import { useAssetUrl } from '../../../shared/ui';
import type { Project, OnScreenSprite } from '../../../shared/types';

// Background with crossfade + sprites in up to 3 positions + CG overlay (see ТЗ §9).
export function Stage({
  project,
  backgroundId,
  onScreen,
  cg,
  activeSpeakerId,
}: {
  project: Project;
  backgroundId: string | null;
  onScreen: OnScreenSprite[];
  cg: string | null;
  activeSpeakerId?: string;
}) {
  const bgKey = project.assets.find((a) => a.id === backgroundId)?.blobKey || null;
  const cgKey = project.assets.find((a) => a.id === cg)?.blobKey || null;

  return (
    <div className="absolute inset-0 overflow-hidden bg-black">
      <CrossfadeBg blobKey={bgKey} />

      <div className="absolute inset-0 flex items-end justify-center gap-0 pointer-events-none">
        {onScreen.map((s) => (
          <Sprite
            key={s.characterId}
            project={project}
            sprite={s}
            dim={!!activeSpeakerId && activeSpeakerId !== s.characterId}
          />
        ))}
      </div>

      {cgKey && <CgOverlay blobKey={cgKey} />}
    </div>
  );
}

function CrossfadeBg({ blobKey }: { blobKey: string | null }) {
  const url = useAssetUrl(blobKey);
  const [layers, setLayers] = useState<{ id: number; url: string }[]>([]);
  const idRef = useRef(0);

  useEffect(() => {
    if (!url) return;
    const id = ++idRef.current;
    setLayers((prev) => [...prev, { id, url }].slice(-2));
    const t = setTimeout(() => setLayers((prev) => prev.filter((l) => l.id === id)), 450);
    return () => clearTimeout(t);
  }, [url]);

  return (
    <>
      {layers.map((l) => (
        <img
          key={l.id}
          src={l.url}
          className="absolute inset-0 w-full h-full object-cover transition-opacity duration-[400ms]"
          style={{ opacity: 1 }}
          alt=""
        />
      ))}
      {layers.length === 0 && <div className="absolute inset-0 bg-gradient-to-b from-panel to-ink" />}
    </>
  );
}

function Sprite({
  project,
  sprite,
  dim,
}: {
  project: Project;
  sprite: OnScreenSprite;
  dim: boolean;
}) {
  const char = project.characters.find((c) => c.id === sprite.characterId);
  // Единое правило: спрайт нужной эмоции → neutral → любой имеющийся; нет спрайтов → не рендерим.
  const assetId =
    char?.sprites[sprite.emotion as keyof typeof char.sprites] ||
    char?.sprites.neutral ||
    (char ? Object.values(char.sprites)[0] : undefined);
  const blobKey = project.assets.find((a) => a.id === assetId)?.blobKey;
  const url = useAssetUrl(blobKey);
  const posClass =
    sprite.position === 'left' ? 'mr-auto' : sprite.position === 'right' ? 'ml-auto' : 'mx-auto';

  if (!url) return null;
  return (
    <img
      src={url}
      alt={char?.name}
      className={`h-[85%] max-w-[45%] object-contain transition-all duration-300 ${posClass} ${
        dim ? 'brightness-50 saturate-50' : 'brightness-100'
      }`}
    />
  );
}

function CgOverlay({ blobKey }: { blobKey: string }) {
  const url = useAssetUrl(blobKey);
  if (!url) return null;
  return (
    <div className="absolute inset-0 bg-black flex items-center justify-center animate-[fadein_400ms]">
      <img src={url} className="max-w-full max-h-full object-contain" alt="CG" />
    </div>
  );
}
