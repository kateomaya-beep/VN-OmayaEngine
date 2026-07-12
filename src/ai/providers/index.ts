import type { LlmMessage, ApiConnection } from '../../shared/types';
import { getApiKey } from '../keys';
import { getConnection } from '../connection';
import { logEvent } from '../../shared/logStore';

export interface CompletionRequest {
  system: string;
  messages: LlmMessage[];
  model?: string;
  temperature: number;
  // Опциональный префилл: начало ответа ассистента (напр. '{"scene":') для
  // стабилизации чистого JSON. Провайдер добавляет его как хвостовой assistant-
  // message и ПРЕПЕНДИТ обратно к результату, чтобы вернуть полный текст.
  prefill?: string;
}

export interface Provider {
  complete(conn: ApiConnection, apiKey: string, req: CompletionRequest): Promise<string>;
  listModels(conn: ApiConnection, apiKey: string): Promise<string[]>;
}

const DEFAULT_OPENAI_BASE = 'https://api.openai.com/v1';
const DEFAULT_ANTHROPIC_BASE = 'https://api.anthropic.com/v1';

// Обёртка над fetch: превращает «глухую» сетевую ошибку/CORS (TypeError: Failed to
// fetch) в понятное сообщение. Частый кейс: список моделей грузится (GET), а
// генерация (POST) блокируется CORS — провайдер не разрешает прямой запрос из
// браузера. В SillyTavern работает, потому что там запрос идёт через свой сервер.
async function apiFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    throw new Error(
      'Не удалось связаться с провайдером напрямую из браузера (сеть или CORS). ' +
        'Часто это CORS: провайдер не разрешает запрос из браузера — тогда модели ' +
        'грузятся, а генерация нет. В SillyTavern работает, потому что запрос идёт ' +
        'через сервер. Возьмите провайдера/шлюз с поддержкой CORS (например OpenRouter) ' +
        'или прокси. [' + (e as Error).message + ']'
    );
  }
}

function requireModel(model: string | undefined): string {
  if (!model || !model.trim()) {
    throw new Error(
      'Не выбрана модель. Откройте «Подключение к ИИ» (🔌), нажмите ⟳ рядом с полем ' +
        '«Модель» и ВЫБЕРИТЕ модель вашего провайдера из списка (по умолчанию стоит ' +
        'gpt-4o-mini, которой у вашего провайдера может не быть).'
    );
  }
  return model;
}

const openAiCompatible: Provider = {
  async complete(conn, apiKey, req) {
    const base = (conn.baseUrl || DEFAULT_OPENAI_BASE).replace(/\/$/, '');
    const model = requireModel(req.model || conn.model);
    const messages = [{ role: 'system', content: req.system }, ...req.messages];
    if (req.prefill) messages.push({ role: 'assistant', content: req.prefill });
    const res = await apiFetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model, temperature: req.temperature, messages }),
    });
    if (!res.ok) throw new Error(`Провайдер вернул ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('Пустой ответ провайдера');
    return req.prefill ? req.prefill + content : content;
  },
  async listModels(conn, apiKey) {
    const base = (conn.baseUrl || DEFAULT_OPENAI_BASE).replace(/\/$/, '');
    const res = await fetch(`${base}/models`, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} });
    if (!res.ok) throw new Error(`Провайдер вернул ${res.status}`);
    const data = await res.json();
    const list = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
    return list.map((m: any) => m.id || m.name).filter((id: unknown) => typeof id === 'string').sort();
  },
};

const anthropic: Provider = {
  async complete(conn, apiKey, req) {
    const base = (conn.baseUrl || DEFAULT_ANTHROPIC_BASE).replace(/\/$/, '');
    const model = requireModel(req.model || conn.model);
    const messages = req.messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
    if (req.prefill) messages.push({ role: 'assistant', content: req.prefill });
    const res = await apiFetch(`${base}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({ model, max_tokens: 4096, temperature: req.temperature, system: req.system, messages }),
    });
    if (!res.ok) throw new Error(`Провайдер вернул ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
    const data = await res.json();
    const content = data?.content?.[0]?.text;
    if (typeof content !== 'string') throw new Error('Пустой ответ провайдера');
    return req.prefill ? req.prefill + content : content;
  },
  async listModels(conn, apiKey) {
    const base = (conn.baseUrl || DEFAULT_ANTHROPIC_BASE).replace(/\/$/, '');
    const res = await fetch(`${base}/models`, { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } });
    if (!res.ok) throw new Error(`Провайдер вернул ${res.status}`);
    const data = await res.json();
    const list = Array.isArray(data?.data) ? data.data : [];
    return list.map((m: any) => m.id).filter((id: unknown) => typeof id === 'string').sort();
  },
};

export function getProvider(name: ApiConnection['provider']): Provider {
  return name === 'anthropic' ? anthropic : openAiCompatible;
}

// Основная игровая генерация — через ГЛОБАЛЬНОЕ подключение (Batch 3 §2).
export async function runCompletion(req: CompletionRequest): Promise<string> {
  const conn = getConnection();
  const model = req.model || conn.model || '(модель не выбрана)';
  logEvent('info', 'llm', `Запрос → ${conn.provider} · ${model}`);
  const started = Date.now();
  try {
    const out = await getProvider(conn.provider).complete(conn, getApiKey(conn.provider), req);
    logEvent('info', 'llm', `Ответ получен за ${Date.now() - started} мс (${out.length} симв.)`);
    return out;
  } catch (e) {
    logEvent('error', 'llm', (e as Error).message, (e as Error).stack);
    throw e;
  }
}

// Явное подключение (саммари/эмбеддинги); нет — берём глобальное основное.
export async function runCompletionWith(
  conn: ApiConnection | undefined,
  keyRole: string,
  req: CompletionRequest
): Promise<string> {
  const effective = conn || getConnection();
  const apiKey = conn ? getApiKey(keyRole) : getApiKey(effective.provider);
  try {
    return await getProvider(effective.provider).complete(effective, apiKey, {
      ...req,
      model: req.model || effective.model,
    });
  } catch (e) {
    logEvent('error', 'llm', 'Доп. запрос (' + keyRole + '): ' + (e as Error).message);
    throw e;
  }
}

export async function listModels(conn: ApiConnection, apiKey: string): Promise<string[]> {
  return getProvider(conn.provider).listModels(conn, apiKey);
}

export async function testConnection(conn: ApiConnection, apiKey: string): Promise<{ ok: boolean; message: string }> {
  try {
    const models = await listModels(conn, apiKey);
    return { ok: true, message: models.length ? `OK · ${models.length} моделей` : 'OK' };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}
