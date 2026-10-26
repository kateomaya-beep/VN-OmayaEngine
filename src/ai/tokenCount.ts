import { getConnection } from './connection';
import { charsPerToken } from './tokenCalibration';

// ТОЧНЫЙ СЧЁТ ТОКЕНОВ. Раньше размер везде прикидывался по символам (÷ 3,5), и
// бюджет контекста держался по прикидке, а не по факту. Теперь считаем тем же
// словарём, что у модели из подключения:
//   Gemini / Gemma        → словарь Gemma 3 (тот же, что у Gemini 2.0 и новее);
//   GPT / o-серия         → o200k (точь-в-точь tiktoken);
//   DeepSeek              → словарь DeepSeek V3;
//   Qwen                  → словарь Qwen 3.
// У остальных (Claude, Grok, GLM, Kimi…) словарь не опубликован — для них
// прикидка, подстроенная под счёт провайдера (tokenCalibration), с пометкой «≈».
//
// Счёт идёт в воркере (tokenizerWorker.ts), а большинству кода нужен ответ сразу
// (estimateTokens синхронный). Поэтому числа кладутся в кэш по тексту: синхронный
// вызов отдаёт точное число из кэша, а если текста там ещё нет — прикидку и
// ставит текст в очередь; когда воркер досчитает, подписчики (счётчики в
// интерфейсе) перерисовываются. Сборка запроса перед бюджетом ДОЖИДАЕТСЯ точных
// чисел (countTokens), так что потолок держится по факту.

export type TokenizerId = 'gemma3' | 'o200k' | 'deepseek-v3' | 'qwen3';

export const TOKENIZER_LABEL: Record<TokenizerId, string> = {
  gemma3: 'словарь Gemini',
  o200k: 'словарь GPT',
  'deepseek-v3': 'словарь DeepSeek',
  qwen3: 'словарь Qwen',
};

export function tokenizerFor(model: string | undefined): TokenizerId | null {
  const m = (model || '').toLowerCase();
  if (!m) return null;
  if (/gemini|gemma/.test(m)) return 'gemma3';
  if (/deepseek/.test(m)) return 'deepseek-v3';
  if (/qwen|qwq/.test(m)) return 'qwen3';
  if (/(^|[/:])(gpt|chatgpt|o[1-9])([-.]|$)|gpt-?[3-9]|gpt-oss/.test(m)) return 'o200k';
  return null;
}

const LS_OFF = 'nf_exact_tokens_off';

/** Выключатель точного счёта (для слабых телефонов: словарь держит ~150 МБ памяти). */
export function exactTokensEnabled(): boolean {
  try {
    return localStorage.getItem(LS_OFF) !== '1';
  } catch {
    return true;
  }
}
export function setExactTokensEnabled(on: boolean): void {
  try {
    if (on) localStorage.removeItem(LS_OFF);
    else localStorage.setItem(LS_OFF, '1');
  } catch {
    /* ignore */
  }
  bump();
}

/** Каким словарём сейчас считаем (null — прикидка). */
export function activeTokenizer(): TokenizerId | null {
  if (!exactTokensEnabled() || failed.has(tokenizerFor(getConnection().model) || '')) return null;
  return typeof Worker === 'undefined' ? null : tokenizerFor(getConnection().model);
}

// --- кэш ---------------------------------------------------------------------

const MAX_CACHE = 50000;
const cache = new Map<string, number>();
const failed = new Set<string>();

// cyrb53 — быстрый 53-битный хэш: ключ кэша не держит в памяти сам текст.
function hash(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

const keyOf = (tok: TokenizerId, text: string) => `${tok}:${text.length}:${hash(text)}`;

function put(key: string, n: number) {
  if (cache.size >= MAX_CACHE) {
    // Старейшие — первыми (Map хранит порядок вставки).
    let drop = Math.ceil(MAX_CACHE / 10);
    for (const k of cache.keys()) {
      cache.delete(k);
      if (--drop <= 0) break;
    }
  }
  cache.set(key, n);
}

// --- подписка ----------------------------------------------------------------

let version = 0;
const listeners = new Set<() => void>();
function bump() {
  version++;
  for (const l of listeners) l();
}
export function onTokenCountsChanged(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
export function tokenCountsVersion(): number {
  return version;
}

// --- воркер ------------------------------------------------------------------

let worker: Worker | null = null;
let reqId = 0;
const pending = new Map<number, { resolve: (v: number[]) => void; reject: (e: Error) => void }>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./tokenizerWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<any>) => {
      const { id, ok, counts, error } = e.data;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (ok) p.resolve(counts);
      else p.reject(new Error(error));
    };
    worker.onerror = () => {
      for (const p of pending.values()) p.reject(new Error('воркер счёта токенов упал'));
      pending.clear();
      worker = null;
    };
  }
  return worker;
}

function dictUrl(tok: TokenizerId): string {
  const base = (import.meta as any).env?.BASE_URL ?? '/';
  return new URL(`${base}tokenizers/${tok}.json.gz`, location.href).href;
}

function runWorker(tok: TokenizerId, texts: string[]): Promise<number[]> {
  const id = ++reqId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, tok, url: dictUrl(tok), texts });
  });
}

// --- API ---------------------------------------------------------------------

function estimate(text: string): number {
  return Math.ceil(text.length / charsPerToken(getConnection().model));
}

/** Есть ли у текста точное число в кэше (для пометки «≈» у счётчиков). */
export function isExact(text: string): boolean {
  const tok = activeTokenizer();
  return !text || (!!tok && cache.has(keyOf(tok, text)));
}

const queue = new Set<string>();
let queueTimer: ReturnType<typeof setTimeout> | null = null;

function enqueue(text: string) {
  queue.add(text);
  if (queueTimer) return;
  queueTimer = setTimeout(() => {
    queueTimer = null;
    const batch = [...queue];
    queue.clear();
    void countTokens(batch);
  }, 30);
}

/**
 * Число токенов прямо сейчас: точное, если текст уже посчитан словарём модели,
 * иначе прикидка (а текст уходит на точный счёт в фоне).
 */
export function countTokensSync(text: string): number {
  if (!text) return 0;
  const tok = activeTokenizer();
  if (tok) {
    const n = cache.get(keyOf(tok, text));
    if (n !== undefined) return n;
    enqueue(text);
  }
  return estimate(text);
}

/**
 * Точные числа для набора текстов (дожидается словаря). Если точный счёт
 * недоступен — прикидка; exact=false.
 */
export async function countTokens(texts: string[]): Promise<{ counts: number[]; exact: boolean }> {
  const tok = activeTokenizer();
  if (!tok) return { counts: texts.map((t) => (t ? estimate(t) : 0)), exact: false };
  const missing = [...new Set(texts.filter((t) => t && !cache.has(keyOf(tok, t))))];
  if (missing.length) {
    try {
      const counts = await runWorker(tok, missing);
      missing.forEach((t, i) => put(keyOf(tok, t), counts[i]));
      bump();
    } catch {
      // Словарь не загрузился (нет файла, старый браузер без DecompressionStream) —
      // не долбим воркер каждый ход: до перезагрузки считаем прикидкой.
      failed.add(tok);
      bump();
      return { counts: texts.map((t) => (t ? estimate(t) : 0)), exact: false };
    }
  }
  return { counts: texts.map((t) => (t ? cache.get(keyOf(tok, t)) ?? estimate(t) : 0)), exact: true };
}

/** Посчитать заранее (перед бюджетом) — дальше синхронные вызовы берут из кэша. */
export async function prefetchTokens(texts: string[]): Promise<boolean> {
  return (await countTokens(texts)).exact;
}
