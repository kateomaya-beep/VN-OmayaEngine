import { useEffect, useState } from 'react';
import {
  activeTokenizer,
  countTokensSync,
  exactTokensEnabled,
  isExact,
  onTokenCountsChanged,
  setExactTokensEnabled,
  TOKENIZER_LABEL,
  tokenizerFor,
} from '../ai/tokenCount';
import { useConnection } from '../ai/connection';

// СЧЁТЧИКИ ТОКЕНОВ У ПОЛЕЙ — как в Таверне: пишешь анкету или блок пресета и тут же
// видишь, сколько он весит. Число точное (словарь модели из подключения), пока
// текст не досчитан или словаря у модели нет — с пометкой «≈».

function useTokenRerender() {
  const [, force] = useState(0);
  useEffect(() => onTokenCountsChanged(() => force((v) => v + 1)), []);
  // Сменили модель в подключении — словарь другой, числа тоже.
  useConnection((s) => s.connection.model);
}

/** Сумма токенов по текстам: { n, exact }. */
export function useTokenCount(texts: string | string[]): { n: number; exact: boolean } {
  useTokenRerender();
  const list = typeof texts === 'string' ? [texts] : texts;
  let n = 0;
  let exact = true;
  for (const t of list) {
    if (!t) continue;
    n += countTokensSync(t);
    if (!isExact(t)) exact = false;
  }
  return { n, exact };
}

export function formatTokens(n: number, exact: boolean): string {
  return `${exact ? '' : '≈'}${n.toLocaleString('ru')} ток.`;
}

/** Маленькое «123 ток.» у заголовка поля. */
export function TokenBadge({
  text,
  className,
  title,
}: {
  text: string | string[];
  className?: string;
  title?: string;
}) {
  const { n, exact } = useTokenCount(text);
  return (
    <span
      className={`nf-tok-badge shrink-0 text-[10px] tabular-nums text-gray-500 ${className ?? ''}`}
      title={title ?? (exact ? 'Точно, словарём вашей модели' : 'Приблизительно: текст ещё считается или у модели нет открытого словаря')}
    >
      {formatTokens(n, exact)}
    </span>
  );
}

/** Строка-подсказка: чем сейчас считаем + выключатель точного счёта. */
export function ExactTokensNote() {
  useTokenRerender();
  const model = useConnection((s) => s.connection.model);
  const tok = activeTokenizer();
  const own = tokenizerFor(model);
  const on = exactTokensEnabled();
  return (
    <div className="nf-exact-tokens text-[11px] mt-1 space-y-1">
      <p className={tok ? 'text-emerald-300/90' : 'text-gray-500'}>
        {tok
          ? `Токены считаются точно — ${TOKENIZER_LABEL[tok]}, тем же, что у модели «${model}». Бюджет, счётчик вверху и счётчики у полей — по этому счёту.`
          : own && !on
            ? 'Точный счёт выключен — числа приблизительные (≈).'
            : own
              ? 'Словарь модели не загрузился — числа приблизительные (≈), подстроены под счёт провайдера.'
              : `У модели «${model || '—'}» словарь не опубликован — числа приблизительные (≈), подстроены под то, сколько насчитал провайдер. Точно считаются Gemini, GPT, DeepSeek и Qwen.`}
      </p>
      {own && (
        <label className="flex items-center gap-2 text-gray-400 cursor-pointer">
          <input type="checkbox" checked={on} onChange={(e) => setExactTokensEnabled(e.target.checked)} />
          Точный счёт токенов (словарь модели: загрузка 2–5 МБ один раз, ~150 МБ памяти; на слабом телефоне можно выключить)
        </label>
      )}
    </div>
  );
}
