import type { CSSProperties } from 'react';

// Безопасный рендер ограниченного markdown (Batch 3 §7-bis). ОБЯЗАТЕЛЬНАЯ
// санитизация: сначала экранируем весь HTML, потом применяем markdown-разметку к
// уже безопасному тексту. Никакого сырого HTML из ответа ИИ не проходит; ссылок/
// атрибутов/скриптов нет — значит инъекция через dangerouslySetInnerHTML исключена.

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Инлайновая разметка поверх уже экранированного текста: **жирный**, *курсив*,
// _курсив_, `моно`, а также прямая речь в кавычках («…» и "…") — оборачивается в
// <span class="md-quote"> для отдельной подкраски (см. мастерскую оформления).
// Порядок важен (жирный до курсива). Кавычки — последними, чтобы обернуть уже
// размеченный текст. escapeHtml превратил " в &quot;, а «» проходят как есть.
function inline(escaped: string): string {
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/«[^»]+»/g, '<span class="md-quote">$&</span>')
    .replace(/&quot;((?:(?!&quot;)[\s\S])*?)&quot;/g, '<span class="md-quote">&quot;$1&quot;</span>');
}

// Блочный рендер: заголовки #/##/###, списки - / *, цитаты >, абзацы с <br>.
export function renderMarkdown(text: string): string {
  const lines = escapeHtml(text).split('\n');
  const out: string[] = [];
  let i = 0;

  const flushList = (items: string[]) => {
    if (!items.length) return;
    out.push(`<ul>${items.map((it) => `<li>${inline(it)}</li>`).join('')}</ul>`);
  };
  const flushQuote = (items: string[]) => {
    if (!items.length) return;
    out.push(`<blockquote>${items.map(inline).join('<br>')}</blockquote>`);
  };
  const flushPara = (items: string[]) => {
    if (!items.length) return;
    out.push(`<p>${items.map(inline).join('<br>')}</p>`);
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Заголовки
    const h = /^(#{1,3})\s+(.*)$/.exec(trimmed);
    if (h) {
      const level = h[1].length;
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }

    // Списки
    if (/^[-*]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*]\s+/, ''));
        i++;
      }
      flushList(items);
      continue;
    }

    // Цитаты
    if (/^>\s?/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^>\s?/, ''));
        i++;
      }
      flushQuote(items);
      continue;
    }

    // Абзац: собираем до пустой строки/блочного элемента.
    if (trimmed === '') {
      i++;
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^(#{1,3})\s+/.test(lines[i].trim()) &&
      !/^[-*]\s+/.test(lines[i].trim()) &&
      !/^>\s?/.test(lines[i].trim())
    ) {
      para.push(lines[i]);
      i++;
    }
    flushPara(para);
  }

  return out.join('');
}

// Компонент: безопасно рендерит markdown-текст. className/style — на обёртку.
export function Markdown({
  text,
  className,
  style,
}: {
  text: string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span className={className} style={style} dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
  );
}

// Только инлайновая разметка (жирный/курсив/моно), без блочных элементов —
// подходит для мест, где нельзя <p>/<ul> (например, внутри <button> с выбором).
export function renderInlineMarkdown(text: string): string {
  return inline(escapeHtml(text));
}

export function InlineMarkdown({ text, className }: { text: string; className?: string }) {
  return <span className={className} dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(text) }} />;
}
