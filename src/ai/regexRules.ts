import { logEvent } from '../shared/logStore';
import { uid } from '../shared/utils';

// ПРАВИЛА-РЕГЭКСПЫ — то, что в Таверне живёт отдельным расширением, а здесь стоит
// в ядре, потому что без него текстовый режим нечем чинить.
//
// Задача у них одна: подправить текст между моделью и экраном, не трогая ни промпт,
// ни движок. Вырезать служебную пометку, которую модель упорно дописывает; убрать
// имя героя перед его репликой; заменить кавычки-лапки на ёлочки; спрятать
// англоязычный «(OOC: …)».
//
// Два независимых выбора у каждого правила, и путать их нельзя:
//  — appliesTo: К ЧЬЕМУ тексту применять (ответ ИИ / ход игрока / оба);
//  — scope: ГДЕ применять. 'display' — только на экране (в истории и в контексте
//    остаётся исходный текст), 'prompt' — только в том, что уезжает модели
//    (на экране всё как было), 'both' — и там, и там.
//
// Чего здесь нет намеренно: выполнения кода в замене. Замена — обычная строка с
// $1…$9 (и {{match}} как синоним $&), не выражение. Правило, которое умеет считать
// и ветвиться, — это уже скриптовый язык, а его отладка ложится на пользователя.

export type RegexTarget = 'ai' | 'user' | 'both';
export type RegexScope = 'display' | 'prompt' | 'both';

export interface RegexRule {
  id: string;
  name: string;
  enabled: boolean;
  find: string; // тело регулярного выражения (без слэшей)
  flags: string; // g, i, m, s
  replace: string;
  appliesTo: RegexTarget;
  scope: RegexScope;
  // Глубина, как в Таверне: 0 — последнее сообщение, 1 — предпоследнее… Правило
  // работает только на сообщениях с глубиной от minDepth до maxDepth. Так чистят
  // старые сообщения (minDepth: виджеты прошлых ходов не едут в контекст) и
  // рисуют виджеты только на свежих (maxDepth). Нет поля — без ограничения.
  minDepth?: number;
  maxDepth?: number;
  // Замена — HTML (виджет из пресета): на экране рисуется разметкой в
  // изолированном блоке, а не показывается текстом. В промпт уходит как есть.
  html?: boolean;
}

export function newRegexRule(): RegexRule {
  return {
    id: uid('rx'),
    name: 'Новое правило',
    enabled: true,
    find: '',
    flags: 'g',
    replace: '',
    appliesTo: 'ai',
    scope: 'display',
  };
}

export function normalizeRegexRules(raw: unknown): RegexRule[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r: any) => r && typeof r.find === 'string')
    .map((r: any) => ({
      id: typeof r.id === 'string' ? r.id : uid('rx'),
      name: typeof r.name === 'string' ? r.name : 'Правило',
      enabled: typeof r.enabled === 'boolean' ? r.enabled : true,
      find: r.find,
      // Флаги чистим до известных: чужая буква роняет конструктор RegExp целиком.
      flags: typeof r.flags === 'string' ? dedupeFlags(r.flags) : 'g',
      replace: typeof r.replace === 'string' ? r.replace : '',
      appliesTo: r.appliesTo === 'user' || r.appliesTo === 'both' ? r.appliesTo : 'ai',
      scope: r.scope === 'prompt' || r.scope === 'both' ? r.scope : 'display',
      ...(depthOf(r.minDepth) !== undefined ? { minDepth: depthOf(r.minDepth) } : {}),
      ...(depthOf(r.maxDepth) !== undefined ? { maxDepth: depthOf(r.maxDepth) } : {}),
      ...(r.html ? { html: true } : {}),
    }));
}

function depthOf(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined;
}

function dedupeFlags(flags: string): string {
  const ok = new Set(['g', 'i', 'm', 's', 'u', 'y']);
  return [...new Set(flags.split(''))].filter((f) => ok.has(f)).join('');
}

// Битые выражения не должны сыпать в лог на каждом сообщении: один раз на правило.
const complained = new Set<string>();

function compile(rule: RegexRule): RegExp | null {
  try {
    return new RegExp(rule.find, rule.flags);
  } catch (e) {
    const key = rule.id + rule.find + rule.flags;
    if (!complained.has(key)) {
      complained.add(key);
      logEvent('warn', 'prompt', `Правило «${rule.name}» не компилируется и пропущено: ${(e as Error).message}`);
    }
    return null;
  }
}

