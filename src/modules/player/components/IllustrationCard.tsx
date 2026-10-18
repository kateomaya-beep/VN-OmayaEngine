import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePlayerStore } from '../playerStore';
import { useAssetUrl } from '../../../shared/ui';
import { illustrationKey } from '../../../ai/illustrations';

// ИЛЛЮСТРАЦИЯ В ЛЕНТЕ РП — карточка на месте метки рассказчика. Пока рисуется —
// мерцающая заглушка с подписью; готово — картинка в рамке с мягким свечением и
// подписью курсивом. Нажатие — на весь экран. Метки без записи (до срока, лишние)
// не показываются вовсе.
export function IllustrationCard({ caption, interactive = true }: { caption: string; interactive?: boolean }) {
  const rec = usePlayerStore((s) => s.project?.imageGen?.illustrations?.[illustrationKey(caption)]);
  const asset = usePlayerStore((s) => (rec?.assetId ? s.project?.assets.find((a) => a.id === rec.assetId) : undefined));
  const draw = usePlayerStore((s) => s.drawIllustration);
  const remove = usePlayerStore((s) => s.removeIllustration);
  const toGallery = usePlayerStore((s) => s.illustrationToGallery);
  const inGallery = usePlayerStore((s) => !!rec?.assetId && !!s.project?.imageGen?.gallery.includes(rec.assetId));
  const url = useAssetUrl(asset?.blobKey);
  const [full, setFull] = useState(false);
  const [editing, setEditing] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const drawing = rec?.status === 'drawing';

  useEffect(() => {
    if (!drawing) return;
    const t0 = Date.now();
    setElapsed(0);
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(id);
  }, [drawing]);

  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setFull(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [full]);

  if (!rec) return null;

  const download = async () => {
    if (!url) return;
    const a = document.createElement('a');
    a.href = url;
    a.download = `${caption.slice(0, 40).replace(/[\\/:*?"<>|]+/g, '') || 'illustration'}.png`;
    a.click();
  };

  const captionLine = (
    <figcaption className="nf-ill-caption text-center text-[13px] italic text-[color:var(--pl-text)] opacity-80 px-3 pt-2 pb-1">
      <span className="text-[var(--pl-accent)] not-italic mr-1.5">✦</span>
      {caption}
      <span className="text-[var(--pl-accent)] not-italic ml-1.5">✦</span>
    </figcaption>
  );

  return (
    <figure className="nf-illustration my-3 mx-0 not-prose" data-key={illustrationKey(caption)}>
      <div
        className="relative rounded-2xl overflow-hidden border border-[color-mix(in_srgb,var(--pl-accent)_35%,transparent)] bg-black/40"
        style={{ boxShadow: '0 0 28px -6px color-mix(in srgb, var(--pl-accent) 45%, transparent)' }}
      >
        {drawing && (
          <div className="nf-ill-drawing aspect-[3/2] w-full flex flex-col items-center justify-center gap-2 bg-gradient-to-br from-white/[0.04] via-[color-mix(in_srgb,var(--pl-accent)_12%,transparent)] to-white/[0.02] animate-pulse">
            <span className="text-2xl">🎨</span>
            <span className="text-xs text-gray-300">рисую иллюстрацию… {elapsed} с</span>
          </div>
        )}
        {!drawing && rec.status === 'done' && url && (
          <button className="block w-full" onClick={() => setFull(true)} title="Открыть на весь экран">
            <img src={url} alt={caption} className="w-full h-auto block animate-[fadein_500ms]" />
          </button>
        )}
        {!drawing && rec.status === 'done' && !url && <div className="aspect-[3/2] w-full bg-white/[0.03]" />}
        {!drawing && rec.status === 'error' && (
          <div className="aspect-[3/2] w-full flex flex-col items-center justify-center gap-2 px-4 text-center">
            <span className="text-xs text-red-300">⚠ {rec.error || 'Не нарисовалось'}</span>
            {interactive && (
              <button className="btn-ghost !px-3 !py-1 text-xs" onClick={() => void draw(caption)}>
                ↻ Нарисовать снова
              </button>
            )}
          </div>
        )}
      </div>
      {captionLine}

      {interactive && rec.status === 'done' && !drawing && (
        <div className="nf-ill-actions flex flex-wrap justify-center gap-1 text-[11px]">
          <button className="rounded-full px-2 py-0.5 bg-white/5 hover:bg-white/10" onClick={() => void draw(caption)} title="Новый вариант по тому же моменту">
            ↻ перерисовать
          </button>
          <button
            className="rounded-full px-2 py-0.5 bg-white/5 hover:bg-white/10"
            onClick={() => {
              setPrompt(rec.prompt || '');
              setEditing((v) => !v);
            }}
          >
            ✎ промпт
          </button>
          <button className="rounded-full px-2 py-0.5 bg-white/5 hover:bg-white/10 disabled:opacity-40" disabled={inGallery} onClick={() => void toGallery(caption)}>
            {inGallery ? '★ в галерее' : '⭐ в галерею'}
          </button>
          <button className="rounded-full px-2 py-0.5 bg-white/5 hover:bg-white/10" onClick={() => void download()}>
            ⬇ скачать
          </button>
          <button
            className="rounded-full px-2 py-0.5 bg-white/5 hover:bg-white/10 text-red-300"
            onClick={() => confirm('Убрать иллюстрацию из ответа?') && void remove(caption)}
          >
            ✕ убрать
          </button>
        </div>
      )}
      {editing && (
        <div className="mt-2 space-y-1.5">
          <textarea className="input h-28 text-xs font-mono" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          <div className="flex gap-2 justify-end">
            <button className="btn-ghost !py-1 !px-3 text-xs" onClick={() => setEditing(false)}>
              Отмена
            </button>
            <button
              className="btn-primary !py-1 !px-3 text-xs"
              disabled={!prompt.trim()}
              onClick={() => {
                setEditing(false);
                void draw(caption, { prompt });
              }}
            >
              🎨 Нарисовать по этому промпту
            </button>
          </div>
          <p className="text-[10px] text-gray-500">
            Стиль проекта, «чего быть не должно», внешность и референсы людей движок добавит сам — здесь только сам кадр.
          </p>
        </div>
      )}

      {full &&
        url &&
        createPortal(
          <div className="fixed inset-0 z-[200] bg-black/95 flex flex-col items-center justify-center p-3" onClick={() => setFull(false)}>
            <img src={url} alt={caption} className="max-w-full max-h-[86vh] object-contain rounded-lg" />
            <div className="mt-3 text-sm italic text-gray-300 text-center max-w-2xl">{caption}</div>
            <button className="absolute top-3 right-3 rounded-full bg-white/10 hover:bg-white/20 w-9 h-9" aria-label="Закрыть">
              ✕
            </button>
          </div>,
          document.body
        )}
    </figure>
  );
}
