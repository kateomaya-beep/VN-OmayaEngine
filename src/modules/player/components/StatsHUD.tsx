import { AssetImage } from '../../../shared/ui';
import type { Project, RuntimeState } from '../../../shared/types';

// Stats panel with icons and "+2" flash animation on change (see ТЗ §9).
export function StatsHUD({
  project,
  state,
  flash,
}: {
  project: Project;
  state: RuntimeState;
  flash: { statId: string; delta: number }[];
}) {
  const visible = project.stats.filter((s) => s.visible);
  if (visible.length === 0) return null;
  return (
    <div className="absolute top-3 left-3 flex flex-col gap-1.5 z-10">
      {visible.map((s) => {
        const val = state.statValues[s.id] ?? s.initial;
        const f = flash.find((x) => x.statId === s.id);
        return (
          <div
            key={s.id}
            className="flex items-center gap-2 bg-black/60 backdrop-blur rounded-full pl-1.5 pr-3 py-1 text-sm"
          >
            {s.iconAssetId ? (
              <AssetImage
                blobKey={project.assets.find((a) => a.id === s.iconAssetId)?.blobKey}
                className="w-6 h-6 rounded-full object-cover"
              />
            ) : (
              <span className="w-6 h-6 rounded-full bg-accent2/40 flex items-center justify-center text-xs">
                {s.name[0]}
              </span>
            )}
            <span className="text-gray-300 hidden sm:inline" title={s.name}>
              {s.name}
            </span>
            <span className="font-semibold">{val}</span>
            {f && (
              <span
                className={`font-bold animate-bounce ${f.delta > 0 ? 'text-green-400' : 'text-red-400'}`}
              >
                {f.delta > 0 ? '+' : ''}
                {f.delta}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
