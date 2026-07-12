import { createPortal } from 'react-dom';
import { useToasts } from './toast';

// Стек всплывающих сообщений (низ-центр). Портал в body, поверх всего.
export function ToastHost() {
  const { toasts, dismiss } = useToasts();
  if (!toasts.length) return null;
  const color: Record<string, string> = {
    info: 'bg-panel border-white/15 text-gray-200',
    success: 'bg-green-900/80 border-green-500/40 text-green-100',
    error: 'bg-red-900/85 border-red-500/50 text-red-100',
  };
  const icon: Record<string, string> = { info: '⏳', success: '✓', error: '⚠️' };
  return createPortal(
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[100] flex flex-col gap-2 items-center pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto flex items-center gap-2 rounded-xl border px-4 py-2 text-sm shadow-xl backdrop-blur max-w-[90vw] ${color[t.kind]}`}
          onClick={() => dismiss(t.id)}
        >
          <span>{icon[t.kind]}</span>
          <span>{t.text}</span>
        </div>
      ))}
    </div>,
    document.body
  );
}
