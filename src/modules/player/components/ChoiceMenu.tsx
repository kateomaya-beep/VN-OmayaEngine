import type { Project, Choice, RuntimeState } from '../../../shared/types';
import { PHONE_BALANCE_STAT } from '../../../shared/types';
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
    <div className="px-4 sm:px-6 inset-x-safe">
      <div className="max-w-2xl mx-auto flex flex-col gap-2">
        {choices.map((c) => {
          // Метка стоимости: для баланса телефона — валюта; иначе — имя стата.
          const isPhoneCost = c.cost?.statId === PHONE_BALANCE_STAT;
          const costStat = c.cost && !isPhoneCost && project.stats.find((s) => s.id === c.cost!.statId);
          const costLabel = c.cost
            ? isPhoneCost
              ? project.phone?.currencyName || '$'
              : costStat
                ? costStat.name
                : ''
            : '';
          const affordable = !c.cost || (state.statValues[c.cost.statId] ?? 0) >= c.cost.amount;
          return (
            <button
              key={c.id}
              disabled={!affordable}
              onClick={() => onChoose(c)}
              style={{ fontSize: 'calc(15px * var(--pl-font-scale, 1))' }}
              className={`w-full text-left px-5 py-2.5 rounded-[14px] border backdrop-blur-md transition-all ${
                c.cost
                  ? 'bg-[var(--pl-premium-bg)] border-amber-400/40 hover:border-amber-400'
                  : 'bg-[var(--pl-choice-bg)] border-[rgba(180,150,255,0.22)] hover:border-[var(--pl-accent)] hover:bg-[var(--pl-accent-soft)]'
              } disabled:opacity-40 disabled:cursor-not-allowed`}
            >
              <InlineMarkdown text={c.text} />
              {c.cost && (
                <span className={`float-right text-sm ${affordable ? 'text-amber-300' : 'text-red-300'}`}>
                  {isPhoneCost ? `−${c.cost.amount} ${costLabel}` : `${c.cost.amount} ${costLabel}`}
                  {!affordable && ' · не хватает'}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
