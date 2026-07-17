import { useEffect, useRef, useState } from 'react';
import { useAssetUrl } from '../../../shared/ui';
import type { Project } from '../../../shared/types';
import { resolveSprite } from '../../../shared/outfits';

export interface ActiveSprite {
  characterId: string;
  emotion: string;
  outfit?: string;
}

// Сцена (CR v2 §A): фон с кроссфейдом + МАКСИМУМ один активный говорящий +
// нижний градиент-затемнение + нормализация размеров + CG-оверлей.
export function Stage({
  project,
  backgroundId,
  active,
  cg,
}: {
  project: Project;
  backgroundId: string | null;
  active: ActiveSprite | null;
  cg: string | null;
}) {
  const bgKey = project.assets.find((a) => a.id === backgroundId)?.blobKey || null;
  const cgKey = project.assets.find((a) => a.id === cg)?.blobKey || null;

  return (
    <div className="absolute inset-0 overflow-hidden bg-black">
      <CrossfadeBg blobKey={bgKey} />

      {/* Активный говорящий (нормализация: единый бокс, object-contain, растёт снизу).
          Десктоп — снизу по центру; мобилка — крупно сверху по центру. */}
      {!cgKey && <ActiveSpriteLayer project={project} active={active} />}

      {/* Нижний градиент-затемнение — спрайт «врастает» в него. */}
      <div className="absolute inset-x-0 bottom-0 h-2/5 bg-gradient-to-t from-black via-black/70 to-transparent pointer-events-none" />

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
          // Фоны нормализуются к единому кадру: object-cover заполняет экран.
          className="absolute inset-0 w-full h-full object-cover transition-opacity duration-[400ms]"
          alt=""
        />
      ))}
      {layers.length === 0 && <div className="absolute inset-0 bg-gradient-to-b from-panel to-ink" />}
    </>
  );
}

// Держит один активный спрайт с fade in/out. При смене говорящего старый плавно
// уходит, новый появляется; на чистом нарративе (active=null) — уходит в никого.
function ActiveSpriteLayer({ project, active }: { project: Project; active: ActiveSprite | null }) {
  const resolve = (a: ActiveSprite | null): { key: string; assetId?: string } => {
    if (!a) return { key: '__none__' };
    const char = project.characters.find((c) => c.id === a.characterId);
    if (!char) return { key: '__none__' };
    // Наряд+эмоция → спрайт по fallback-цепочке (Batch 5.3). Никогда не крашит.
    const assetId = resolveSprite(char, a.outfit, a.emotion);
    if (!assetId) return { key: '__none__' }; // нет спрайта → рендер имя+текст, тут пусто
    return { key: `${a.characterId}:${assetId}`, assetId };
  };

  const target = resolve(active);
  const [shown, setShown] = useState(target);
  const [visible, setVisible] = useState(!!target.assetId);

  useEffect(() => {
    if (target.key === shown.key) return;
    // Fade out текущего, затем подмена и fade in нового.
    setVisible(false);
    const t = setTimeout(() => {
      setShown(target);
      setVisible(!!target.assetId);
    }, 220);
    return () => clearTimeout(t);
  }, [target.key]);

  const blobKey = project.assets.find((a) => a.id === shown.assetId)?.blobKey;
  const url = useAssetUrl(blobKey);
  if (!shown.assetId || !url) return null;

  return (
    // Спрайт прижат к низу и на мобилке (растёт снизу, «врастает» в градиент), крупнее.
    <div className="absolute inset-0 flex justify-center items-end pointer-events-none">
      <img
        src={url}
        alt=""
        // Мобилка: крупный спрайт, сдвинут ниже (низ уходит за край/за диалог),
        // голова остаётся ниже верхней панели. Десктоп — как было.
        className={`object-contain object-bottom transition-all duration-300 h-[120%] -mb-[62%] max-w-[135%] sm:h-[88%] sm:mb-0 sm:max-w-[46%] ${
          visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'
        }`}
      />
    </div>
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
