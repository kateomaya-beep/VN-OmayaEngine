import { useEffect, useRef, useState } from 'react';
import { useAssetUrl } from '../../../shared/ui';
import { getAssetUrl } from '../../../storage/assetUrls';
import type { Project } from '../../../shared/types';
import { resolveSprite } from '../../../shared/outfits';

export interface ActiveSprite {
  characterId: string;
  emotion: string;
  outfit?: string;
}

// Длительность кроссфейда спрайта (мс). Мягкий ease-in-out поверх предекода картинки.
const FADE_MS = 420;

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

// Активный спрайт с КРОССФЕЙДОМ: новый спрайт проявляется ПОВЕРХ старого (два слоя),
// старый затем удаляется. Персонаж не пропадает в пустоту между сменами эмоций —
// иначе при частой смене эмоций в сцене спрайт «дёргается» (пропал → появился).
// URL берём напрямую из кэша getAssetUrl (а не через useAssetUrl, который на кадр
// отстаёт при смене blobKey и подсунул бы старую картинку в кроссфейд).
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
  const targetBlobKey = target.assetId
    ? project.assets.find((a) => a.id === target.assetId)?.blobKey || null
    : null;

  const [layers, setLayers] = useState<{ id: number; url: string; on: boolean }[]>([]);
  const idRef = useRef(0);
  const lastKeyRef = useRef('__init__');

  useEffect(() => {
    if (target.key === lastKeyRef.current) return;
    lastKeyRef.current = target.key;
    let cancelled = false;
    const timers: Array<() => void> = [];
    const later = (fn: () => void, ms: number) => {
      const h = setTimeout(fn, ms);
      timers.push(() => clearTimeout(h));
    };

    if (!targetBlobKey) {
      // Уход в нарратив (нет спрайта): плавно гасим верхний слой, затем чистим.
      setLayers((prev) => prev.map((l) => ({ ...l, on: false })));
      later(() => !cancelled && setLayers([]), FADE_MS + 40);
    } else {
      getAssetUrl(targetBlobKey).then(async (url) => {
        if (cancelled || !url) return;
        // ПРЕДЕКОД: дожидаемся готовности картинки в памяти, чтобы фейд не спотыкался
        // о декодирование в главном потоке в первый же кадр перехода (главная причина
        // рывка). decode() может отклониться — тогда просто продолжаем.
        try {
          const im = new Image();
          im.src = url;
          await im.decode();
        } catch {
          /* всё равно продолжаем — картинка отрисуется, просто без предекода */
        }
        if (cancelled) return;
        const id = ++idRef.current;
        // Добавляем слой выключенным (поверх старого, старый остаётся непрозрачным —
        // без просвета фона), затем короткой паузой включаем: браузер успевает
        // отрисовать opacity:0, и CSS-переход реально проигрывается (двойной rAF
        // React иногда схлопывал в один кадр → «скачок» вместо фейда).
        setLayers((prev) => [...prev, { id, url, on: false }].slice(-2));
        later(
          () => !cancelled && setLayers((prev) => prev.map((l) => (l.id === id ? { ...l, on: true } : l))),
          40
        );
        // После завершения перехода убираем старые слои.
        later(() => !cancelled && setLayers((prev) => prev.filter((l) => l.id === id)), FADE_MS + 80);
      });
    }
    return () => {
      cancelled = true;
      timers.forEach((t) => t());
    };
  }, [target.key, targetBlobKey]);

  if (layers.length === 0) return null;

  return (
    <>
      {layers.map((l) => (
        // Каждый слой — отдельный кадр с той же нормализацией/позицией; кроссфейд —
        // через opacity обёртки. Переход и will-change заданы инлайном (надёжнее, чем
        // утилиты), GPU-композитинг через translateZ — фейд идёт вне главного потока.
        <div
          key={l.id}
          className="absolute inset-0 flex justify-center items-end pointer-events-none"
          style={{
            opacity: l.on ? 1 : 0,
            transition: `opacity ${FADE_MS}ms ease-in-out`,
            willChange: 'opacity',
            transform: 'translateZ(0)',
          }}
        >
          <img
            src={l.url}
            alt=""
            className="object-contain object-bottom h-[118%] -mb-[60%] max-w-[130%] sm:h-[88%] sm:mb-[2%] sm:max-w-[46%]"
          />
        </div>
      ))}
    </>
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
