import { create } from 'zustand';
import type { ApiConnection } from '../shared/types';
import { runCompletion, type CompletionRequest } from './providers';
import { getApiKey } from './keys';
import { getConnection } from './connection';

// ОТДЕЛЬНЫЙ ТЕКСТОВЫЙ API ДЛЯ СТУДИИ КАРТИНОК. Промпты к картинкам (воркер сцены,
// теги NovelAI, «✨ из анкеты», «✨ В теги NovelAI», ассистент ручного режима,
// иллюстрации в тексте, фоны) не обязаны идти через ту же модель, что пишет
// историю: можно взять другую модель или другой адрес. Галочка выключена или
// модель не выбрана — всё идёт через основное подключение, как раньше.
// Подключение общее для всех историй (как и image-API), ключ — свой, роль 'studio'.

export const STUDIO_KEY_ROLE = 'studio';
const LS_KEY = 'nf_studio_text_conn';

export interface StudioConnectionState {
  enabled: boolean;
  conn: ApiConnection;
}

const DEFAULT: StudioConnectionState = { enabled: false, conn: { provider: 'openai-compatible', baseUrl: '' } };

function load(): StudioConnectionState {
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

interface Store extends StudioConnectionState {
  set: (p: Partial<StudioConnectionState>) => void;
}

export const useStudioConnection = create<Store>((set, get) => ({
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

const sameBase = (a?: string, b?: string) => (a || '').trim().replace(/\/+$/, '') === (b || '').trim().replace(/\/+$/, '');

/**
 * Под какой ролью брать ключ. Свой ключ студии не вписан, а адрес тот же, что у
 * основного, — берём ключ основного: иначе запрос уходит без ключа, и шлюз
 * отвечает 401 («Invalid API key format»), хотя список моделей (часто без ключа)
 * подтянулся и всё выглядит настроенным.
 */
export function studioKeyRole(conn: ApiConnection): string {
  if (getApiKey(STUDIO_KEY_ROLE).trim()) return STUDIO_KEY_ROLE;
  const main = getConnection();
  return main.provider === conn.provider && sameBase(main.baseUrl, conn.baseUrl) ? main.provider : STUDIO_KEY_ROLE;
}

/** Подключение для текстовых задач студии; null — основное. */
export function studioConnection(): { conn: ApiConnection; keyRole: string } | null {
  const { enabled, conn } = useStudioConnection.getState();
  return enabled && conn.model ? { conn, keyRole: studioKeyRole(conn) } : null;
}

/**
 * Запрос текстовой задачи студии: со своим подключением — его модель (модель
 * «саммари» проекта к чужому адресу не подходит), без него — как был.
 */
export function studioRequest(req: CompletionRequest): CompletionRequest {
  const c = studioConnection();
  return c ? { ...req, connection: c, model: c.conn.model } : req;
}

/**
 * Текстовая задача студии. Ошибка подписывается, через какое подключение шёл
 * запрос: иначе «401 — неверный ключ» читается как беда основного подключения,
 * которое при этом исправно пишет историю.
 */
export async function studioCompletion(req: CompletionRequest): Promise<string> {
  const c = studioConnection();
  try {
    return await runCompletion(c ? { ...req, connection: c, model: c.conn.model } : req);
  } catch (e) {
    if (!c || (e as Error)?.name === 'AbortError') throw e;
    const err = new Error(
      `Отдельный текстовый API студии (${c.conn.model}, ${c.conn.baseUrl || 'адрес не задан'}): ${(e as Error).message}\n` +
        'Проверьте его ключ в «Подключении к image-API» → «✍️ Отдельный текстовый API для студии» — или снимите галочку, тогда студия пойдёт через основное подключение.'
    );
    err.name = (e as Error).name;
    throw err;
  }
}
