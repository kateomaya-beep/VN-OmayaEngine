import type { LlmMessage, ApiConnection } from '../../shared/types';
import { postProcessPrompt, type PromptNames } from '../promptPostProcess';
import { getPresetSettings } from '../presetSettings';
import { getApiKey } from '../keys';
import { getConnection } from '../connection';
import { logEvent } from '../../shared/logStore';
import { pushToast } from '../../shared/toast';

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
  // Стоп-строки: генерация обрывается, как только модель их написала. В текстовом
  // РП это вторая линия обороны от «модель пишет за игрока» — промпт первая.
  stop?: string[];
  // Имена героя и главного собеседника. Нужны методу обработки промпта «одним
  // сообщением»: там роли схлопываются, и реплики приходится подписывать.
  names?: PromptNames;
  // Потоковый вывод: движок отдаёт колбэк, провайдер зовёт его на каждый кусок
  // текста. Отсутствует — обычная генерация одним ответом.
  onDelta?: (chunk: string) => void;
  // Отмена генерации: сигнал прерывания fetch (кнопка «Отменить» в игре).
  signal?: AbortSignal;
}

export interface Provider {
  complete(conn: ApiConnection, apiKey: string, req: CompletionRequest): Promise<string>;
  // Потоковая генерация. НАМЕРЕННО отдельным методом, а не флагом внутри complete:
  // там живут все починки капризов шлюзов (400 на reasoning_effort, на префилл, на
  // картинки), и вплетать в них поток значило бы рисковать рабочим путём ради
  // необязательной фичи. Здесь — только счастливый путь; на любой ошибке ДО первого
  // куска текста движок откатывается на обычный complete со всеми его починками.
  completeStream?(
    conn: ApiConnection,
    apiKey: string,
    req: CompletionRequest,
    onDelta: (chunk: string) => void
  ): Promise<string>;
  listModels(conn: ApiConnection, apiKey: string): Promise<string[]>;
}

// Ошибка потока, случившаяся ДО первого куска текста: можно молча переиграть
// обычным запросом. После первого куска откат уже виден игроку, и мы его не делаем.
export class StreamNotStarted extends Error {}

