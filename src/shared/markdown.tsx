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

// ПРЯМАЯ РЕЧЬ. Кавычки размечаются ОТДЕЛЬНЫМ проходом со СВОИМ состоянием, и это
// не прихоть: раньше это был обычный regex «…», а значит открывающая и закрывающая
// кавычка обязаны были стоять в одной строке. Длинная реплика (письмо, монолог),
// разбитая моделью на абзацы, не подкрашивалась вообще — ни один абзац не содержал
// пары. Поэтому теперь состояние живёт между строками: где речь началась, там span
// открывается, на конце строки закрывается и на следующей открывается снова —
// внутри абзаца тег не должен «перепрыгивать» через <p>.
//
// Вложенность считаем: «…«…»…» не закрывает подкраску на первой же », а прямые
// кавычки внутри «…» — это цитата внутри реплики, а не вторая реплика (правило
// формата велит писать такие 'одинарными', но модель ошибается, и парсер обязан
// это пережить).
const Q_OPEN = '<span class="md-quote">';
const Q_CLOSE = '</span>';
const QUOT = '&quot;'; // escapeHtml уже превратил " в сущность

type QuoteState = { depth: number; straight: boolean };
const newQuoteState = (): QuoteState => ({ depth: 0, straight: false });

function markQuotes(escaped: string, st: QuoteState): string {
  let out = '';
  let i = 0;
  let open = st.depth > 0 || st.straight; // пришли внутрь речи с прошлой строки
  if (open) out += Q_OPEN;
  while (i < escaped.length) {
    const c = escaped[i];
    if (c === '«') {
      if (!open) {
        out += Q_OPEN;
        open = true;
      }
      st.depth++;
      out += c;
      i++;
      continue;
    }
    if (c === '»') {
      out += c;
      i++;
      if (st.depth > 0) {
        st.depth--;
        if (st.depth === 0 && !st.straight && open) {
          out += Q_CLOSE;
          open = false;
        }
      }
      continue;
    }
    if (escaped.startsWith(QUOT, i)) {
      out += QUOT;
      i += QUOT.length;
      if (st.depth > 0) continue; // вложенная цитата внутри «…» — не переключаем
      if (!st.straight) {
        st.straight = true;
        if (!open) {
          // Открывающая кавычка должна попасть ВНУТРЬ подкраски, поэтому span
          // вставляем перед ней задним числом.
          out = out.slice(0, out.length - QUOT.length) + Q_OPEN + QUOT;
          open = true;
        }
      } else {
        st.straight = false;
        if (open) {
          out += Q_CLOSE;
          open = false;
        }
      }
      continue;
    }
    out += c;
    i++;
  }
  if (open) out += Q_CLOSE;
  return out;
}

// Инлайновая разметка поверх уже экранированного текста: **жирный**, *курсив*,
// _курсив_, `моно`. Порядок важен (жирный до курсива).
function emphasis(escaped: string): string {
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

// Кавычки размечаем ПЕРВЫМИ, по чистому тексту: пройди мы после жирного/курсива,
// пришлось бы сканировать уже размеченный HTML и обходить теги. Вставленные span'ы
// не содержат ни *, ни _, ни `, поэтому следующему проходу они не мешают.
function inline(escaped: string, st: QuoteState): string {
  return emphasis(markQuotes(escaped, st));
}

// Блочный рендер: заголовки #/##/###, списки - / *, цитаты >, абзацы.
//
// lineAsParagraph — каждая непустая строка становится ОТДЕЛЬНЫМ абзацем, как в
// Таверне. Иначе строки внутри абзаца склеиваются через <br>, и текст, который
// модель разбила одиночными переводами строк (а так делает большинство), приезжал
// сплошной простынёй: <br> не даёт вертикального отступа, в отличие от абзаца.
export function renderMarkdown(text: string, opts?: { lineAsParagraph?: boolean }): string {
  const lines = escapeHtml(text).split('\n');
  const out: string[] = [];
  let i = 0;
  // Одно состояние кавычек на всё сообщение: реплика, начатая в одном абзаце,
  // продолжает подкрашиваться в следующих.
  const st = newQuoteState();
  const ln = (t: string) => inline(t, st);

  const flushList = (items: string[]) => {
    if (!items.length) return;
    out.push(`<ul>${items.map((it) => `<li>${ln(it)}</li>`).join('')}</ul>`);
  };
  const flushQuote = (items: string[]) => {
    if (!items.length) return;
    out.push(`<blockquote>${items.map(ln).join('<br>')}</blockquote>`);
  };
  const flushPara = (items: string[]) => {
    if (!items.length) return;
    if (opts?.lineAsParagraph) {
      for (const it of items) out.push(`<p>${ln(it)}</p>`);
      return;
    }
    out.push(`<p>${items.map(ln).join('<br>')}</p>`);
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Заголовки
    const h = /^(#{1,3})\s+(.*)$/.exec(trimmed);
    if (h) {
      const level = h[1].length;
      out.push(`<h${level}>${ln(h[2])}</h${level}>`);
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
  lineAsParagraph,
}: {
  text: string;
  className?: string;
  style?: CSSProperties;
  /** Каждая строка — отдельный абзац (как в Таверне). См. renderMarkdown. */
  lineAsParagraph?: boolean;
}) {
  return (
    <span
      className={className}
      style={style}
      dangerouslySetInnerHTML={{ __html: renderMarkdown(text, { lineAsParagraph }) }}
    />
  );
}

// Только инлайновая разметка (жирный/курсив/моно), без блочных элементов —
// подходит для мест, где нельзя <p>/<ul> (например, внутри <button> с выбором).
export function renderInlineMarkdown(text: string): string {
  return inline(escapeHtml(text), newQuoteState());
}

export function InlineMarkdown({ text, className }: { text: string; className?: string }) {
  return <span className={className} dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(text) }} />;
}
