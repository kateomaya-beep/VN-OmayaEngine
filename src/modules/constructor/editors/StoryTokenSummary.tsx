import { useEffect, useState } from 'react';
import type { Project, RuntimeState } from '../../../shared/types';
import { normalizeNarrativeMode } from '../../../shared/types';
import { normalizeRuntimeState } from '../../../shared/factory';
import { activePlaythrough } from '../../../storage/playthroughs';
import { usePresetSettings } from '../../../ai/presetSettings';
import { storyBaseRows, type SummaryRow } from '../../../ai/tokenSummary';
import { ExactTokensNote, formatTokens, useTokenCount } from '../../../shared/TokenBadge';

// СКОЛЬКО ВЕСИТ ИСТОРИЯ — сводка на странице истории: персонажи, мир, лорбук,
// пресет и память последнего прохождения, у каждого раздела свои токены. Как в
// Таверне, только сразу по всей базе: видно, что раздуто, ещё до первого хода.

function Row({ row, max, depth = 0 }: { row: SummaryRow; max: number; depth?: number }) {
  const [open, setOpen] = useState(false);
  const { n, exact } = useTokenCount(row.texts);
  const kids = row.children?.length ? row.children : null;
  return (
    <div className={depth ? 'pl-4' : ''}>
      <button
        className={`nf-sum-row w-full text-left ${kids ? 'cursor-pointer' : 'cursor-default'}`}
        onClick={() => kids && setOpen((v) => !v)}
      >
        <div className="flex justify-between gap-2 text-xs">
          <span className={`truncate ${depth ? 'text-gray-400' : 'text-gray-200'}`}>
            {kids ? (open ? '▾ ' : '▸ ') : ''}
            {row.label}
          </span>
          <span className="tabular-nums text-gray-300 shrink-0" data-tokens={n}>
            {formatTokens(n, exact)}
          </span>
        </div>
        <div className="h-1 rounded bg-white/5 overflow-hidden mt-0.5">
          <div className="h-full bg-accent2/70" style={{ width: `${Math.min(100, Math.round((n / Math.max(1, max)) * 100))}%` }} />
        </div>
      </button>
      {row.note && !depth && <p className="text-[10px] text-gray-500 mt-0.5">{row.note}</p>}
      {open && kids && (
        <div className="mt-1.5 space-y-1.5">
          {kids.map((k) => (
            <Row key={k.key} row={k} max={max} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

export function StoryTokenSummary({ project }: { project: Project }) {
  const ps = usePresetSettings((s) => s.settings);
  const mode = normalizeNarrativeMode(project.mode);
  // Память — у прохождения, не у проекта: берём то, что открывает «Продолжить».
  const [state, setState] = useState<RuntimeState | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const info = await activePlaythrough(project.id);
        const save = info?.autosave || info?.checkpoints[info.checkpoints.length - 1];
        if (alive && save?.state) setState(normalizeRuntimeState(save.state, project));
      } catch {
        /* прохождений нет — сводка по проекту */
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  const rows = storyBaseRows(project, ps, mode, state);
  const total = useTokenCount(rows.flatMap((r) => r.texts));
  const budget = ps.contextBudget;
  const max = Math.max(1, total.n);

  return (
    <div className="card nf-story-tokens">
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <h4 className="font-semibold">Сколько весит история</h4>
        <span className="nf-story-total text-sm tabular-nums text-gray-200" data-tokens={total.n}>
          {formatTokens(total.n, total.exact)}
        </span>
      </div>
      <p className="text-xs text-gray-500 mb-3">
        Вся база целиком: {Math.round((total.n / Math.max(1, budget)) * 100)}% от бюджета контекста (
        {budget.toLocaleString('ru')} ток.). В каждый запрос уходит не всё: лорбук по ключам — когда ключ
        прозвучал, анкеты целиком — у тех, кто в фокусе. Что ушло на самом деле — в счётчике вверху игры.
      </p>
      <div className="space-y-2.5">
        {rows.map((r) => (
          <Row key={r.key} row={r} max={max} />
        ))}
      </div>
      <ExactTokensNote />
    </div>
  );
}