// {{match}} — привычное по Таверне имя для всего совпадения. У нативного replace
// это $&; переводим, чтобы готовые правила переносились без правки. $0 — тоже
// Таверна: там это всё совпадение, а нативный replace его не знает.
function prepareReplacement(replace: string): string {
  return replace.replace(/\{\{\s*match\s*\}\}/gi, '$$&').replace(/\$0(?!\d)/g, '$$&');
}

// Подстановка $1…$99, $<имя>, $& и $$ — то же, что делает нативный replace, но
// руками: виджету нужен готовый текст замены, чтобы унести его из строки.
function substitute(tpl: string, match: string, groups: (string | undefined)[], named?: Record<string, string>): string {
  return tpl.replace(/\$(\$|&|<([^>]+)>|(\d{1,2}))/g, (whole, tok: string, name?: string, digits?: string) => {
    if (tok === '$') return '$';
    if (tok === '&') return match;
    if (name !== undefined) return named?.[name] ?? '';
    if (digits) {
      const two = Number(digits);
      if (digits.length === 2 && two >= 1 && two <= groups.length) return groups[two - 1] ?? '';
      const one = Number(digits[0]);
      if (one >= 1 && one <= groups.length) return (groups[one - 1] ?? '') + (digits.length === 2 ? digits[1] : '');
    }
    return whole;
  });
}

export const WIDGET_OPEN = '\uE000W';
export const WIDGET_CLOSE = '\uE001';
export const WIDGET_RE = /\uE000W(\d+)\uE001/g;

export interface RegexContext {
  /** Чей это текст. */
  role: 'ai' | 'user';
  /** Куда он идёт: на экран или в запрос модели. */
  scope: 'display' | 'prompt';
  /** Глубина сообщения (0 — последнее). Нет — считаем последним. */
  depth?: number;
  /** Макросы в тексте замены ({{char}}, {{user}}) — как в Таверне. */
  expand?: (s: string) => string;
  /** Сюда складываются HTML-виджеты; в тексте на их месте — метка WIDGET_RE. Только на экране. */
  widgets?: string[];
}

export function applyRegexRules(text: string, rules: RegexRule[] | undefined, ctx: RegexContext): string {
  if (!text || !rules?.length) return text;
  let out = text;
  for (const rule of rules) {
    if (!rule.enabled || !rule.find) continue;
    if (rule.appliesTo !== 'both' && rule.appliesTo !== ctx.role) continue;
    if (rule.scope !== 'both' && rule.scope !== ctx.scope) continue;
    const depth = ctx.depth ?? 0;
    if (rule.minDepth !== undefined && depth < rule.minDepth) continue;
    if (rule.maxDepth !== undefined && depth > rule.maxDepth) continue;
    const re = compile(rule);
    if (!re) continue;
    try {
      const tpl = prepareReplacement(ctx.expand && rule.replace.includes('{{') ? ctx.expand(rule.replace) : rule.replace);
      const widgets = rule.html && ctx.scope === 'display' ? ctx.widgets : undefined;
      if (widgets) {
        out = out.replace(re, (...args: any[]) => {
          const named = typeof args[args.length - 1] === 'object' ? (args[args.length - 1] as Record<string, string>) : undefined;
          const groups = args.slice(1, named ? -3 : -2) as (string | undefined)[];
          widgets.push(substitute(tpl, args[0], groups, named));
          return `${WIDGET_OPEN}${widgets.length - 1}${WIDGET_CLOSE}`;
        });
      } else {
        out = out.replace(re, tpl);
      }
    } catch (e) {
      logEvent('warn', 'prompt', `Правило «${rule.name}» упало при замене: ${(e as Error).message}`);
    }
  }
  return out;
}

// Пробный прогон для интерфейса: показывает результат и ошибку компиляции текстом,
// чтобы правило можно было довести до ума, не открывая игру.
export function testRegexRule(rule: RegexRule, sample: string): { ok: boolean; result: string } {
  if (!rule.find) return { ok: true, result: sample };
  try {
    const re = new RegExp(rule.find, dedupeFlags(rule.flags));
    return { ok: true, result: sample.replace(re, prepareReplacement(rule.replace)) };
  } catch (e) {
    return { ok: false, result: (e as Error).message };
  }
}