// Читает SSE-поток построчно. Кадры разделяются пустой строкой; нас интересуют
// только строки data:. \r\n нормализуем — их шлют некоторые шлюзы, и без этого
// разделитель кадра не находится вовсе.
//
// СТОРОЖЕВОЙ ТАЙМЕР: если провайдер молчит дольше staleMs между кусками (включая
// самый первый), считаем соединение зависшим и обрываем его сами — иначе «вечная
// загрузка» медленной/перегруженной модели ничем не отличима от честно работающего
// запроса, и ждать пришлось бы буквально бесконечно. Ошибка тут не теряет уже
// пришедший текст: вызывающий код (completeStream) при обрыве ПОСЛЕ первого куска
// просто возвращает то, что успело прийти, а до первого куска — молча переигрывает
// обычным (нестриминговым) запросом.
async function readSse(
  res: Response,
  onData: (data: string) => void,
  staleMs = 45000
): Promise<void> {
  const reader = res.body?.getReader();
  if (!reader) throw new StreamNotStarted('Поток недоступен: у ответа нет тела');
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    let settled = false;
    let timer!: ReturnType<typeof setTimeout>;
    const chunk = await new Promise<{ done: boolean; value?: Uint8Array }>((resolve, reject) => {
      timer = setTimeout(() => {
        settled = true;
        reject(new Error(`Провайдер не прислал ни байта дольше ${Math.round(staleMs / 1000)} с — похоже, завис`));
      }, staleMs);
      reader.read().then(
        (r) => {
          clearTimeout(timer);
          if (!settled) resolve(r);
        },
        (e) => {
          clearTimeout(timer);
          if (!settled) reject(e);
        }
      );
    }).catch((e) => {
      reader.cancel().catch(() => {});
      throw e;
    });
    const { done, value } = chunk;
    if (done) break;
    buf = (buf + dec.decode(value, { stream: true })).replace(/\r\n/g, '\n');
    let at: number;
    while ((at = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, at);
      buf = buf.slice(at + 2);
      for (const line of frame.split('\n')) {
        const t = line.trimStart();
        if (t.startsWith('data:')) onData(t.slice(5).trim());
      }
    }
  }
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
//
// cache:'no-store' здесь ОБЯЗАТЕЛЕН, а не «на всякий случай». Через прокси у ВСЕХ
// запросов один и тот же адрес (/__proxy), а настоящий адрес провайдера сидит в
// заголовке x-target-url — HTTP-кэш браузера ключуется по URL и заголовок не
// различает. Стоило провайдеру отдать на GET /models обычный для CDN
// «cache-control: max-age=…», и дальше браузер возвращал ЭТОТ ответ на любой
// следующий GET через прокси: новые модели у старого провайдера не появлялись
// никогда, а только что добавленный провайдер получал чужой список (или пустоту).
// Прямые запросы (без прокси) кэшировались так же, просто по своему адресу.
export async function netFetch(url: string, init: RequestInit): Promise<Response> {
  await ensureProxy();
  if (proxyState === 'on' && /^https?:\/\//i.test(url)) {
    const headers = { ...((init.headers as Record<string, string>) || {}), 'x-target-url': url };
    return fetch('/__proxy', { cache: 'no-store', ...init, headers });
  }
  return fetch(url, { cache: 'no-store', ...init });
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

// Отказ модели по фильтру безопасности. Приходит как обычный 400 (у Gemini —
// PROHIBITED_CONTENT/SAFETY), и общий хинт про «префилл/имя модели» тут прямо врёт:
// запрос корректный, модель просто отказалась работать с содержимым. Для 18+
// историй это штатная ситуация, и лечится она не параметрами, а другой моделью.
export function isContentFilterRefusal(bodyText: string): boolean {
  return /PROHIBITED_CONTENT|BLOCKLIST|SAFETY|blocked by .* API|content[_ ]filter|content[_ ]policy|responsible ?ai/i.test(
    bodyText || ''
  );
}

function providerHttpError(status: number, bodyText: string): Error {
  const detail = providerMessage(bodyText);
  if (isContentFilterRefusal(bodyText)) {
    return new Error(
      `Модель отказалась обрабатывать содержимое (фильтр безопасности провайдера, HTTP ${status}). ` +
        `Запрос корректный — дело в контенте истории. Что помогает: выбрать для этой задачи другую модель ` +
        `(Game Master → Саммари → своё подключение для свёртки) или включить jailbreak-блок в пресете.` +
        (detail ? `\nОтвет провайдера: ${detail}` : '')
    );
  }
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

// Ограничение НЕ провайдерское, а МОДЕЛЬНОЕ: семейство Gemini на OpenAI-совместимой
// ручке отвечает «Requests ending with a model turn are not supported» — то есть
// запрос не может заканчиваться ходом ассистента, а именно так уходит префилл. На
// том же шлюзе GPT/Claude-модели префилл принимают, поэтому ключ — base + МОДЕЛЬ,
// а не провайдер целиком. Узнаём только по 400, поэтому запоминаем и сохраняем
// между перезагрузками: иначе после каждого F5 первый ход снова стоил бы двух
// запросов. Список чинится сам — если модель начнёт принимать префилл, достаточно
// очистить его в настройках браузера.
const NO_PREFILL_LS_KEY = 'nf_no_prefill_targets';
const targetKey = (base: string, model: string) => `${base}::${model}`;

function loadNoPrefill(): Set<string> {
  try {
    const raw = localStorage.getItem(NO_PREFILL_LS_KEY);
    const v = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}
const noPrefillTargets = loadNoPrefill();
function rememberNoPrefill(key: string): void {
  noPrefillTargets.add(key);
  try {
    localStorage.setItem(NO_PREFILL_LS_KEY, JSON.stringify([...noPrefillTargets]));
  } catch {
    /* приватный режим — переживём, обойдёмся памятью сессии */
  }
}

// НАСТОЯЩИЙ префилл — это ход ассистента в конце запроса, который модель
// продолжает. Подменять его инструкцией «начни ответ с …» нельзя: это уже не
// префилл, а просьба, которую модель вольна проигнорировать. Поэтому там, где
// шлюз такой запрос отвергает, префилл ОТКЛЮЧАЕТСЯ для этой модели — честно и
// заметно (тост + лог), а не подделывается.

const openAiCompatible: Provider = {
  async complete(conn, apiKey, req) {
    const base = (conn.baseUrl || DEFAULT_OPENAI_BASE).replace(/\/$/, '');
    const model = requireModel(req.model || conn.model);
    // Пустая системная часть — законный случай: метод обработки «одним сообщением»
    // складывает её в первое user-сообщение. Слать пустой system нельзя, часть
    // шлюзов на нём отвечает 400 («content must not be empty»).
    const messages: { role: string; content: unknown }[] = [
      ...(req.system.trim() ? [{ role: 'system', content: req.system }] : []),
      ...sanitizeMessages(req.messages),
    ];
    if (req.attachments?.length) attachImagesOpenAi(messages, req.attachments);
    // Префилл шлём ходом ассистента — как и положено. Не шлём только той модели,
    // которая уже ответила на него отказом (см. noPrefillTargets).
    let prefill = req.prefill?.trim() && !noPrefillTargets.has(targetKey(base, model)) ? req.prefill : '';
    if (prefill) messages.push({ role: 'assistant', content: prefill });
    const body: Record<string, unknown> = {
      model,
      temperature: req.temperature,
      messages,
      ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
      ...(req.reasoningEffort ? { reasoning_effort: req.reasoningEffort } : {}),
      ...(req.stop?.length ? { stop: req.stop } : {}),
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
      // Отпечаток запроса в лог: по нему видно, ЧЕМ именно не понравился запрос —
      // ролями (последняя роль важна), префиллом, вложениями или размером.
      logEvent(
        'warn',
        'llm',
        `HTTP 400 · модель ${model} · роли: ${messages.map((m) => m.role[0]).join('')} · ` +
          `префилл: ${prefill ? 'да' : 'нет'} · вложений: ${req.attachments?.length ?? 0} · ` +
          `~${Math.round(JSON.stringify(body).length / 4)} ток.`,
        providerMessage(errText)
      );
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
      // Шлюз не принимает запрос, оканчивающийся ходом ассистента (наш префилл).
      // Повторяем без него, перенеся смысл префилла в инструкцию последнего хода
      // игрока, и запоминаем шлюз — дальше сразу шлём в этой форме.
      if (
        prefill &&
        /model turn|ending with (a |an )?(model|assistant)|last message.*(user|assistant)|must end with/i.test(errText)
      ) {
        rememberNoPrefill(targetKey(base, model));
        logEvent(
          'warn',
          'llm',
          `Модель «${model}» не поддерживает настоящий префилл (запрос не может заканчиваться ходом ` +
            'модели). Префилл отключён для неё — подделывать его инструкцией не будем. На других ' +
            'моделях этого провайдера префилл продолжит работать.'
        );
        pushToast(
          'error',
          `Модель «${model}» не поддерживает префилл — он отключён для неё. Возьмите модель с поддержкой префилла или снимите его в пресете.`
        );
        // Тот же запрос, но без хвостового хода ассистента. Ничего взамен не
        // подставляем: формат и так задан ремайндером в конце хода игрока.
        const msgs2 = messages.filter((m) => !(m.role === 'assistant' && m.content === prefill));
        res = await post({ ...b2, messages: msgs2 });
        if (!res.ok) throw providerHttpError(res.status, await res.text().catch(() => errText));
        const data = await res.json();
        const content = normalizeContent(data?.choices?.[0]?.message?.content);
        if (content === null) throw new Error('Пустой ответ провайдера');
        // Префилла в ответе нет (его не было в запросе) — не приклеиваем.
        return content;
      }
      // Модель не умеет картинки — повторяем без вложений: пусть ответит хотя бы
      // по текстовой пометке «герой прислал фото», а не роняет всю переписку.
      if (req.attachments?.length && /image|vision|multimodal|content.*type|unsupported/i.test(errText)) {
        const plain = [{ role: 'system', content: req.system }, ...sanitizeMessages(req.messages)] as {
          role: string;
          content: unknown;
        }[];
        if (prefill) plain.push({ role: 'assistant', content: prefill });
        logEvent('warn', 'llm', 'Модель не приняла картинку — повторяю запрос без вложения');
        res = await post({ ...b2, messages: plain });
        if (res.ok) {
          const data = await res.json();
          const content = normalizeContent(data?.choices?.[0]?.message?.content);
          if (content === null) throw new Error('Пустой ответ провайдера');
          return prefill ? prefill + content : content;
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
      // Причин у пустого текста две, и путать их нельзя: фильтр безопасности
      // лечится другой моделью, а исчерпанный бюджет — лимитом токенов.
      const fr = String(choice?.finish_reason ?? '—');
      const filtered = /content[_ ]?filter|safety|blocked|prohibited/i.test(fr);
      logEvent(
        'error',
        'llm',
        filtered
          ? `Модель вернула пустой ответ по фильтру безопасности (finish_reason: ${fr}). Запрос корректный — ` +
              'дело в содержимом. Возьмите для этой задачи другую модель или включите jailbreak-блок в пресете.'
          : `Пустой текст в ответе (finish_reason: ${fr}). ` +
              'Вероятно, весь бюджет токенов ушёл на reasoning — увеличьте лимит или снизьте глубину размышления.'
      );
    }
    return prefill ? prefill + content : content;
  },
  async completeStream(conn, apiKey, req, onDelta) {
    const base = (conn.baseUrl || DEFAULT_OPENAI_BASE).replace(/\/$/, '');
    const model = requireModel(req.model || conn.model);
    const messages: { role: string; content: unknown }[] = [
      ...(req.system.trim() ? [{ role: 'system', content: req.system }] : []),
      ...sanitizeMessages(req.messages),
    ];
    if (req.attachments?.length) attachImagesOpenAi(messages, req.attachments);
    const prefill = req.prefill?.trim() && !noPrefillTargets.has(targetKey(base, model)) ? req.prefill : '';
    if (prefill) messages.push({ role: 'assistant', content: prefill });
    const res = await apiFetch(`${base}/chat/completions`, {
      method: 'POST',
      signal: req.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        temperature: req.temperature,
        messages,
        stream: true,
        ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
        ...(req.reasoningEffort ? { reasoning_effort: req.reasoningEffort } : {}),
        ...(req.stop?.length ? { stop: req.stop } : {}),
      }),
    });
    if (!res.ok) {
      // Ошибку НЕ разбираем и не показываем: обычный путь умеет чинить половину
      // причин 400 сам, поэтому просто просим движок переиграть без потока.
      throw new StreamNotStarted(`Поток не открылся: HTTP ${res.status}`);
    }
    let out = '';
    let started = false;
    let finishReason: string | undefined;
    try {
      await readSse(res, (data) => {
        if (data === '[DONE]') return;
        let ev: any;
        try {
          ev = JSON.parse(data);
        } catch {
          return; // мусорная строка в потоке — пропускаем, ход из-за неё не теряем
        }
        const fr = ev?.choices?.[0]?.finish_reason;
        if (typeof fr === 'string') finishReason = fr;
        const piece = normalizeContent(ev?.choices?.[0]?.delta?.content);
        if (!piece) return;
        started = true;
        out += piece;
        onDelta(piece);
      });
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') throw e;
      if (!started) throw new StreamNotStarted((e as Error).message);
      // Поток оборвался на середине: то, что уже пришло, — настоящий текст, и
      // выбрасывать его хуже, чем отдать короткий ход.
      logEvent('warn', 'llm', 'Поток оборвался на середине — отдаю то, что успело прийти: ' + (e as Error).message);
    }
    if (!started) throw new StreamNotStarted('Поток закрылся, не прислав ни одного куска текста');
    // Диагностика для «модель обрывает ответ»: finish_reason из последнего кадра
    // прямо называет причину, а не оставляет гадать. length/max_tokens — упёрлись
    // в потолок ответа (лечится длиной хода в пресете), остальное — как есть.
    if (finishReason && finishReason !== 'stop') {
      logEvent(
        'warn',
        'llm',
        finishReason === 'length' || finishReason === 'max_tokens'
          ? `Ответ обрезан по лимиту токенов (finish_reason: ${finishReason}) — уменьшите длину хода в пресете или возьмите модель с бо́льшим max_tokens.`
          : `Поток завершился с finish_reason: ${finishReason}`
      );
    }
    return prefill ? prefill + out : out;
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
      body: JSON.stringify({
        model,
        max_tokens: req.maxTokens || 4096,
        temperature: req.temperature,
        ...(req.system.trim() ? { system: req.system } : {}),
        messages,
        ...(req.stop?.length ? { stop_sequences: req.stop } : {}),
      }),
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

// Потоковая генерация Anthropic. Формат событий свой: нас интересует
// content_block_delta с text_delta; всё остальное (старт блока, usage, ping) —
// служебное и в текст не идёт.
anthropic.completeStream = async function completeStream(conn, apiKey, req, onDelta) {
  const base = (conn.baseUrl || DEFAULT_ANTHROPIC_BASE).replace(/\/$/, '');
  const model = requireModel(req.model || conn.model);
  const messages: { role: string; content: unknown }[] = sanitizeMessages(req.messages).map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content,
  }));
  // Хвостовой пробел в префилле Anthropic отклоняет — так же, как в обычном пути.
  const pf = req.prefill ? req.prefill.replace(/\s+$/, '') : '';
  if (pf) messages.push({ role: 'assistant', content: pf });
  const res = await apiFetch(`${base}/messages`, {
    method: 'POST',
    signal: req.signal,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: req.maxTokens || 4096,
      temperature: req.temperature,
      stream: true,
      ...(req.system.trim() ? { system: req.system } : {}),
      messages,
      ...(req.stop?.length ? { stop_sequences: req.stop } : {}),
    }),
  });
  if (!res.ok) throw new StreamNotStarted(`Поток не открылся: HTTP ${res.status}`);
  let out = '';
  let started = false;
  let stopReason: string | undefined;
  try {
    await readSse(res, (data) => {
      let ev: any;
      try {
        ev = JSON.parse(data);
      } catch {
        return;
      }
      // message_delta несёт итоговый stop_reason (end_turn/max_tokens/stop_sequence/…)
      // отдельным событием — не в том же кадре, что текст, поэтому ловим его особо.
      if (ev?.type === 'message_delta' && typeof ev?.delta?.stop_reason === 'string') {
        stopReason = ev.delta.stop_reason;
      }
      if (ev?.type !== 'content_block_delta') return;
      const piece = typeof ev?.delta?.text === 'string' ? ev.delta.text : '';
      if (!piece) return;
      started = true;
      out += piece;
      onDelta(piece);
    });
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e;
    if (!started) throw new StreamNotStarted((e as Error).message);
    logEvent('warn', 'llm', 'Поток оборвался на середине — отдаю то, что успело прийти: ' + (e as Error).message);
  }
  if (!started) throw new StreamNotStarted('Поток закрылся, не прислав ни одного куска текста');
  if (stopReason && stopReason !== 'end_turn' && stopReason !== 'stop_sequence') {
    logEvent(
      'warn',
      'llm',
      stopReason === 'max_tokens'
        ? `Ответ обрезан по лимиту токенов (stop_reason: max_tokens) — уменьшите длину хода в пресете или возьмите модель с бо́льшим max_tokens.`
        : `Поток завершился с stop_reason: ${stopReason}`
    );
  }
  return pf ? pf + out : out;
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
  // Пусто — значит ответ пришёл, но в незнакомой форме. Раньше пользователь видел
  // только «0 моделей подтянуто» и упирался в тупик; теперь в логах видно, ЧТО
  // именно ответил провайдер, и понятно, чинить обёртку или адрес.
  if (!ids.length) {
    let preview: string;
    try {
      preview = JSON.stringify(data).slice(0, 400);
    } catch {
      preview = String(data).slice(0, 400);
    }
    logEvent(
      'warn',
      'llm',
      'Список моделей пуст: провайдер ответил, но не в одном из известных форматов ' +
        '(массив, {data:[…]}, {models:[…]}, {result:[…]}). Проверьте Base URL — он должен ' +
        'заканчиваться на /v1 (или тем, что требует ваш шлюз).',
      preview
    );
  }
  return Array.from(new Set(ids)).sort();
}

