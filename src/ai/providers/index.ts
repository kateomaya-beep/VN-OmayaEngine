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
  // Потолок токенов ответа. Без него многие шлюзы режут ответ по своему низкому
  // дефолту (512/1024) — отсюда «всегда короткий ход». Считаем от длины хода.
  maxTokens?: number;
  // Глубина размышления reasoning-моделей → reasoning_effort. Меньше = быстрее.
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
  // Отмена генерации: сигнал прерывания fetch (кнопка «Отменить» в игре).
  signal?: AbortSignal;
}

export interface Provider {
  complete(conn: ApiConnection, apiKey: string, req: CompletionRequest): Promise<string>;
  listModels(conn: ApiConnection, apiKey: string): Promise<string[]>;
}

const DEFAULT_OPENAI_BASE = 'https://api.openai.com/v1';
const DEFAULT_ANTHROPIC_BASE = 'https://api.anthropic.com/v1';

// Локальный прокси лаунчера (launcher/serve.mjs). Если приложение открыто через наш
// сервер, гоним запросы к провайдеру через /__proxy — это server-side запрос, CORS
// на него не действует (как в SillyTavern). Если прокси нет (чистая статика) —
// напрямую из браузера (тогда возможен CORS). Детект один раз.
let proxyState: 'unknown' | 'on' | 'off' = 'unknown';
let proxyProbe: Promise<void> | null = null;
async function ensureProxy(): Promise<void> {
  if (proxyState !== 'unknown') return;
  if (!proxyProbe) {
    proxyProbe = (async () => {
      try {
        const r = await fetch('/__proxy/health', { method: 'GET' });
        proxyState = r.ok && r.headers.get('x-vn-proxy') === '1' ? 'on' : 'off';
      } catch {
        proxyState = 'off';
      }
      logEvent(
        'info',
        'net',
        proxyState === 'on'
          ? 'Локальный прокси активен — запросы к ИИ идут через сервер (без CORS).'
          : 'Локального прокси нет — прямые запросы из браузера (возможен CORS).'
      );
    })();
  }
  await proxyProbe;
}

// Универсальный fetch: через прокси, если он есть; иначе напрямую.
async function netFetch(url: string, init: RequestInit): Promise<Response> {
  await ensureProxy();
  if (proxyState === 'on' && /^https?:\/\//i.test(url)) {
    const headers = { ...((init.headers as Record<string, string>) || {}), 'x-target-url': url };
    return fetch('/__proxy', { ...init, headers });
  }
  return fetch(url, init);
}

// Доступен ли прокси (для индикатора в UI). Гарантирует, что детект запущен.
export async function isProxyActive(): Promise<boolean> {
  await ensureProxy();
  return proxyState === 'on';
}

