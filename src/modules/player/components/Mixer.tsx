import { useEffect, useState } from 'react';
import { getVolumes, setVolume, toggleMute, subscribeVolumes } from '../audio';
import { useT } from '../../../shared/i18n';

// Один общий микшер громкости + кнопка мьюта (Блок I.3).
export function Mixer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const [vols, setVols] = useState(getVolumes());
  useEffect(() => subscribeVolumes(setVols), []);
  if (!open) return null;

  return (
    <div
      className="absolute top-14 right-3 z-30 w-72 glass-panel p-4"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between mb-3">
        <h4 className="font-semibold text-sm">{t('mixer.title')}</h4>
        <button className="text-gray-400 hover:text-white text-xs" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="flex items-center gap-3">
        <button
          className="shrink-0 text-xl"
          title={vols.muted ? 'Включить звук' : 'Выключить звук'}
          onClick={toggleMute}
        >
          {vols.muted ? '🔇' : '🔊'}
        </button>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={vols.master}
          disabled={vols.muted}
          onChange={(e) => setVolume('master', Number(e.target.value))}
          className="flex-1"
        />
        <span className="w-10 text-right text-xs text-gray-400">
          {vols.muted ? '—' : Math.round(vols.master * 100)}
        </span>
      </div>
    </div>
  );
}
