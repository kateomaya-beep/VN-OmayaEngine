import { useEffect, useState } from 'react';
import type { Project, RuntimeState } from '../../../shared/types';
import { estimateContextTokens } from '../../../ai/promptBuilder';

// Живой счётчик токенов/контекста (см. CR v2 §J) — пересчитывается после каждого
// хода (не на каждый рендер), чтобы не грузить лишний раз.
export function TokenCounter({ project, state }: { project: Project; state: RuntimeState }) {
  const [tokens, setTokens] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    estimateContextTokens(project, state, '').then((t) => {
      if (alive) setTokens(t);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.turnCount, state.history.length]);

  if (tokens === null) return null;
  const budget = project.aiConfig.contextBudget;
  const over = tokens > budget;

  return (
    <div
      className={`bg-black/60 backdrop-blur rounded-lg px-2.5 py-1 text-[11px] ${
        over ? 'text-amber-400' : 'text-gray-400'
      }`}
      title="Оценка размера контекста запроса к ИИ"
    >
      ~{tokens.toLocaleString()} / {budget.toLocaleString()} ток.
    </div>
  );
}
