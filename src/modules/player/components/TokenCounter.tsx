import { useEffect, useState } from 'react';
import type { Project, RuntimeState } from '../../../shared/types';
import { estimateContextBreakdown } from '../../../ai/promptBuilder';
import { getPresetSettings } from '../../../ai/presetSettings';
import { isCalibrated, lastTurnUsage } from '../../../ai/tokenCalibration';
import { activeTokenizer, TOKENIZER_LABEL } from '../../../ai/tokenCount';

// Живой счётчик токенов/контекста (см. CR v2 §J) — пересчитывается после каждого
// хода (не на каждый рендер), чтобы не грузить лишний раз. По нажатию — состав
// запроса: что сколько занимает, и сколько насчитал провайдер на прошлом ходу.
export function TokenCounter({ project, state }: { project: Project; state: RuntimeState }) {
  const [data, setData] = useState<{ total: number; parts: { label: string; tokens: number }[]; exact: boolean } | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    estimateContextBreakdown(project, state, '').then((d) => {
      if (alive) setData(d);
    });
    return () => {
      alive = false;
    };
  }, [state.turnCount, state.history.length]);

  if (!data) return null;
  const budget = getPresetSettings().contextBudget;
  const over = data.total > budget;
  const real = lastTurnUsage();
  const max = Math.max(1, ...data.parts.map((p) => p.tokens));

  return (
    <div className="relative">
      <button
        className={`nf-tok-counter bg-black/60 backdrop-blur rounded-lg px-2.5 py-1 text-[11px] ${over ? 'text-amber-400' : 'text-gray-400'}`}
        title="Размер запроса к ИИ — нажмите, чтобы увидеть состав"
        onClick={() => setOpen((v) => !v)}
      >
        {data.exact ? '' : '≈'}
        {data.total.toLocaleString('ru')} / {budget.toLocaleString('ru')} ток. {open ? '▴' : '▾'}
      </button>
      {open && (
        <div className="nf-tok-breakdown absolute right-0 z-20 mt-1 w-72 max-w-[85vw] rounded-xl border border-white/10 bg-panel p-3 shadow-xl text-[11px] text-gray-300">
          <div className="font-semibold text-xs mb-2">Из чего состоит запрос</div>
          <div className="space-y-1.5">
            {data.parts.map((p) => (
              <div key={p.label}>
                <div className="flex justify-between gap-2">
                  <span className="truncate">{p.label}</span>
                  <span className="text-gray-400 shrink-0">{p.tokens.toLocaleString('ru')}</span>
                </div>
                <div className="h-1 rounded bg-white/5 overflow-hidden">
                  <div className="h-full bg-accent2/70" style={{ width: `${Math.round((p.tokens / max) * 100)}%` }} />
                </div>
              </div>
            ))}
          </div>
          <div className="mt-2.5 pt-2 border-t border-white/10 text-gray-400 space-y-1">
            {real ? (
              <div>
                Прошлый ход по счёту провайдера: <b className="text-gray-200">{real.promptTokens.toLocaleString('ru')}</b> ток.
                {real.cachedTokens ? ` (из кэша ${real.cachedTokens.toLocaleString('ru')})` : ''}
                {real.estimate ? ` · прикидка была ${real.estimate.toLocaleString('ru')}` : ''}
              </div>
            ) : (
              <div>Счёт провайдера появится после хода (если шлюз его отдаёт).</div>
            )}
            <div>
              {data.exact
                ? `Посчитано точно — ${TOKENIZER_LABEL[activeTokenizer() ?? 'gemma3']}, как у провайдера. Бюджет держится по этому счёту.`
                : isCalibrated()
                  ? 'У этой модели словарь не опубликован — счёт приблизительный (≈), подстроен под счёт провайдера.'
                  : 'У этой модели словарь не опубликован — счёт приблизительный (≈); после первого хода подстроится под счёт провайдера.'}
            </div>
            <div>
              Бюджет — цель, а не только потолок: живая история растёт до него, потом сворачивается в память. Меньше бюджет —
              дешевле ход.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
