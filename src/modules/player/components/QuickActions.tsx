import { useState } from 'react';
import { usePlayerStore } from '../playerStore';
import { composeImagePrompt } from '../../../ai/imagePrompt';
import { generateImage } from '../../../ai/imageProvider';
import { putAsset } from '../../../storage/db';
import { uid, autoTagsFromName } from '../../../shared/utils';
import { defaultImageGenConfig, type AssetMeta } from '../../../shared/types';

// Панель быстрых действий: генерация фонов/CG по ходу игры (см. доработка §7).
// Сгенерированный ассет попадает в манифест проекта (generated:true) → ИИ
// переиспользует его в следующих сценах.
export function QuickActions({ open, onClose }: { open: boolean; onClose: () => void }) {
  const s = usePlayerStore();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastPrompt, setLastPrompt] = useState<string | null>(null);

  if (!open || !s.project || !s.state) return null;
  const project = s.project;
  const state = s.state;

  async function generate(kind: 'background' | 'cg') {
    setError(null);
    setBusy(kind === 'background' ? 'Придумываю фон…' : 'Придумываю CG…');
    try {
      const prompt = await composeImagePrompt(project, state, kind);
      setLastPrompt(prompt);
      setBusy('Рисую изображение…');
      const cfg = project.imageGen ?? defaultImageGenConfig();
      const blob = await generateImage(cfg, {
        prompt: [prompt, cfg.style].filter(Boolean).join('\n\nStyle: '),
        // Фон всегда горизонтальный — он растягивается на весь экран сцены.
        // У CG кадр берётся из настроек CG-студии.
        aspectRatio: kind === 'background' ? '16:9' : undefined,
      });
      const blobKey = uid('blob');
      await putAsset(blobKey, blob);

      const moodTag = state.currentMusicMood ? [state.currentMusicMood] : [];
      const name = prompt.split(/[\s,]+/).slice(0, 4).join(' ') || (kind === 'background' ? 'фон' : 'CG');
      const asset: AssetMeta = {
        id: uid(kind === 'background' ? 'bg' : 'cg'),
        type: kind,
        name,
        tags: kind === 'background' ? [...moodTag, ...autoTagsFromName(name)].slice(0, 6) : undefined,
        generated: true,
        blobKey,
        mime: blob.type || 'image/png',
      };

      await s.patchProject((p) => p.assets.push(asset));

      // Сразу показать результат в сцене.
      if (kind === 'background') {
        usePlayerStore.setState((st) => ({
          state: st.state ? { ...st.state, currentBackgroundId: asset.id } : st.state,
        }));
      } else {
        usePlayerStore.setState({ cg: asset.id });
      }
      setBusy(null);
    } catch (e) {
      setBusy(null);
      setError((e as Error).message);
    }
  }

  return (
    <div
      className="absolute top-14 right-3 z-30 w-80 glass-panel p-4"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between mb-3">
        <h4 className="font-semibold text-sm">Генерация (BYO image key)</h4>
        <button className="text-gray-400 hover:text-white text-xs" onClick={onClose}>
          ✕
        </button>
      </div>
      <p className="text-xs text-gray-500 mb-3">
        Промпт собирает ИИ из текущей сцены. Результат добавится в манифест и станет
        доступен для будущих сцен.
      </p>
      <div className="flex flex-col gap-2">
        <button className="btn-primary" disabled={!!busy} onClick={() => generate('background')}>
          Создать фон
        </button>
        <p className="text-[11px] text-gray-500">
          CG-сцены с персонажами, стилями и референсами — в 🎬 CG-студии.
        </p>
      </div>
      {busy && (
        <div className="mt-3 text-sm text-accent2 flex items-center gap-2">
          <span className="inline-block w-3 h-3 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          {busy}
        </div>
      )}
      {error && <div className="mt-3 text-xs text-red-400">⚠️ {error}</div>}
      {lastPrompt && !busy && !error && (
        <div className="mt-3 text-[11px] text-gray-500 border-t border-white/10 pt-2">
          Промпт: {lastPrompt}
        </div>
      )}
    </div>
  );
}
