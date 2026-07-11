import type { AiConfig, LlmMessage, ApiConnection } from '../../shared/types';
import { getApiKey } from '../keys';

export interface CompletionRequest {
  system: string;
  messages: LlmMessage[];
  model: string;
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

// OpenAI-compatible: OpenAI, OpenRouter, LM Studio, Ollama, etc.
const openAiCompatible: Provider = {
  async complete(conn, apiKey, req) {
    const base = (conn.baseUrl || DEFAULT_OPENAI_BASE).replace(/\/$/, '');
    const messages = [{ role: 'system', content: req.system }, ...req.messages];
    if (req.prefill) messages.push({ role: 'assistant', content: req.prefill });
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: req.model,
        temperature: req.temperature,
        messages,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Провайдер вернул ${res.status}: ${text.slice(0, 300)}`);
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('Пустой ответ провайдера');
    return req.prefill ? req.prefill + content : content;
  },
  async listModels(conn, apiKey) {
    const base = (conn.baseUrl || DEFAULT_OPENAI_BASE).replace(/\/$/, '');
    const res = await fetch(`${base}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });
    if (!res.ok) throw new Error(`Провайдер вернул ${res.status}`);
    const data = await res.json();
    const list = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
    return list.map((m: any) => m.id || m.name).filter((id: unknown) => typeof id === 'string').sort();
  },
};

// Anthropic Messages API (поддерживает assistant-префилл нативно).
const anthropic: Provider = {
  async complete(conn, apiKey, req) {
    const base = (conn.baseUrl || DEFAULT_ANTHROPIC_BASE).replace(/\/$/, '');
    const messages = req.messages.map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    }));
    if (req.prefill) messages.push({ role: 'assistant', content: req.prefill });
    const res = await fetch(`${base}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: req.model,
        max_tokens: 2048,
        temperature: req.temperature,
        system: req.system,
        messages,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Провайдер вернул ${res.status}: ${text.slice(0, 300)}`);
    }
    const data = await res.json();
    const content = data?.content?.[0]?.text;
    if (typeof content !== 'string') throw new Error('Пустой ответ провайдера');
    return req.prefill ? req.prefill + content : content;
  },
  async listModels(conn, apiKey) {
    const base = (conn.baseUrl || DEFAULT_ANTHROPIC_BASE).replace(/\/$/, '');
    const res = await fetch(`${base}/models`, {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    });
    if (!res.ok) throw new Error(`Провайдер вернул ${res.status}`);
    const data = await res.json();
    const list = Array.isArray(data?.data) ? data.data : [];
    return list.map((m: any) => m.id).filter((id: unknown) => typeof id === 'string').sort();
  },
};

export function getProvider(name: ApiConnection['provider']): Provider {
  return name === 'anthropic' ? anthropic : openAiCompatible;
}

// Ключ роли подключения: 'openai-compatible' | 'anthropic' для основной игровой
// связи (обратная совместимость с уже сохранёнными ключами), либо явная роль
// ('summary' | 'embeddings' | 'image') для отдельных подключений (см. CR v2 §G).
export function keyRoleFor(conn: ApiConnection, explicitRole?: string): string {
  return explicitRole ?? conn.provider;
}

export async function runCompletion(cfg: AiConfig, req: CompletionRequest): Promise<string> {
  const apiKey = getApiKey(cfg.provider);
  return getProvider(cfg.provider).complete(cfg, apiKey, req);
}

// Вариант с явным подключением (используется саммари/эмбеддингами — Block E/G):
// если conn не задан, используется основное игровое подключение проекта.
export async function runCompletionWith(
  cfg: AiConfig,
  conn: ApiConnection | undefined,
  keyRole: string,
  req: CompletionRequest
): Promise<string> {
  const effective: ApiConnection = conn || { provider: cfg.provider, baseUrl: cfg.baseUrl, model: cfg.model };
  const apiKey = conn ? getApiKey(keyRole) : getApiKey(cfg.provider);
  return getProvider(effective.provider).complete(effective, apiKey, {
    ...req,
    model: req.model || effective.model || cfg.model,
  });
}

export async function listModels(conn: ApiConnection, apiKey: string): Promise<string[]> {
  return getProvider(conn.provider).listModels(conn, apiKey);
}

export async function testConnection(
  conn: ApiConnection,
  apiKey: string
): Promise<{ ok: boolean; message: string }> {
  try {
    const models = await listModels(conn, apiKey);
    return { ok: true, message: models.length ? `OK · ${models.length} моделей` : 'OK' };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}
