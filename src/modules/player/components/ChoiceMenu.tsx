import { useState } from 'react';
import type { Project, Choice, RuntimeState } from '../../../shared/types';

// Choice buttons, including premium (stat-cost) choices (see ТЗ §7, §9).
export function ChoiceMenu({
  project,
  state,
  choices,
  onChoose,
  onFreeInput,
}: {
  project: Project;
  state: RuntimeState;
  choices: Choice[];
  onChoose: (c: Choice) => void;
  onFreeInput: (text: string) => void;
}) {
  const [freeText, setFreeText] = useState('');
  const [showFree, setShowFree] = useState(false);

  return (
    <div className="absolute inset-x-0 bottom-0 p-4 sm:p-6">
      <div className="max-w-2xl mx-auto flex flex-col gap-2">
        {choices.map((c) => {
          const costStat = c.cost && project.stats.find((s) => s.id === c.cost!.statId);
          const affordable =
            !c.cost || (state.statValues[c.cost.statId] ?? 0) >= c.cost.amount;
          return (
            <button
              key={c.id}
              disabled={!affordable}
              onClick={() => onChoose(c)}
              className={`w-full text-left px-5 py-3 rounded-xl border transition-all ${
                c.cost
                  ? 'bg-gradient-to-r from-amber-500/20 to-accent/20 border-amber-400/40 hover:border-amber-400'
                  : 'bg-black/70 border-white/10 hover:border-accent2 hover:bg-accent2/10'
              } disabled:opacity-40`}
            >
              <span>{c.text}</span>
              {c.cost && costStat && (
                <span className="float-right text-amber-300 text-sm">
                  {c.cost.amount} {costStat.name}
                </span>
              )}
            </button>
          );
        })}

        {showFree ? (
          <div className="flex gap-2 mt-1">
            <input
              className="input flex-1"
              autoFocus
              placeholder="Ваш ответ…"
              value={freeText}
              onChange={(e) => setFreeText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && freeText.trim()) {
                  onFreeInput(freeText.trim());
                  setFreeText('');
                  setShowFree(false);
                }
              }}
            />
            <button
              className="btn-primary"
              onClick={() => {
                if (freeText.trim()) {
                  onFreeInput(freeText.trim());
                  setFreeText('');
                  setShowFree(false);
                }
              }}
            >
              →
            </button>
          </div>
        ) : (
          <button
            className="text-xs text-gray-500 hover:text-gray-300 mt-1 self-center"
            onClick={() => setShowFree(true)}
          >
            …или ответить своими словами
          </button>
        )}
      </div>
    </div>
  );
}
