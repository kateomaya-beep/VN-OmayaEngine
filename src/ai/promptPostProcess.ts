import type { LlmMessage } from '../shared/types';

// МЕТОД ОБРАБОТКИ ПРОМПТА (Prompt Post-Processing в Таверне).
//
// Собранный запрос — системная часть плюс сообщения с ролями — не все шлюзы
// принимают в том виде, в каком он собран. Claude напрямую требует, чтобы роли
// чередовались и первым после системного шёл user; часть прокси падает на двух
// подряд user-сообщениях; отдельные ручки вообще принимают ровно одно сообщение.
// Поэтому перед отправкой запрос приводится к выбранной форме.
//
// Семантика повторяет оригинал (SillyTavern, src/prompt-converters.js →
// postProcessPrompt/mergeMessages) НАМЕРЕННО и почти дословно: это вопрос
// совместимости с чужими шлюзами, а не вкуса. Отличие одно: у нас системная часть
// приходит отдельной строкой, а не первым элементом массива, поэтому мы её
// приклеиваем в начало, обрабатываем целиком и потом снова отделяем.

export type PromptProcessing = 'none' | 'merge' | 'semi' | 'strict' | 'single';

export const PROMPT_PROCESSING_LABELS: { id: PromptProcessing; label: string; hint: string }[] = [
  { id: 'none', label: 'Без обработки', hint: 'Слать как собрано: системная часть отдельно, сообщения как есть.' },
  { id: 'merge', label: 'Склейка ролей', hint: 'Соседние сообщения одной роли — в одно. Годится почти всем шлюзам.' },
  { id: 'semi', label: 'Полустрогая', hint: 'Склейка + системные сообщения внутри диалога становятся user.' },
  { id: 'strict', label: 'Строгая', hint: 'Полустрогая + заглушка user сразу после системной части. Для Claude и Gemini напрямую.' },
  { id: 'single', label: 'Одним сообщением', hint: 'Весь запрос — одно user-сообщение, реплики подписаны именами.' },
];

export function isPromptProcessing(v: unknown): v is PromptProcessing {
  return v === 'none' || v === 'merge' || v === 'semi' || v === 'strict' || v === 'single';
}

// Заглушка, которой строгий режим разбавляет запрос, если после системной части
// сразу идёт не-user. Текст взят из оригинала, чтобы поведение моделей совпадало.
const PLACEHOLDER = "Let's get started.";

export interface PromptNames {
  userName?: string;
  charName?: string;
}

interface MergeOptions {
  strict: boolean;
  placeholders: boolean;
  single: boolean;
}

function mergeMessages(input: LlmMessage[], names: PromptNames, opts: MergeOptions): LlmMessage[] {
  const work: LlmMessage[] = input.map((m) => ({ role: m.role, content: m.content ?? '' }));

  // Режим «одним сообщением»: реплики теряют роль, поэтому кто говорит — приходится
  // подписывать именем, иначе диалог схлопывается в неразличимую простыню.
  if (opts.single) {
    for (const m of work) {
      if (m.role === 'assistant' && names.charName && !m.content.startsWith(`${names.charName}: `)) {
        m.content = `${names.charName}: ${m.content}`;
      }
      if (m.role === 'user' && names.userName && !m.content.startsWith(`${names.userName}: `)) {
        m.content = `${names.userName}: ${m.content}`;
      }
      m.role = 'user';
    }
  }

  // Склейка подряд идущих сообщений одной роли.
  const merged: LlmMessage[] = [];
  for (const m of work) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role && m.content) last.content += '\n\n' + m.content;
    else merged.push(m);
  }
  if (!merged.length) merged.push({ role: 'user', content: PLACEHOLDER });

  if (opts.strict) {
    // Системное сообщение допустимо только первым: всё, что внутри диалога, — user.
    for (let i = 1; i < merged.length; i++) {
      if (merged[i].role === 'system') merged[i].role = 'user';
    }
    if (opts.placeholders) {
      if (merged[0].role === 'system' && (merged.length === 1 || merged[1].role !== 'user')) {
        merged.splice(1, 0, { role: 'user', content: PLACEHOLDER });
      } else if (merged[0].role !== 'system' && merged[0].role !== 'user') {
        merged.unshift({ role: 'user', content: PLACEHOLDER });
      }
    }
    // Перевод system→user мог создать новые соседние пары одной роли — склеиваем ещё раз.
    return mergeMessages(merged, names, { strict: false, placeholders: opts.placeholders, single: false });
  }

  return merged;
}

const MODES: Record<Exclude<PromptProcessing, 'none'>, MergeOptions> = {
  merge: { strict: false, placeholders: false, single: false },
  semi: { strict: true, placeholders: false, single: false },
  strict: { strict: true, placeholders: true, single: false },
  single: { strict: true, placeholders: false, single: true },
};

export interface ProcessedPrompt {
  system: string;
  messages: LlmMessage[];
}

// Приводит собранный запрос к выбранной форме. Системная часть возвращается
// отдельно (пустой строкой, если её поглотил режим «одним сообщением») — провайдеры
// подставляют её в своё поле, а не в массив.
export function postProcessPrompt(
  system: string,
  messages: LlmMessage[],
  type: PromptProcessing,
  names: PromptNames = {}
): ProcessedPrompt {
  if (type === 'none') return { system, messages };
  const head: LlmMessage[] = system.trim() ? [{ role: 'system', content: system }] : [];
  const merged = mergeMessages([...head, ...messages], names, MODES[type]);
  if (merged[0]?.role === 'system') {
    return { system: merged[0].content, messages: merged.slice(1) };
  }
  return { system: '', messages: merged };
}
