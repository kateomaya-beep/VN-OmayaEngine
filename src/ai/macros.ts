import type { Character, Project, RuntimeState } from '../shared/types';

// МАКРОСЫ — детерминированная подстановка текста на этапе сборки контекста.
// Это НЕ язык скриптов: никаких условий, циклов и вызовов, только замена.
//
// Имена совпадают с Таверной там, где смысл тот же ({{user}}, {{char}}, {{persona}},
// {{description}}, {{personality}}, {{scenario}}, {{random:…}}, {{roll:…}}), чтобы
// готовые карточки и пресеты подставлялись без правки. Собственные макросы движка
// ({{stat:…}}, {{scene}}, {{turn}}) добавлены сверх этого списка.
//
// СОЗНАТЕЛЬНОЕ ОТЛИЧИЕ ОТ ТАВЕРНЫ: {{time}} и {{date}} — это ВНУТРИИГРОВЫЕ часы
// (Game Master), а не время на машине игрока. В истории почти всегда нужно первое;
// настоящее время доступно как {{realtime}} / {{realdate}}.
//
// Полный список — MACRO_HELP внизу файла (он же показывается в интерфейсе).

export interface MacroContext {
  project: Project;
  state?: RuntimeState | null;
  protagonistName?: string;
  /**
   * Переменные сборки запроса ({{setvar}} / {{getvar}}, как в Таверне). Одна карта на
   * весь запрос: блоки разворачиваются по порядку, и значение, заданное выше, видно
   * ниже. Так собираются пресеты Таверны: тумблер «язык: русский» ставит переменную,
   * а блок формата дальше её читает.
   */
  vars?: Map<string, string>;
}

// Переменные Таверны — по порядку появления в тексте: setvar раньше getvar в том же
// блоке тоже работает. Значение берётся до первых «}}», поэтому вложенные макросы в
// нём не поддерживаются (пресеты их там и не используют).
function expandVars(text: string, vars: Map<string, string>): string {
  return text.replace(
    /\{\{\s*(setvar|getvar|addvar|incvar|decvar)\s*::\s*([^:}]+?)\s*(?:::([\s\S]*?))?\}\}/gi,
    (_m, op: string, name: string, value?: string) => {
      const key = name.trim();
      const cur = vars.get(key) ?? '';
      switch (op.toLowerCase()) {
        case 'setvar':
          vars.set(key, value ?? '');
          return '';
        case 'getvar':
          return cur;
        case 'addvar': {
          const a = Number(cur);
          const b = Number(value);
          vars.set(key, !Number.isNaN(a) && !Number.isNaN(b) && cur !== '' ? String(a + b) : cur + (value ?? ''));
          return '';
        }
        case 'incvar':
          vars.set(key, String((Number(cur) || 0) + 1));
          return '';
        case 'decvar':
          vars.set(key, String((Number(cur) || 0) - 1));
          return '';
      }
      return '';
    }
  );
}

// Главный «собеседник» проекта для {{char}}: у нас, в отличие от карточки Таверны,
// персонажей много, поэтому берём первого ЛИ, иначе первого важного, иначе любого
// не-протагониста. Если нужен конкретный — есть {{char:Имя}}.
export function focusCharacter(project: Project): Character | undefined {
  return (
    project.characters.find((c) => c.role === 'love_interest') ||
    project.characters.find((c) => c.role === 'important_character') ||
    project.characters.find((c) => c.role !== 'protagonist')
  );
}

// Имя героя ровно в том виде, в каком его подставляет {{user}}. Держать вторую
// копию этой логики нельзя: по ней же строятся стоп-строки и подпись в чате, и
// разойдись они — стоп-строка ловила бы не то имя, что модель видит в промпте.
export function protagonistName(project: Project, state?: RuntimeState | null): string {
  return protagonistOf({ project, state }).name;
}

function protagonistOf(ctx: MacroContext): { char?: Character; name: string } {
  const char = ctx.project.characters.find((c) => c.role === 'protagonist');
  const name =
    ctx.protagonistName?.trim() || ctx.state?.protagonistName?.trim() || char?.name || 'Герой';
  return { char, name };
}

