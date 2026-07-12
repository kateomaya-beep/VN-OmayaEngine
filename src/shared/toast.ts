import { create } from 'zustand';
import { uid } from './utils';

// Всплывающие сообщения о фоновых процессах (автосаммари, векторизация и т.д.).
// Успех/инфо гаснут сами; ошибки висят дольше. Использовать можно и вне React
// через pushToast() (напр. из memoryEngine).

export type ToastKind = 'info' | 'success' | 'error';
export interface Toast {
  id: string;
  kind: ToastKind;
  text: string;
}

interface ToastStore {
  toasts: Toast[];
  push: (kind: ToastKind, text: string) => string;
  update: (id: string, kind: ToastKind, text: string) => void;
  dismiss: (id: string) => void;
}

const TTL: Record<ToastKind, number> = { info: 3000, success: 3000, error: 9000 };

function scheduleDismiss(id: string, kind: ToastKind) {
  setTimeout(() => useToasts.getState().dismiss(id), TTL[kind]);
}

export const useToasts = create<ToastStore>((set) => ({
  toasts: [],
  push: (kind, text) => {
    const id = uid('toast');
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
    scheduleDismiss(id, kind);
    return id;
  },
  update: (id, kind, text) => {
    set((s) => ({ toasts: s.toasts.map((t) => (t.id === id ? { ...t, kind, text } : t)) }));
    scheduleDismiss(id, kind);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

// Не-хук хелперы для использования из движка.
export function pushToast(kind: ToastKind, text: string): string {
  return useToasts.getState().push(kind, text);
}
export function updateToast(id: string, kind: ToastKind, text: string): void {
  useToasts.getState().update(id, kind, text);
}
