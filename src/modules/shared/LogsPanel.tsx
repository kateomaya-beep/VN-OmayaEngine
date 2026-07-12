import { useState } from 'react';
import { Modal } from '../../shared/ui';
import { useLogs, type LogLevel } from '../../shared/logStore';

// Панель логов (как консоль в SillyTavern, только в интерфейсе). Видно запросы к
// ИИ, саммаризацию, ошибки парсинга/импорта и необработанные исключения — удобно
// ловить «вечную загрузку» и молчаливые сбои.
const LEVEL_STYLE: Record<LogLevel, string> = {
  error: 'text-red-300 border-red-500/40',
  warn: 'text-amber-300 border-amber-400/40',
  info: 'text-gray-300 border-white/10',
  debug: 'text-gray-500 border-white/10',
};

function fmtTime(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function LogsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { logs, clear } = useLogs();
  const [filter, setFilter] = useState<'all' | LogLevel>('all');
  const [expanded, setExpanded] = useState<string | null>(null);
  if (!open) return null;

  const shown = (filter === 'all' ? logs : logs.filter((l) => l.level === filter)).slice().reverse();
  const errorCount = logs.filter((l) => l.level === 'error').length;

  const copyAll = () => {
    const text = logs
      .map((l) => `${fmtTime(l.t)} [${l.level}] ${l.source}: ${l.message}${l.detail ? '\n  ' + l.detail : ''}`)
      .join('\n');
    navigator.clipboard?.writeText(text).catch(() => {});
  };

  const FILTERS: ('all' | LogLevel)[] = ['all', 'error', 'warn', 'info'];

  return (
    <Modal open={open} onClose={onClose} title="Логи (события и ошибки)" wide>
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        {FILTERS.map((f) => (
          <button
            key={f}
            className={`chip !px-3 !py-1.5 text-xs ${filter === f ? 'bg-accent2 text-white' : ''}`}
            onClick={() => setFilter(f)}
          >
            {f === 'all' ? 'Все' : f === 'error' ? `Ошибки${errorCount ? ` (${errorCount})` : ''}` : f}
          </button>
        ))}
        <div className="ml-auto flex gap-2">
          <button className="btn-ghost !px-3 !py-1 text-xs" onClick={copyAll}>
            Копировать всё
          </button>
          <button className="btn-ghost !px-3 !py-1 text-xs" onClick={clear}>
            Очистить
          </button>
        </div>
      </div>

      <p className="text-xs text-gray-500 mb-2">
        Здесь видно запросы к ИИ, саммаризацию, импорт и сбои. Если «вечная загрузка» —
        посмотрите последнюю запись: есть ли ошибка после «Запрос → …».
      </p>

      <div className="max-h-[55vh] overflow-y-auto scrollbar-thin space-y-1 font-mono text-xs">
        {shown.length === 0 && <p className="text-gray-600">— пусто —</p>}
        {shown.map((l) => (
          <div
            key={l.id}
            className={`rounded border px-2 py-1.5 bg-panel2 ${LEVEL_STYLE[l.level]} ${
              l.detail ? 'cursor-pointer' : ''
            }`}
            onClick={() => l.detail && setExpanded(expanded === l.id ? null : l.id)}
          >
            <div className="flex gap-2">
              <span className="text-gray-500 shrink-0">{fmtTime(l.t)}</span>
              <span className="text-gray-500 shrink-0">[{l.source}]</span>
              <span className="break-words">{l.message}</span>
            </div>
            {l.detail && expanded === l.id && (
              <pre className="mt-1 whitespace-pre-wrap text-gray-500 text-[11px]">{l.detail}</pre>
            )}
          </div>
        ))}
      </div>
    </Modal>
  );
}
