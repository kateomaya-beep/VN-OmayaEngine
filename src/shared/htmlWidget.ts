// HTML-ВИДЖЕТЫ ИЗ РЕГУЛЯРОК ПРЕСЕТА (часы-HUD, лента твитов, заметки у Dr. D).
//
// Сама лента сырой HTML не пропускает (см. markdown.tsx), и это правильно. Виджет —
// исключение по происхождению: его разметку пишет автор пресета, а модель только
// заполняет поля. Но и поля, и сам пресет — чужой текст, поэтому:
//  - разметка чистится: без <script>, <iframe>, <object>, <embed>, <base>, <meta>,
//    <link>, без обработчиков on…, без javascript:-ссылок. Всё интерактивное в таких
//    виджетах сделано на CSS (чекбоксы, :checked, <details>) и работает без скриптов;
//  - каждый виджет живёт в своём shadow DOM: его <style> не задевает интерфейс, а
//    стили приложения — его;
//  - отправка форм гасится: у виджетов бывают <form>, и Enter в поле ввода иначе
//    перезагрузил бы страницу.

const DROP_TAGS = new Set(['script', 'iframe', 'object', 'embed', 'base', 'meta', 'link', 'frame', 'frameset', 'noscript', 'template']);
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href', 'background', 'poster', 'srcset']);

export function sanitizeWidget(html: string): DocumentFragment {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const walk = (root: ParentNode) => {
    for (const el of Array.from(root.querySelectorAll('*'))) {
      const tag = el.tagName.toLowerCase();
      if (DROP_TAGS.has(tag)) {
        el.remove();
        continue;
      }
      for (const a of Array.from(el.attributes)) {
        const name = a.name.toLowerCase();
        if (name.startsWith('on')) el.removeAttribute(a.name);
        else if (URL_ATTRS.has(name) && /^\s*(javascript|vbscript|data:text\/html)/i.test(a.value.replace(/[\s\u0000-\u001f]/g, ''))) {
          el.removeAttribute(a.name);
        }
      }
    }
  };
  walk(tpl.content);
  return tpl.content;
}

/** Виджет-строчка (<span …>) встаёт в текст, всё остальное — блоком. */
export function isInlineWidget(html: string): boolean {
  return /^\s*<span\b/i.test(html) && !/<(div|form|style|table|section)\b/i.test(html);
}

const mounted = new WeakMap<HTMLElement, string>();

export function mountWidget(host: HTMLElement, html: string): void {
  if (mounted.get(host) === html) return;
  let root = host.shadowRoot;
  if (!root) {
    root = host.attachShadow({ mode: 'open' });
    root.addEventListener('submit', (e) => e.preventDefault(), true);
  }
  root.replaceChildren();
  const base = document.createElement('style');
  base.textContent = ':host{display:' + (isInlineWidget(html) ? 'inline' : 'block') + ';max-width:100%;overflow-x:auto;margin:.4em 0}';
  root.appendChild(base);
  root.appendChild(sanitizeWidget(html));
  mounted.set(host, html);
}
