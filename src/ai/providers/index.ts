import type { AiConfig, LlmMessage } from '../../shared/types';
import { getApiKey } from '../keys';

export interface CompletionRequest {
  system: string;
  messages: LlmMessage[];
  model: string;
  temperature: number;
}

// A provider adapter turns our neutral request into a call to a specific API.
export interface Provider {
  complete(cfg: AiConfig, req: CompletionRequest): Promise<string>;
}

const DEFAULT_OPENAI_BASE = 'https://api.openai.com/v1';
const DEFAULT_ANTHROPIC_BASE = 'https://api.anthropic.com/v1';

// OpenAI-compatible: OpenAI, OpenRouter, LM Studio, Ollama, etc.
const openAiCompatible: Provider = {
  async complete(cfg, req) {
    const key = getApiKey('openai-compatible');
    const base = (cfg.baseUrl || DEFAULT_OPENAI_BASE).replace(/\/$/, '');
    const messages = [{ role: 'system', content: req.system }, ...req.messages];
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
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
    return content;
  },
};

// Anthropic Messages API.
const anthropic: Provider = {
  async complete(cfg, req) {
    const key = getApiKey('anthropic');
    const base = (cfg.baseUrl || DEFAULT_ANTHROPIC_BASE).replace(/\/$/, '');
    const res = await fetch(`${base}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: req.model,
        max_tokens: 2048,
        temperature: req.temperature,
        system: req.system,
        messages: req.messages.map((m) => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: m.content,
        })),
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Провайдер вернул ${res.status}: ${text.slice(0, 300)}`);
    }
    const data = await res.json();
    const content = data?.content?.[0]?.text;
    if (typeof content !== 'string') throw new Error('Пустой ответ провайдера');
    return content;
  },
};

export function getProvider(name: AiConfig['provider']): Provider {
  return name === 'anthropic' ? anthropic : openAiCompatible;
}

export async function runCompletion(cfg: AiConfig, req: CompletionRequest): Promise<string> {
  return getProvider(cfg.provider).complete(cfg, req);
}