// Разбор «d20», «20», «2d6» → результат броска. Мусор → пустая строка.
function rollDice(spec: string): string {
  const m = /^\s*(\d*)\s*d?\s*(\d+)\s*$/i.exec(spec);
  if (!m) return '';
  const count = Math.min(Math.max(Number(m[1] || 1), 1), 100);
  const sides = Math.min(Math.max(Number(m[2]), 1), 1000);
  let total = 0;
  for (let i = 0; i < count; i++) total += 1 + Math.floor(Math.random() * sides);
  return String(total);
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

// Пользовательские макросы проекта: одна замена, БЕЗ рекурсии по самим себе.
// Ссылаться на встроенные макросы внутри значения можно — они раскрываются
// следующим проходом; ссылаться на другой пользовательский макрос нельзя, и это
// намеренно: иначе пара взаимных ссылок вешала бы сборку промпта.
function expandUserMacros(text: string, project: Project): string {
  const list = project.macros || [];
  if (!list.length) return text;
  let out = text;
  for (const m of list) {
    const name = m.name?.trim();
    if (!name || !/^[\w.-]+$/.test(name)) continue;
    out = out.replace(new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`, 'gi'), m.value ?? '');
  }
  return out;
}

export function expandMacros(text: string, ctx: MacroContext): string {
  if (!text || text.indexOf('{{') === -1) return text;
  const { project, state } = ctx;

  const { char: protagonistChar, name: protagonist } = protagonistOf(ctx);
  const focus = focusCharacter(project);
  const loveInterest = project.characters.find((c) => c.role === 'love_interest')?.name || '';
  const sceneName = project.assets.find((a) => a.id === state?.currentBackgroundId)?.name || '';
  const clock = state?.gm?.clock;

  const lastOf = (role: 'assistant' | 'user'): string => {
    const h = state?.history || [];
    for (let i = h.length - 1; i >= 0; i--) if (h[i].role === role) return h[i].content;
    return '';
  };

  const now = new Date();

  let out = expandUserMacros(text, project);
  // Комментарии Таверны {{// …}} — для автора пресета, модели они не нужны.
  out = out.replace(/\{\{\s*\/\/[\s\S]*?\}\}/g, '');
  if (ctx.vars) out = expandVars(out, ctx.vars);

  const simple: Record<string, string> = {
    // Кто есть кто
    user: protagonist,
    protagonist,
    persona: protagonistChar?.card.personality || protagonistChar?.card.appearance || '',
    char: focus?.name || '',
    loveinterest: loveInterest,
    description: focus?.card.appearance || '',
    personality: focus?.card.personality || '',
    scenario: focus?.card.scenario || project.lore.plotOutline || '',
    // Мир и время
    scene: sceneName,
    location: clock?.location || '',
    date: clock?.date || '',
    time: clock?.time || '',
    turn: String(state?.turnCount ?? 0),
    realdate: `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}`,
    realtime: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
    // Переписка
    lastmessage: lastOf('assistant'),
    lastusermessage: lastOf('user'),
    // Утилиты
    newline: '\n',
    // Сводка сюжета (в Таверне — расширение Summarize): у нас это снапшот памяти.
    summary: state?.memory?.storyState?.trim() || '',
  };

  out = out.replace(/\{\{\s*([a-z_][\w]*)\s*\}\}/gi, (whole, key: string) => {
    const v = simple[key.toLowerCase()];
    return v === undefined ? whole : v;
  });

  return out
    .replace(/\{\{\s*char:\s*([^}]+?)\s*\}\}/gi, (_m, name: string) => {
      const c = project.characters.find(
        (x) => x.name.toLowerCase() === name.trim().toLowerCase()
      );
      return c ? c.name : name.trim();
    })
    .replace(/\{\{\s*stat:\s*([^}]+?)\s*\}\}/gi, (_m, name: string) => {
      const stat = project.stats.find((s) => s.name.toLowerCase() === name.trim().toLowerCase());
      if (!stat) return name.trim();
      const v = state?.statValues[stat.id] ?? stat.initial;
      return String(v);
    })
    .replace(/\{\{\s*random:\s*([^}]+?)\s*\}\}/gi, (_m, list: string) => {
      const items = list.split(/[,|]/).map((x) => x.trim()).filter(Boolean);
      return items.length ? items[Math.floor(Math.random() * items.length)] : '';
    })
    .replace(/\{\{\s*roll:\s*([^}]+?)\s*\}\}/gi, (_m, spec: string) => rollDice(spec))
    .replace(/\{\{\s*trim\s*\}\}\s*/gi, '');
}

// Справка для интерфейса (панель пресета). Порядок — по осмысленности, не по алфавиту.
export const MACRO_HELP: { name: string; what: string }[] = [
  { name: '{{user}}', what: 'имя героя игрока (то же, что {{protagonist}})' },
  { name: '{{char}}', what: 'главный собеседник проекта: первый ЛИ, иначе важный персонаж' },
  { name: '{{char:Имя}}', what: 'имя конкретного персонажа по карточке' },
  { name: '{{persona}}', what: 'описание героя игрока из его карточки' },
  { name: '{{description}}', what: 'внешность {{char}} из карточки' },
  { name: '{{personality}}', what: 'характер {{char}}' },
  { name: '{{scenario}}', what: 'сценарий из карточки {{char}}, иначе сюжетная арка проекта' },
  { name: '{{location}}', what: 'где герой сейчас (часы Game Master)' },
  { name: '{{date}} / {{time}}', what: 'внутриигровые дата и время' },
  { name: '{{realdate}} / {{realtime}}', what: 'настоящие дата и время на устройстве' },
  { name: '{{turn}}', what: 'номер текущего хода' },
  { name: '{{scene}}', what: 'название текущего фона' },
  { name: '{{stat:Имя}}', what: 'текущее значение стата' },
  { name: '{{lastMessage}}', what: 'последний ответ ИИ целиком' },
  { name: '{{lastUserMessage}}', what: 'последний ход игрока' },
  { name: '{{random:а,б,в}}', what: 'случайный вариант из списка' },
  { name: '{{roll:d20}}', what: 'бросок кубика (можно 2d6)' },
  { name: '{{newline}}', what: 'перевод строки' },
  { name: '{{trim}}', what: 'съедает пробелы и переводы строк после себя' },
  { name: '{{setvar::имя::значение}}', what: 'задать переменную запроса (как в Таверне); блоки ниже её видят' },
  { name: '{{getvar::имя}}', what: 'значение переменной, заданной выше' },
  { name: '{{summary}}', what: 'снапшот памяти — сводка того, что уже случилось' },
];