// Обёртка над fetch. Браузер НЕ раскрывает точную причину «Failed to fetch»
// (маскирует CORS/сеть/таймаут ради безопасности), поэтому не утверждаем, что это
// именно CORS — перечисляем реальные варианты и отдаём исходную ошибку как есть.
// Ретраев нет: решение повторить — за пользователем (кнопка «Повторить»).
async function apiFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await netFetch(url, init);
  } catch (e) {
    // Отмену пользователем пробрасываем как есть.
    if ((e as Error)?.name === 'AbortError') throw e;
    const detail = (e as Error)?.message || String(e);
    throw new Error(
      `Запрос к провайдеру не дошёл: «${detail}». Браузер не показывает точную причину — это одно из:\n` +
        `• CORS: провайдер не разрешает POST из браузера (тогда НЕ работает НИКОГДА на этом провайдере — модели-список грузится, а генерация нет). → шлюз с CORS (OpenRouter) или прокси.\n` +
        `• Сетевой сбой/таймаут: если ИНОГДА срабатывает — длинный запрос рвётся (у вас большой контекст). → уменьшите «Живое окно»/контекст и возьмите модель побыстрее.\n` +
        `• Пресет: включённый префилл или «управляемое размышление» некоторые провайдеры не принимают. → попробуйте выключить их в пресете.\n` +
        `Точную причину видно в консоли браузера (там CORS помечен явно).`
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

// Человекочитаемая ошибка HTTP от провайдера. Тело часто — HTML-страница шлюза
// (nginx 504 и т.п.); её НЕ вываливаем сырьём, а даём короткое понятное объяснение
// по коду статуса. `bodyText` — уже прочитанный текст ответа (может быть пустым).
const HTTP_HINTS: Record<number, string> = {
  400: 'некорректный запрос — возможно, провайдер не принимает какие-то параметры (префилл/размышление в пресете) или имя модели.',
  401: 'неверный или отсутствующий API-ключ.',
  403: 'доступ запрещён (ключ, модель или регион недоступны).',
  404: 'не найдено — проверьте Base URL и имя модели.',
  408: 'таймаут запроса на стороне провайдера.',
  413: 'слишком большой запрос — уменьшите контекст/«Живое окно».',
  429: 'слишком много запросов (rate limit) — подождите немного и повторите.',
  500: 'внутренняя ошибка сервера провайдера.',
  502: 'плохой шлюз (Bad Gateway) — временный сбой на стороне провайдера.',
  503: 'сервис недоступен (перегрузка/обслуживание) — попробуйте позже.',
  504: 'сервер провайдера не ответил вовремя (Gateway Time-out) — модель перегружена или слишком медленная.',
};
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

function htmlToText(s: string): string {
  const t = (s || '').trim();
  if (!t) return '';
  if (!/<[a-z!/]/i.test(t)) return t.slice(0, 300);
  const title = /<title[^>]*>([^<]+)<\/title>/i.exec(t)?.[1];
  if (title) return title.trim();
  return t
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

function providerHttpError(status: number, bodyText: string): Error {
  const hint = HTTP_HINTS[status];
  if (hint) {
    const tail = RETRYABLE.has(status)
      ? ' Нажмите «Повторить»; если повторяется — возьмите модель побыстрее или уменьшите контекст.'
      : '';
    return new Error(`Провайдер вернул ${status}: ${hint}${tail}`);
  }
  const detail = htmlToText(bodyText);
  return new Error(`Провайдер вернул ${status}${detail ? `: ${detail}` : ''}`);
}

const openAiCompatible: Provider = {
  async complete(conn, apiKey, req) {
    const base = (conn.baseUrl || DEFAULT_OPENAI_BASE).replace(/\/$/, '');
    const model = requireModel(req.model || conn.model);
    const messages = [{ role: 'system', content: req.system }, ...req.messages];
    if (req.prefill) messages.push({ role: 'assistant', content: req.prefill });
    const res = await apiFetch(`${base}/chat/completions`, {
      method: 'POST',
      signal: req.signal,
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({
        model,
        temperature: req.temperature,
        messages,
        ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
        ...(req.reasoningEffort ? { reasoning_effort: req.reasoningEffort } : {}),
      }),
    });
    if (!res.ok) throw providerHttpError(res.status, await res.text().catch(() => ''));
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('Пустой ответ провайдера');
    return req.prefill ? req.prefill + content : content;
  },
  async listModels(conn, apiKey) {
    const base = (conn.baseUrl || DEFAULT_OPENAI_BASE).replace(/\/$/, '');
    const res = await netFetch(`${base}/models`, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} });
    if (!res.ok) throw providerHttpError(res.status, await res.text().catch(() => ''));
    const data = await res.json();
    return parseModelList(data);
  },
};

const anthropic: Provider = {
  async complete(conn, apiKey, req) {
    const base = (conn.baseUrl || DEFAULT_ANTHROPIC_BASE).replace(/\/$/, '');
    const model = requireModel(req.model || conn.model);
    const messages = req.messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
    // Anthropic ЖЁСТКО отклоняет финальное assistant-сообщение с хвостовым пробелом/
    // переводом строки (напр. префилл "<thinking>\n") — обрезаем хвост.
    const pf = req.prefill ? req.prefill.replace(/\s+$/, '') : '';
    if (pf) messages.push({ role: 'assistant', content: pf });
    const res = await apiFetch(`${base}/messages`, {
      method: 'POST',
      signal: req.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({ model, max_tokens: req.maxTokens || 4096, temperature: req.temperature, system: req.system, messages }),
    });
    if (!res.ok) throw providerHttpError(res.status, await res.text().catch(() => ''));
    const data = await res.json();
    const content = data?.content?.[0]?.text;
    if (typeof content !== 'string') throw new Error('Пустой ответ провайдера');
    return pf ? pf + content : content;
  },
  async listModels(conn, apiKey) {
    const base = (conn.baseUrl || DEFAULT_ANTHROPIC_BASE).replace(/\/$/, '');
    const res = await netFetch(`${base}/models`, { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } });
    if (!res.ok) throw providerHttpError(res.status, await res.text().catch(() => ''));
    const data = await res.json();
    return parseModelList(data);
  },
};

// Терпимый разбор ответа /models: разные обёртки (data / models / result / сам массив)
// и разные поля идентификатора (id / name / model / slug / строка). Дедуп + сортировка.
// Так список не «теряет» модели из-за нестандартной формы ответа провайдера.
function parseModelList(data: any): string[] {
  const list: any[] = Array.isArray(data)
    ? data
    : Array.isArray(data?.data)
      ? data.data
      : Array.isArray(data?.models)
        ? data.models
        : Array.isArray(data?.result)
          ? data.result
          : Array.isArray(data?.data?.models)
            ? data.data.models
            : [];
  const ids = list
    .map((m) => (typeof m === 'string' ? m : m?.id || m?.name || m?.model || m?.slug))
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  return Array.from(new Set(ids)).sort();
}

export function getProvider(name: ApiConnection['provider']): Provider {
  return name === 'anthropic' ? anthropic : openAiCompatible;
}

// Основная игровая генерация — через ГЛОБАЛЬНОЕ подключение (Batch 3 §2).
export async function runCompletion(req: CompletionRequest): Promise<string> {
  const conn = getConnection();
  const model = req.model || conn.model || '(модель не выбрана)';
  // Диагностика: размер запроса + активны ли префилл/reasoning — чтобы по логам
  // сразу понять, не пресет ли мешает (некоторые провайдеры не принимают префилл).
  const reqChars = req.system.length + req.messages.reduce((n, m) => n + m.content.length, 0);
  const flags = [
    req.prefill ? `префилл(${req.prefill.length})` : null,
    req.reasoningEffort ? `reasoning:${req.reasoningEffort}` : null,
  ].filter(Boolean).join(', ');
  logEvent('info', 'llm', `Запрос → ${conn.provider} · ${model} · ~${Math.round(reqChars / 4)} ток.${flags ? ` · ${flags}` : ''}`);
  const started = Date.now();
  try {
    const out = await getProvider(conn.provider).complete(conn, getApiKey(conn.provider), req);
    logEvent('info', 'llm', `Ответ получен за ${Date.now() - started} мс (${out.length} симв.)`);
    return out;
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') {
      logEvent('info', 'llm', 'Генерация отменена пользователем');
    } else {
      logEvent('error', 'llm', (e as Error).message, (e as Error).stack);
    }
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
