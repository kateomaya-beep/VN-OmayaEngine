import { getConnection } from './connection';
import { activeTokenizer } from './tokenCount';

// ЛИМИТ ШЛЮЗА. Словарь модели считает точно, но запрос отклоняет не модель, а
// шлюз перед ней (прокси, OpenRouter и т. п.), и считает он СВОИМ токенайзером.
// У прокси для Таверны это нередко старый словарь GPT, а он на русском тексте
// насчитывает на треть больше: бюджет 80 000 по словарю Gemini — а прокси видит
// 108 000 и отвечает «exceeds the context size limit».
//
// Поэтому учимся у самого шлюза. Отказ по размеру он почти всегда сопровождает
// цифрами («requested: 108486 prompt + 4050 output», «max: 100000»): делим его
// счёт на наш и получаем поправку для этой пары «адрес + модель». Дальше бюджет
// пересчитывается в единицы шлюза — запрос держится в лимите по ЕГО счёту, — а
// упавший ход повторяется сам (см. runTurn). Поправка хранится между запусками.
// Счёт провайдера из usage — тоже сигнал (для моделей со словарём): если он
// стабильно больше нашего, бюджет поджимается так же.

const LS_KEY = 'nf_gateway_fix_v1';

interface Fix {
  /** Во сколько раз шлюз насчитал больше нашего (по отказу). */
  factor?: number;
  /** То же по usage ответов (скользящее среднее). */
  usage?: number;
  /** Лимит контекста шлюза (prompt + output), если он его назвал. */
  max?: number;
  /** Сколько шлюз закладывал на ответ (наш max_tokens). */
  output?: number;
  at: number;
}

let fixes: Record<string, Fix> = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
})();

function save() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(fixes));
  } catch {
    /* ignore */
  }
}

export function gatewayKey(model?: string): string {
  const c = getConnection();
  return `${(c.baseUrl || '').replace(/\/+$/, '')}|${model || c.model || ''}`;
}

export interface GatewayFix {
  factor: number;
  max?: number;
  output?: number;
  /** Откуда поправка — для подписи в интерфейсе. */
  learned: boolean;
}

export function gatewayFix(key = gatewayKey()): GatewayFix {
  const f = fixes[key];
  if (!f) return { factor: 1, learned: false };
  // usage учитываем только при точном счёте: без словаря его уже впитала
  // калибровка «символов на токен», и поправка посчиталась бы дважды.
  const usage = activeTokenizer() ? f.usage ?? 1 : 1;
  return { factor: Math.max(1, f.factor ?? 1, usage), max: f.max, output: f.output, learned: true };
}

export function resetGatewayFix(key = gatewayKey()): void {
  delete fixes[key];
  fixes = { ...fixes };
  save();
}

/**
 * Бюджет в НАШИХ единицах счёта, при котором запрос уложится и в бюджет из
 * пресета по счёту шлюза, и в лимит самого шлюза (вместе с ответом).
 */
export function effectiveContextBudget(nominal: number, key = gatewayKey()): number {
  const fix = gatewayFix(key);
  let b = Math.max(2000, nominal || 8000);
  if (fix.max) b = Math.min(b, fix.max - (fix.output ?? 4096) - 256);
  return Math.max(2000, Math.floor(b / fix.factor));
}

// --- разбор отказа ---------------------------------------------------------------

export interface ContextOverflow {
  prompt?: number;
  max?: number;
  output?: number;
}

const num = (s: string | undefined) => (s ? Number(s.replace(/[,\s]/g, '')) || undefined : undefined);

const OVERFLOW_RE =
  /context (size|length|window)|context_length_exceeded|maximum context|too many tokens|prompt is too long|input token count|exceeds the (maximum|context|token)|token limit exceeded|reduce the length of the messages/i;

