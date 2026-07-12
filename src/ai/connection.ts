import { create } from 'zustand';
import type { ApiConnection } from '../shared/types';

// Основное подключение к LLM — ГЛОБАЛЬНОЕ, не на проект (см. Batch 3 §2).
// Хранится в localStorage; ключ — в ai/keys под ролью провайдера. Доступно из
// верхней панели везде (главный экран и игра).

const LS_KEY = 'nf_connection';

function load(): ApiConnection {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const v = JSON.parse(raw);
      return {
        provider: v.provider === 'anthropic' ? 'anthropic' : 'openai-compatible',
        baseUrl: typeof v.baseUrl === 'string' ? v.baseUrl : 'https://api.openai.com/v1',
        model: typeof v.model === 'string' ? v.model : 'gpt-4o-mini',
        availableModels: Array.isArray(v.availableModels) ? v.availableModels : undefined,
      };
    }
  } catch {
    /* ignore */
  }
  return { provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' };
}

let current = load();

export function getConnection(): ApiConnection {
  return current;
}

interface ConnStore {
  connection: ApiConnection;
  setConnection: (c: ApiConnection) => void;
}

export const useConnection = create<ConnStore>((set) => ({
  connection: current,
  setConnection: (c) => {
    current = c;
    localStorage.setItem(LS_KEY, JSON.stringify(c));
    set({ connection: c });
  },
}));
