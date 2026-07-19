import { AssetImage } from '../../../shared/ui';
import type { Project, RuntimeState } from '../../../shared/types';

// HUD плеера (импорт дизайна «VN Player»): стеклянная плашка календаря/локации +
// ряд компактных пилюль статов с «+2»-вспышкой при изменении (ТЗ §9).
const STROKE = '#e5deF7';

function CalendarIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 20 20" fill="none" className="shrink-0">
      <rect x="3" y="4.2" width="14" height="12.3" rx="2" stroke={STROKE} strokeWidth="1.4" />
      <path d="M3 8h14M6.5 2.5v3M13.5 2.5v3" stroke={STROKE} strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function PinIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 20 20" fill="none" className="shrink-0">
      <path
        d="M10 17.5s6-5.6 6-10a6 6 0 1 0-12 0c0 4.4 6 10 6 10Z"
        stroke={STROKE}
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <circle cx="10" cy="7.5" r="2" stroke={STROKE} strokeWidth="1.4" />
    </svg>
  );
}

const PILL =
  'flex items-center rounded-full bg-[var(--pl-bubble-bg)] backdrop-blur-md border border-[rgba(180,150,255,0.22)]';

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

  // Календарь/локация — единая плашка (заменяет прежний отдельный чип часов).
  const c = state.gm?.clock;
  const showCal = state.gm?.showClockInGame;
  const dateStr = c ? [c.day, c.month, c.year].filter(Boolean).join(' ') : '';
  const leftText = [dateStr, c?.time].filter(Boolean).join(' · ');
  const loc = c?.location || '';
  const hasCal = !!showCal && (!!leftText || !!loc);

  if (!hasCal && visible.length === 0) return null;

  return (
    <div className="absolute top-16 left-3 right-3 z-10 flex flex-col gap-2 items-start">
      {hasCal && (
        <div className={`${PILL} gap-2 pl-2.5 pr-3 py-1.5 max-w-full`}>
          {leftText && (
            <>
              <CalendarIcon />
              <span className="text-[11.5px] font-semibold text-[var(--pl-cal)] whitespace-nowrap overflow-hidden text-ellipsis">
                {leftText}
              </span>
            </>
          )}
          {leftText && loc && <span className="w-px h-3 bg-[rgba(180,150,255,0.25)] shrink-0" />}
          {loc && (
            <>
              <PinIcon />
              <span className="text-[11.5px] font-semibold text-[var(--pl-cal)] whitespace-nowrap overflow-hidden text-ellipsis">
                {loc}
              </span>
            </>
          )}
        </div>
      )}

      {visible.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          {visible.map((s) => {
            const val = state.statValues[s.id] ?? s.initial;
            const f = flash.find((x) => x.statId === s.id);
            return (
              <div key={s.id} className={`${PILL} gap-1.5 pl-1.5 pr-3 py-1`} title={s.name}>
                {s.iconAssetId ? (
                  <AssetImage
                    blobKey={project.assets.find((a) => a.id === s.iconAssetId)?.blobKey}
                    className="w-5 h-5 rounded-full object-cover"
                  />
                ) : (
                  <span className="w-5 h-5 rounded-full bg-[rgba(177,140,255,0.35)] flex items-center justify-center text-[10px] font-bold text-[#f2edfc]">
                    {s.name[0]}
                  </span>
                )}
                <span className="text-[12px] font-bold text-[#f2edfc]">{val}</span>
                {f && (
                  <span
                    className={`text-[11px] font-bold animate-bounce ${
                      f.delta > 0 ? 'text-green-400' : 'text-red-400'
                    }`}
                  >
                    {f.delta > 0 ? '+' : ''}
                    {f.delta}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
