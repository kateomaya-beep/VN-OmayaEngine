import { useEffect, useRef, useState } from 'react';

// МЕНЮ ДЕЙСТВИЙ НАД СООБЩЕНИЕМ — «⋯» рядом с именем, раскрывающий список (как в
// Таверне: редактировать / копировать / перегенерировать / удалить). Общий для
// ленты переписки РП и чата с ассистентом — оба показывают историю сообщений с
// одинаковым набором операций, и держать две копии одной кнопки незачем.
//
// Закрывается по клику снаружи и по Esc. Пункты передаются готовым списком — сам
// компонент не знает, что такое «регенерация» или «удаление», только рисует меню.

export interface MessageMenuItem {
  label: string;
  icon: string;
  onClick: () => void;
  danger?: boolean;
}

export function MessageMenu({ items, disabled }: { items: MessageMenuItem[]; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!items.length) return null;

  return (
    <div className="relative" ref={ref}>
      <button
        className="text-xs w-6 h-6 flex items-center justify-center rounded hover:bg-white/10 disabled:opacity-30"
        title="Действия с сообщением"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        ⋯
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-30 w-44 rounded-[12px] py-1 text-sm bg-[rgba(16,13,24,0.94)] border border-[rgba(180,150,255,0.2)] shadow-[0_16px_40px_rgba(0,0,0,0.5)] backdrop-blur-xl">
          {items.map((it, i) => (
            <button
              key={i}
              className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-xs hover:bg-[rgba(160,110,255,0.16)] ${
                it.danger ? 'text-red-300' : ''
              }`}
              onClick={() => {
                setOpen(false);
                it.onClick();
              }}
            >
              <span className="w-4 text-center">{it.icon}</span>
              <span>{it.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
