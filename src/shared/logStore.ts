import { create } from 'zustand';
import { uid } from './utils';

// Внутриигровой лог событий/ошибок (как консоль в SillyTavern, только в интерфейсе).
// Ловит: запросы к ИИ, саммаризацию, ошибки парсинга/импорта, необработанные
// исключения и «повисшие» операции. Смотреть — в панели логов на верхней панели.

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface LogEntry {
  id: string;
  t: number; // timestamp
  level: LogLevel;
  source: string; // llm / memory / turn / import / window …
  message: string;
  detail?: string; // стек/тело ответа и т.п.
}

const MAX = 400;

interface LogStore {
  logs: LogEntry[];
  add: (level: LogLevel, source: string, message: string, detail?: string) => void;
  clear: () => void;
}

export const useLogs = create<LogStore>((set) => ({
  logs: [],
  add: (level, source, message, detail) =>
    set((s) => {
      const entry: LogEntry = {
        id: uid('log'),
        t: Date.now(),
        level,
        source,
        message: String(message ?? '').slice(0, 2000),
        detail: detail ? String(detail).slice(0, 4000) : undefined,
      };
      const logs = [...s.logs, entry];
      return { logs: logs.length > MAX ? logs.slice(-MAX) : logs };
    }),
  clear: () => set({ logs: [] }),
}));

// Не-хук хелпер — для использования из движка/провайдеров (вне React).
export function logEvent(level: LogLevel, source: string, message: unknown, detail?: unknown): void {
  useLogs.getState().add(level, source, String((message as any)?.message ?? message), detail as any);
  // Дублируем в консоль браузера (DevTools) — на случай, если панель не открыта.
  const line = `[NovelForge:${source}] ${String((message as any)?.message ?? message)}`;
  if (level === 'error') console.error(line, detail ?? '');
  else if (level === 'warn') console.warn(line);
}
