import type { Project, Choice, RuntimeState } from '../../../shared/types';
import { InlineMarkdown } from '../../../shared/markdown';

// Кнопки выбора (могут отсутствовать — Блок I.1). Свободный ввод — в консоли ниже.
export function ChoiceMenu({
  project,
  state,
  choices,
  onChoose,
}: {
  project: Project;
  state: RuntimeState;
  choices: Choice[];
  onChoose: (c: Choice) => void;
}) {
  if (!choices.length) return null;
  return (
    <div className="px-4 sm:px-6">
      <div className="max-w-2xl mx-auto flex flex-col gap-2">
        {choices.map((c) => {
          const costStat = c.cost && project.stats.find((s) => s.id === c.cost!.statId);
          const affordable = !c.cost || (state.statValues[c.cost.statId] ?? 0) >= c.cost.amount;
          return (
            <button
              key={c.id}
              disabled={!affordable}
              onClick={() => onChoose(c)}
              className={`w-full text-left px-5 py-2.5 rounded-[14px] border backdrop-blur-md transition-all ${
                c.cost
                  ? 'bg-gradient-to-r from-amber-500/20 to-[rgba(177,140,255,0.2)] border-amber-400/40 hover:border-amber-400'
                  : 'bg-[rgba(16,13,24,0.7)] border-[rgba(180,150,255,0.22)] hover:border-[rgba(190,150,255,0.6)] hover:bg-[rgba(160,110,255,0.14)]'
              } disabled:opacity-40`}
            >
              <InlineMarkdown text={c.text} />
              {c.cost && costStat && (
                <span className="float-right text-amber-300 text-sm">
                  {c.cost.amount} {costStat.name}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