/** Отказ «запрос не помещается»: цифры, какие удалось достать (или null — это не он). */
export function parseContextOverflow(text: string): ContextOverflow | null {
  if (!text || !OVERFLOW_RE.test(text)) return null;
  const out: ContextOverflow = {};
  let m: RegExpMatchArray | null;
  // Прокси для Таверны: «max: 100000 tokens, requested: 108486 prompt + 4050 output»
  if ((m = text.match(/requested:?\s*([\d,]+)\s*prompt(?:\s*\+\s*([\d,]+)\s*output)?/i))) {
    out.prompt = num(m[1]);
    out.output = num(m[2]);
  }
  // OpenAI: «maximum context length is 128000 tokens. However, you requested 130000
  // tokens (126000 in the messages, 4000 in the completion)»
  if ((m = text.match(/maximum context length is ([\d,]+) tokens/i))) out.max ??= num(m[1]);
  if ((m = text.match(/([\d,]+) in the messages(?:,\s*([\d,]+) in the completion)?/i))) {
    out.prompt ??= num(m[1]);
    out.output ??= num(m[2]);
  }
  if (!out.prompt && (m = text.match(/resulted in ([\d,]+) tokens/i))) out.prompt = num(m[1]);
  // Anthropic: «prompt is too long: 210000 tokens > 200000 maximum»
  if ((m = text.match(/([\d,]+)\s*tokens?\s*>\s*([\d,]+)\s*maximum/i))) {
    out.prompt ??= num(m[1]);
    out.max ??= num(m[2]);
  }
  // Gemini: «The input token count (1200000) exceeds the maximum number of tokens allowed (1048576)»
  if ((m = text.match(/input token count[^\d]*([\d,]+)[^\d]+(?:allowed|limit)[^\d]*([\d,]+)/i))) {
    out.prompt ??= num(m[1]);
    out.max ??= num(m[2]);
  }
  if (!out.max && (m = text.match(/max(?:imum)?(?: context)?(?: size)?:?\s*([\d,]+)\s*tokens/i))) out.max = num(m[1]);
  return out;
}

export class ContextOverflowError extends Error {
  info: ContextOverflow;
  constructor(message: string, info: ContextOverflow) {
    super(message);
    this.name = 'ContextOverflowError';
    this.info = info;
  }
}

/** Шлюз прислал свою ошибку под видом ответа модели (прокси для Таверны так делают). */
export function isProxyErrorReply(text: string): boolean {
  const head = text.slice(0, 400);
  return /<!--\s*oai-proxy-error/i.test(text) || /^\W{0,6}proxy error \(HTTP \d{3}/i.test(head) || /"type"\s*:\s*"proxy_\w*error"/i.test(head + text.slice(-800));
}

export function overflowMessage(info: ContextOverflow): string {
  const nums =
    info.prompt && info.max
      ? `он насчитал ${info.prompt.toLocaleString('ru')} ток. запроса${info.output ? ` + ${info.output.toLocaleString('ru')} на ответ` : ''} при лимите ${info.max.toLocaleString('ru')}`
      : info.prompt
        ? `он насчитал ${info.prompt.toLocaleString('ru')} ток. запроса`
        : 'запрос не помещается в его лимит';
  return `Шлюз не принял запрос: ${nums}.`;
}

/** Запомнить отказ: поправка = счёт шлюза ÷ наш счёт того же запроса. */
export function learnOverflow(info: ContextOverflow, ourTokens: number, key = gatewayKey()): GatewayFix {
  const prev = fixes[key] || { at: 0 };
  const next: Fix = { ...prev, at: Date.now() };
  if (info.prompt && ourTokens > 500) {
    // +2% запаса: счёт шлюза для следующего запроса может чуть разойтись.
    next.factor = Math.max(prev.factor ?? 1, (info.prompt / ourTokens) * 1.02);
  } else {
    // Цифр нет — поджимаем вслепую, на 15% за отказ.
    next.factor = (prev.factor ?? 1) * 1.15;
  }
  if (info.max) next.max = info.max;
  if (info.output) next.output = info.output;
  fixes = { ...fixes, [key]: next };
  save();
  return gatewayFix(key);
}

/** Счёт провайдера из usage против нашего (точного) — для поправки по ответам. */
export function learnUsage(providerPrompt: number, ourTokens: number, key = gatewayKey()): void {
  if (!activeTokenizer() || providerPrompt <= 0 || ourTokens < 2000) return;
  const sample = providerPrompt / ourTokens;
  if (sample < 0.5 || sample > 3) return;
  const prev = fixes[key] || { at: 0 };
  const usage = prev.usage ? prev.usage * 0.7 + sample * 0.3 : sample;
  fixes = { ...fixes, [key]: { ...prev, usage, at: Date.now() } };
  save();
}
