import { useEffect, useRef, useState } from 'react';
import { SLASH_HELP } from '../slashCommands';

// Консоль ввода — ВСЕГДА видна (Блок B.3). Свой ввод = дословная реплика героя;
// поддерживает слэш-команды (/bg, /ooc, /regen, /mute, /help).
// Плюс иконка «Заметка для ИИ» (Блок M) — author's note, инжектится перед ходом
// игрока, живёт в сейве до ручного изменения/удаления.
export function Console({
  disabled,
  value,
  onValueChange,
  onSubmit,
  onContinue,
  canContinue,
  hasNotes,
  onOpenNotes,
}: {
  disabled: boolean;
  value: string;
  onValueChange: (text: string) => void;
  onSubmit: (text: string) => void;
  onContinue: () => void;
  canContinue: boolean;
  hasNotes: boolean;
  onOpenNotes: () => void;
}) {
  const [showHelp, setShowHelp] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Автовысота поля ввода: растёт под текст (до потолка), затем скроллится внутри.
  const resize = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
  };
  useEffect(resize, [value]);

  const send = () => {
    const t = value.trim();
    if (!t) return;
    // НЕ очищаем строку здесь — стор очистит её только после успешного хода, чтобы
    // при ошибке/отмене генерации ввод не пропал.
    onSubmit(t);
  };

  const iconBtn =
    'shrink-0 w-10 h-10 rounded-xl flex items-center justify-center text-lg transition-colors border';
  const iconIdle =
    'text-[#d6cdf0] bg-white/[0.04] border-[rgba(180,150,255,0.22)] hover:bg-[var(--pl-accent-soft)] hover:border-[rgba(190,150,255,0.5)]';

  return (
    <div className="bg-[var(--pl-bubble-bg)] backdrop-blur-lg border-t border-[rgba(180,150,255,0.14)] px-3 sm:px-4 pt-3 pb-safe inset-x-safe">
      <div className="max-w-4xl mx-auto flex items-end gap-2.5">
        <button
          className={`${iconBtn} ${iconIdle}`}
          title={SLASH_HELP}
          onMouseEnter={() => setShowHelp(true)}
          onMouseLeave={() => setShowHelp(false)}
        >
          /
        </button>
        <button
          className={`${iconBtn} ${
            hasNotes
              ? 'text-[#1c1526] bg-[var(--pl-accent)] border-transparent shadow-[0_0_12px_var(--pl-accent-glow)]'
              : iconIdle
          }`}
          title="Авторские заметки для ИИ"
          onClick={onOpenNotes}
        >
          📝
        </button>
        <textarea
          ref={taRef}
          rows={1}
          className="flex-1 resize-none rounded-[14px] px-4 py-2.5 text-[13.5px] leading-snug outline-none text-[#f0ecfa] bg-white/[0.05] border border-[rgba(180,150,255,0.25)] focus:border-[var(--pl-accent)] disabled:opacity-50 scrollbar-thin"
          placeholder="Ваши слова или действие героя… ( / — команды)"
          value={value}
          disabled={disabled}
          onChange={(e) => onValueChange(e.target.value)}
          onKeyDown={(e) => {
            // Enter — отправить; Shift+Enter — перенос строки.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        {value.trim() ? (
          <button
            className="shrink-0 w-10 h-10 rounded-xl flex items-center justify-center text-[#1c1526] bg-gradient-to-b from-[var(--pl-accent-bright)] to-[var(--pl-accent)] shadow-[0_0_16px_var(--pl-accent-glow),inset_0_1px_0_rgba(255,255,255,0.4)] disabled:opacity-40"
            disabled={disabled}
            onClick={send}
          >
            →
          </button>
        ) : (
          canContinue && (
            <button
              className={`${iconBtn} ${iconIdle}`}
              disabled={disabled}
              onClick={onContinue}
              title="Продолжить историю"
            >
              ▶
            </button>
          )
        )}
      </div>
      {showHelp && (
        <div className="max-w-4xl mx-auto text-[11px] text-[#c9c3de]/60 mt-2 px-1">{SLASH_HELP}</div>
      )}
    </div>
  );
}
