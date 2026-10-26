// ЧЕСТНЫЙ СЧЁТ ТОКЕНОВ. Движок прикидывает размер запроса по символам (символы ÷
// 3,5) — и бюджет контекста держит по этой прикидке. Но у каждой модели свой
// токенайзер, а у русского текста он заметно «тяжелее» английского, и прикидка
// расходилась со счётом провайдера на десяток процентов и больше: бюджет 80 000,
// а провайдер насчитывал 88 000.
//
// Поэтому прикидку подстраиваем под факт: провайдер возвращает в ответе, сколько
// токенов было в запросе (usage.prompt_tokens), — делим на это число символы
// запроса и получаем «символов на токен» именно этой модели. Среднее скользящее,
// чтобы один странный ответ не раскачивал счёт; хранится между перезагрузками.

const LS_KEY = 'nf_tok_ratio_v1';
const DEFAULT_RATIO = 3.5;

export interface ProviderUsage {
  model: string;
  promptTokens: number;
  completionTokens?: number;
  reasoningTokens?: number;
  cachedTokens?: number;
  /** Символов в отправленном запросе — для калибровки. */
  promptChars: number;
  at: number;
}

let ratios: Record<string, number> = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
})();
let activeModel = '';
let lastUsage: ProviderUsage | null = null;
let lastMainUsage: (ProviderUsage & { estimate?: number }) | null = null;

/** Модель основного подключения — по ней считается прикидка. */
export function noteActiveModel(model: string | undefined): void {
  if (model) activeModel = model;
}

export function charsPerToken(model = activeModel): number {
  const r = ratios[model];
  return typeof r === 'number' && r >= 1.2 && r <= 8 ? r : DEFAULT_RATIO;
}

/** Есть ли у модели калибровка (для подписи в счётчике). */
export function isCalibrated(model = activeModel): boolean {
  return typeof ratios[model] === 'number';
}

export function recordUsage(u: ProviderUsage): void {
  lastUsage = u;
  // Слишком короткие запросы (проверка связи, служебные) калибровку только портят:
  // служебная обвязка ролей там сравнима с самим текстом.
  if (u.promptTokens > 0 && u.promptChars > 2000) {
    const sample = u.promptChars / u.promptTokens;
    if (sample >= 1.2 && sample <= 8) {
      const prev = ratios[u.model];
      ratios = { ...ratios, [u.model]: prev ? prev * 0.7 + sample * 0.3 : sample };
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(ratios));
      } catch {
        /* ignore */
      }
    }
  }
}

/** Последний ответ провайдера с цифрами (любой запрос). */
export function takeLastUsage(): ProviderUsage | null {
  return lastUsage;
}

/** Цифры последнего ХОДА — для счётчика в пресете. */
export function markMainUsage(u: ProviderUsage | null, estimate?: number): void {
  if (u) lastMainUsage = { ...u, estimate };
}
export function lastTurnUsage(): (ProviderUsage & { estimate?: number }) | null {
  return lastMainUsage;
}

/** Достать цифры из usage ответа (OpenAI / OpenRouter / Gemini-совместимый). */
export function parseUsage(model: string, usage: any, promptChars: number): ProviderUsage | null {
  const pt = Number(usage?.prompt_tokens ?? usage?.input_tokens ?? 0);
  if (!pt) return null;
  return {
    model,
    promptTokens: pt,
    completionTokens: Number(usage?.completion_tokens ?? usage?.output_tokens ?? 0) || undefined,
    reasoningTokens: Number(usage?.completion_tokens_details?.reasoning_tokens ?? 0) || undefined,
    cachedTokens:
      Number(usage?.prompt_tokens_details?.cached_tokens ?? usage?.cache_read_input_tokens ?? usage?.cached_tokens ?? 0) || undefined,
    promptChars,
    at: Date.now(),
  };
}
