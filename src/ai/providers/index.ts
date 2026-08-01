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
  // Картинки к ПОСЛЕДНЕМУ ходу игрока (vision): фото, которое герой отправил в
  // мессенджере. Модель без поддержки картинок отвечает 400 — тогда провайдер
  // повторяет запрос без вложений, и переписка продолжается по текстовой пометке.
  attachments?: { mime: string; b64: string }[];
  // Отмена генерации: сигнал прерывания fetch (кнопка «Отменить» в игре).
  signal?: AbortSignal;
}

export interface Provider {
  complete(conn: ApiConnection, apiKey: string, req: CompletionRequest): Promise<string>;
  listModels(conn: ApiConnection, apiKey: string): Promise<string[]>;
}

// Текст ответа: строка ИЛИ массив частей ([{type:'text',text:'…'}]) — так отдают
// некоторые шлюзы (особенно для reasoning-моделей). null = поля вообще нет.
function normalizeContent(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    return v
      .map((p) => (typeof p === 'string' ? p : typeof (p as any)?.text === 'string' ? (p as any).text : ''))
      .join('');
  }
  return null;
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
export async function netFetch(url: string, init: RequestInit): Promise<Response> {
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

// Сообщение провайдера из тела ответа (JSON вида {error:{message}} у большинства
// OpenAI-совместимых шлюзов). Без него на 400 виден лишь наш общий хинт, а реальная
// причина («context length exceeded», «unknown model», «temperature not supported»)
// теряется — именно из-за этого «апи рабочий, а что не так — непонятно».
function providerMessage(bodyText: string): string {
  const t = (bodyText || '').trim();
  if (!t) return '';
  try {
    const j = JSON.parse(t);
    const m = j?.error?.message ?? j?.message ?? j?.error ?? j?.detail;
    if (typeof m === 'string' && m.trim()) return m.trim().slice(0, 300);
  } catch {
    /* не JSON — ниже разберём как текст/HTML */
  }
  return htmlToText(t);
}

function providerHttpError(status: number, bodyText: string): Error {
  const detail = providerMessage(bodyText);
  const hint = HTTP_HINTS[status];
  if (hint) {
    const tail = RETRYABLE.has(status)
      ? ' Нажмите «Повторить»; если повторяется — возьмите модель побыстрее или уменьшите контекст.'
      : '';
    // Текст провайдера показываем ВСЕГДА, когда он есть: он точнее нашего хинта.
    return new Error(`Провайдер вернул ${status}: ${hint}${tail}${detail ? `\nОтвет провайдера: ${detail}` : ''}`);
  }
  return new Error(`Провайдер вернул ${status}${detail ? `: ${detail}` : ''}`);
}

// Пустые сообщения — частая причина 400 («content must not be empty») у Anthropic,
// Gemini и ряда шлюзов. В наш промпт они попасть не должны, но подстраховываемся
// централизованно, чтобы одна пустая заметка не роняла весь ход.
function sanitizeMessages(msgs: LlmMessage[]): LlmMessage[] {
  return msgs.filter((m) => typeof m.content === 'string' && m.content.trim().length > 0);
}

// Прикрепляет картинки к последнему сообщению игрока. Формат частей — общий для
// OpenAI-совместимых (image_url с data-URL); у Anthropic своя форма (см. ниже).
function attachImagesOpenAi(
  msgs: { role: string; content: unknown }[],
  attachments: { mime: string; b64: string }[]
): void {
  const idx = msgs.map((m) => m.role).lastIndexOf('user');
  if (idx < 0) return;
  const text = typeof msgs[idx].content === 'string' ? (msgs[idx].content as string) : '';
  msgs[idx] = {
    role: 'user',
    content: [
      { type: 'text', text },
      ...attachments.map((a) => ({ type: 'image_url', image_url: { url: `data:${a.mime};base64,${a.b64}` } })),
    ],
  };
}

const openAiCompatible: Provider = {
  async complete(conn, apiKey, req) {
    const base = (conn.baseUrl || DEFAULT_OPENAI_BASE).replace(/\/$/, '');
    const model = requireModel(req.model || conn.model);
    const messages: { role: string; content: unknown }[] = [
      { role: 'system', content: req.system },
      ...sanitizeMessages(req.messages),
    ];
    if (req.attachments?.length) attachImagesOpenAi(messages, req.attachments);
    if (req.prefill?.trim()) messages.push({ role: 'assistant', content: req.prefill });
    const body: Record<string, unknown> = {
      model,
      temperature: req.temperature,
      messages,
      ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
      ...(req.reasoningEffort ? { reasoning_effort: req.reasoningEffort } : {}),
    };
    const post = (b: Record<string, unknown>) =>
      apiFetch(`${base}/chat/completions`, {
        method: 'POST',
        signal: req.signal,
        headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify(b),
      });
    let res = await post(body);
    // Адаптация под капризы шлюзов: параметры вне базового набора OpenAI-совместимые
    // провайдеры принимают по-разному. На 400 пробуем починить тело и повторить ОДИН раз:
    //  - reasoning_effort не знают многие (или не принимают 'none') → убираем;
    //  - новые модели OpenAI требуют max_completion_tokens вместо max_tokens.
    if (res.status === 400) {
      const errText = await res.text().catch(() => '');
      const b2 = { ...body };
      let fixes: string[] = [];
      if ('reasoning_effort' in b2 && (/reason/i.test(errText) || !/max_tokens|max_completion|temperature|context|token/i.test(errText))) {
        delete b2.reasoning_effort;
        fixes.push('без reasoning_effort');
      }
      if (/max_completion_tokens/i.test(errText) && 'max_tokens' in b2) {
        b2.max_completion_tokens = b2.max_tokens;
        delete b2.max_tokens;
        fixes.push('max_tokens → max_completion_tokens');
      }
      // Reasoning-модели (o-series, gpt-5 и их клоны на шлюзах) принимают только
      // temperature = 1 и отвечают 400 на любое другое значение.
      if (/temperature/i.test(errText) && 'temperature' in b2) {
        delete b2.temperature;
        fixes.push('без temperature');
      }
      // Модель не умеет картинки — повторяем без вложений: пусть ответит хотя бы
      // по текстовой пометке «герой прислал фото», а не роняет всю переписку.
      if (req.attachments?.length && /image|vision|multimodal|content.*type|unsupported/i.test(errText)) {
        const plain = [{ role: 'system', content: req.system }, ...sanitizeMessages(req.messages)] as {
          role: string;
          content: unknown;
        }[];
        if (req.prefill?.trim()) plain.push({ role: 'assistant', content: req.prefill });
        logEvent('warn', 'llm', 'Модель не приняла картинку — повторяю запрос без вложения');
        res = await post({ ...b2, messages: plain });
        if (res.ok) {
          const data = await res.json();
          const content = normalizeContent(data?.choices?.[0]?.message?.content);
          if (content === null) throw new Error('Пустой ответ провайдера');
          return req.prefill ? req.prefill + content : content;
        }
        throw providerHttpError(res.status, await res.text().catch(() => errText));
      }
      // Контекст не влез: повторяем с тем же телом смысла нет — объясняем прямо.
      if (/context length|context_length|too many tokens|input token|maximum context|token count/i.test(errText)) {
        throw new Error(
          `Провайдер вернул 400: запрос не помещается в контекст модели.\n` +
            `Уменьшите «Бюджет контекста» и «Живое окно» в пресете (🎚) или возьмите модель с бо́льшим контекстом.` +
            `\nОтвет провайдера: ${providerMessage(errText)}`
        );
      }
      if (!fixes.length) throw providerHttpError(400, errText);
      logEvent('info', 'llm', `HTTP 400 — повторяю (${fixes.join(', ')})`);
      res = await post(b2);
      if (!res.ok) throw providerHttpError(res.status, await res.text().catch(() => errText));
    }
    if (!res.ok) throw providerHttpError(res.status, await res.text().catch(() => ''));
    const data = await res.json();
    const choice = data?.choices?.[0];
    const content = normalizeContent(choice?.message?.content);
    if (content === null) throw new Error('Пустой ответ провайдера');
    // Пустая строка при finish_reason=length — модель израсходовала бюджет на скрытое
    // «размышление» и до видимого текста не дошла. Логируем причину: иначе наверху
    // виден лишь пустой ответ (в мессенджере это выглядело как «три точки»).
    if (!content.trim()) {
      logEvent(
        'error',
        'llm',
        `Пустой текст в ответе (finish_reason: ${choice?.finish_reason ?? '—'}). ` +
          'Вероятно, весь бюджет токенов ушёл на reasoning — увеличьте лимит или снизьте глубину размышления.'
      );
    }
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
    const messages: { role: string; content: unknown }[] = sanitizeMessages(req.messages).map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    }));
    // Anthropic: картинки — блоки {type:'image', source:{type:'base64',…}}.
    if (req.attachments?.length) {
      const idx = messages.map((m) => m.role).lastIndexOf('user');
      if (idx >= 0) {
        messages[idx] = {
          role: 'user',
          content: [
            { type: 'text', text: String(messages[idx].content ?? '') },
            ...req.attachments.map((a) => ({
              type: 'image',
              source: { type: 'base64', media_type: a.mime, data: a.b64 },
            })),
          ],
        };
      }
    }
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
