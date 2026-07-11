import { useEffect, useState } from 'react';
import { getVolumes, setVolume, subscribeVolumes } from '../audio';
import { useT } from '../../../shared/i18n';

// Three-channel volume mixer (music / sfx / master), см. доработка §5.
export function Mixer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const [vols, setVols] = useState(getVolumes());
  useEffect(() => subscribeVolumes(setVols), []);
  if (!open) return null;

  const row = (channel: 'master' | 'music' | 'sfx', label: string) => (
    <div className="flex items-center gap-3">
      <span className="w-20 text-sm text-gray-300">{label}</span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={vols[channel]}
        onChange={(e) => setVolume(channel, Number(e.target.value))}
        className="flex-1"
      />
      <span className="w-10 text-right text-xs text-gray-400">
        {Math.round(vols[channel] * 100)}
      </span>
    </div>
  );

  return (
    <div
      className="absolute top-14 right-3 z-30 w-72 card !bg-black/85 backdrop-blur"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between mb-3">
        <h4 className="font-semibold text-sm">{t('mixer.title')}</h4>
        <button className="text-gray-400 hover:text-white text-xs" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="space-y-2">
        {row('master', t('mixer.master'))}
        {row('music', t('mixer.music'))}
        {row('sfx', t('mixer.sfx'))}
      </div>
    </div>
  );
}
