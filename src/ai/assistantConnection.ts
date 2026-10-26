import { create } from 'zustand';
import type { ApiConnection } from '../shared/types';

// ОТДЕЛЬНОЕ ПОДКЛЮЧЕНИЕ ДЛЯ АССИСТЕНТА. Ассистенту-соавтору не обязательно сидеть
// на той же дорогой модели, что пишет историю: карточку, запись лорбука или правку
// пресета нормально сделает и модель подешевле. Включено и модель задана — его
// запросы идут сюда; выключено — как раньше, через основное подключение.
// Ключ — свой, под ролью 'assistant', в основной не подмешивается.

export const ASSISTANT_KEY_ROLE = 'assistant';
const LS_KEY = 'nf_assistant_conn';

export interface AssistantConnectionState {
  enabled: boolean;
  conn: ApiConnection;
}

const DEFAULT: AssistantConnectionState = {
  enabled: false,
  conn: { provider: 'openai-compatible', baseUrl: '' },
};

function load(): AssistantConnectionState {
  try {
    const v = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    if (!v || typeof v !== 'object' || !v.conn || typeof v.conn !== 'object') return DEFAULT;
    return {
      enabled: !!v.enabled,
      conn: {
        provider: v.conn.provider === 'anthropic' ? 'anthropic' : 'openai-compatible',
        baseUrl: typeof v.conn.baseUrl === 'string' ? v.conn.baseUrl : '',
        model: typeof v.conn.model === 'string' && v.conn.model ? v.conn.model : undefined,
        availableModels: Array.isArray(v.conn.availableModels) ? v.conn.availableModels.filter((x: unknown) => typeof x === 'string') : undefined,
      },
    };
  } catch {
    return DEFAULT;
  }
}

interface Store extends AssistantConnectionState {
  set: (p: Partial<AssistantConnectionState>) => void;
}

export const useAssistantConnection = create<Store>((set, get) => ({
  ...load(),
  set: (p) => {
    const next = { enabled: get().enabled, conn: get().conn, ...p };
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
    set(next);
  },
}));

/** Подключение для запросов ассистента; null — основное. */
export function assistantConnection(): { conn: ApiConnection; keyRole: string } | null {
  const { enabled, conn } = useAssistantConnection.getState();
  return enabled && conn.model ? { conn, keyRole: ASSISTANT_KEY_ROLE } : null;
}