export function getProvider(name: ApiConnection['provider']): Provider {
  return name === 'anthropic' ? anthropic : openAiCompatible;
}

// Основная игровая генерация — через ГЛОБАЛЬНОЕ подключение (Batch 3 §2).
//
// Здесь же, на самой границе провайдера, применяется МЕТОД ОБРАБОТКИ ПРОМПТА
// (см. promptPostProcess). Именно здесь, а не в сборке: собранный запрос должен
// оставаться одинаковым для счётчика токенов, предпросмотра и логов, а под
// конкретный шлюз он подгоняется в последний момент. Дополнительные запросы
// (саммари, эмбеддинги) через это не идут — у них и так одно user-сообщение.
export async function runCompletion(req: CompletionRequest): Promise<string> {
  const conn = getConnection();
  const model = req.model || conn.model || '(модель не выбрана)';
  const method = getPresetSettings().promptProcessing;
  const shaped = postProcessPrompt(req.system, req.messages, method, req.names || {});
  req = { ...req, system: shaped.system, messages: shaped.messages };
  // Диагностика: размер запроса + активны ли префилл/reasoning — чтобы по логам
  // сразу понять, не пресет ли мешает (некоторые провайдеры не принимают префилл).
  const reqChars = req.system.length + req.messages.reduce((n, m) => n + m.content.length, 0);
  const flags = [
    method !== 'none' ? `обработка:${method}` : null,
    req.prefill ? `префилл(${req.prefill.length})` : null,
    req.reasoningEffort ? `reasoning:${req.reasoningEffort}` : null,
    req.stop?.length ? `стоп(${req.stop.length})` : null,
    req.onDelta ? 'поток' : null,
  ].filter(Boolean).join(', ');
  logEvent('info', 'llm', `Запрос → ${conn.provider} · ${model} · ~${Math.round(reqChars / 4)} ток.${flags ? ` · ${flags}` : ''}`);
  const started = Date.now();
  try {
    const provider = getProvider(conn.provider);
    const apiKey = getApiKey(conn.provider);
    let out: string;
    if (req.onDelta && provider.completeStream) {
      try {
        out = await provider.completeStream(conn, apiKey, req, req.onDelta);
      } catch (e) {
        if (!(e instanceof StreamNotStarted)) throw e;
        // Поток не завёлся, а игрок ещё ничего не увидел — тихо переигрываем
        // обычным запросом. Там живут все починки капризов шлюзов; часть из них
        // (и сам отказ от stream) как раз и лечит эту ситуацию.
        logEvent('info', 'llm', `Стриминг недоступен (${(e as Error).message}) — обычный запрос`);
        out = await provider.complete(conn, apiKey, req);
      }
    } else {
      out = await provider.complete(conn, apiKey, req);
    }
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
