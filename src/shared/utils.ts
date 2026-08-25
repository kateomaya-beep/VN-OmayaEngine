import { pushToast } from './toast';

export function uid(prefix = ''): string {
  const s = Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
  return prefix ? `${prefix}_${s}` : s;
}

// Копирование в буфер с обратной связью — молчаливый navigator.clipboard.writeText
// оставляет игрока гадать, сработало ли нажатие. execCommand — запасной путь для
// случаев без Clipboard API (небезопасный контекст, старый WebView).
export function copyToClipboard(text: string): void {
  const done = () => pushToast('success', 'Скопировано');
  const fail = () => pushToast('error', 'Не удалось скопировать');
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done, fail));
  } else {
    fallbackCopy(text, done, fail);
  }
}

function fallbackCopy(text: string, done: () => void, fail: () => void): void {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (ok) done();
    else fail();
  } catch {
    fail();
  }
}

export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

// Rough token estimate: ~3.5 chars/token for Russian text (see ТЗ §10)
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

// Auto-tag helper: derive candidate tags from a filename
export function autoTagsFromName(name: string): string[] {
  const base = name.replace(/\.[^.]+$/, '');
  return base
    .split(/[\s_\-.,]+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 1 && t.length < 24);
}

export function formatDate(ts: number): string {
  return new Date(ts).toLocaleString();
}
