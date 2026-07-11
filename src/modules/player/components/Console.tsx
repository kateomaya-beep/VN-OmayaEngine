import { useState } from 'react';
import { SLASH_HELP } from '../slashCommands';

// Консоль ввода — ВСЕГДА видна (Блок B.3). Свой ввод = дословная реплика героя;
// поддерживает слэш-команды (/bg, /ooc, /regen, /mute, /help).
// Плюс иконка «Заметка для ИИ» (Блок M) — author's note, инжектится перед ходом
// игрока, живёт в сейве до ручного изменения/удаления.
export function Console({
  disabled,
  onSubmit,
  onContinue,
  canContinue,
  authorNote,
  onAuthorNoteChange,
}: {
  disabled: boolean;
  onSubmit: (text: string) => void;
  onContinue: () => void;
  canContinue: boolean;
  authorNote: string;
  onAuthorNoteChange: (text: string) => void;
}) {
  const [text, setText] = useState('');
  const [showHelp, setShowHelp] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);

  const send = () => {
    const t = text.trim();
    if (!t) return;
    onSubmit(t);
    setText('');
  };

  return (
    <div className="px-4 sm:px-6 pt-1 pb-3">
      <div className="max-w-4xl mx-auto flex items-center gap-2">
        <button
          className="shrink-0 text-gray-500 hover:text-gray-300 text-lg px-1"
          title={SLASH_HELP}
          onMouseEnter={() => setShowHelp(true)}
          onMouseLeave={() => setShowHelp(false)}
        >
          /
        </button>
        <button
          className={`shrink-0 text-lg px-1 ${authorNote.trim() ? 'text-accent2' : 'text-gray-500 hover:text-gray-300'}`}
          title="Заметка для ИИ (author's note)"
          onClick={() => setNoteOpen((v) => !v)}
        >
          📝
        </button>
        <input
          className="input flex-1 bg-black/70"
          placeholder="Ваши слова или действие героя… ( / — команды)"
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
        />
        {text.trim() ? (
          <button className="btn-primary shrink-0" disabled={disabled} onClick={send}>
            →
          </button>
        ) : (
          canContinue && (
            <button
              className="btn-ghost shrink-0"
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
        <div className="max-w-4xl mx-auto text-[11px] text-gray-500 mt-1 px-6">{SLASH_HELP}</div>
      )}
      {noteOpen && (
        <div className="max-w-4xl mx-auto mt-2">
          <textarea
            className="input h-20 bg-black/70 text-sm"
            placeholder="Заметка для ИИ — инструкция/направление сюжета, инжектится перед каждым ходом, пока не измените или не сотрёте…"
            value={authorNote}
            onChange={(e) => onAuthorNoteChange(e.target.value)}
          />
        </div>
      )}
    </div>
  );
}
