import type {
  Character,
  CharacterRole,
  LorebookEntry,
  Project,
  StatDefinition,
} from '../shared/types';
import { emptyRelationship } from '../shared/types';
import { uid } from '../shared/utils';
import { logEvent } from '../shared/logStore';

// АССИСТЕНТ-СОАВТОР: чат, который видит проект и умеет его править.
//
// Правки идут не «сам решил и переписал», а по протоколу, у которого три свойства,
// и все три обязательны:
//  1. Каждое действие ЯВНОЕ — отдельная операция с полями, а не свободный текст,
//     который потом кто-то пытается разобрать.
//  2. Каждое применённое действие описывается человеческой строкой: игрок видит,
//     ЧТО именно изменилось, а не «ассистент обновил проект».
//  3. Каждое действие обратимо. Откат хранится вместе с сообщением (компактно —
//     id и прежнее значение поля), поэтому переживает перезагрузку вкладки.
// Без третьего пункта «ассистент правит проект сам» означало бы, что он в любой
// момент может молча затереть то, что вы писали руками.

export const ASSIST_OPEN = '<apply>';
export const ASSIST_CLOSE = '</apply>';

const APPLY_RE = new RegExp(
  `${ASSIST_OPEN}\\s*(?:\`\`\`(?:json)?\\s*)?([\\s\\S]*?)(?:\\s*\`\`\`)?\\s*${ASSIST_CLOSE}`,
  'i'
);

// ---- Откат ----------------------------------------------------------------

export type Revert =
  | { kind: 'deleteCharacter'; id: string }
  | { kind: 'restoreCharacter'; id: string; prev: Character }
  | { kind: 'deleteLorebook'; id: string }
  | { kind: 'restoreLorebook'; id: string; prev: LorebookEntry }
  | { kind: 'deleteStat'; id: string }
  | { kind: 'restoreLore'; field: keyof Project['lore']; prev: string };

export interface AppliedChange {
  /** Человеческая строка: что именно изменилось. */
  label: string;
  revert: Revert;
}

export interface AssistantMessage {
  role: 'user' | 'assistant';
  content: string;
  /** Изменения, применённые этим сообщением (только у ответов ассистента). */
  changes?: AppliedChange[];
  /** true — изменения уже откачены, кнопка отката больше не действует. */
  reverted?: boolean;
}

// ---- Контекст проекта -----------------------------------------------------

function characterDigest(c: Character): string {
  const bits = [
    `#${c.id} «${c.name}» (${c.role})`,
    c.card.appearance && `внешность: ${c.card.appearance}`,
    c.card.personality && `характер: ${c.card.personality}`,
    c.card.speechStyle && `речь: ${c.card.speechStyle}`,
    c.card.backstory && `прошлое: ${c.card.backstory}`,
  ].filter(Boolean);
  return bits.join('\n  ');
}

// Слепок проекта для контекста. Лорбук — только заголовки и ключи: его содержимое
// бывает на десятки тысяч знаков, и таскать его в каждый вопрос про имя персонажа
// значило бы платить за это каждым сообщением.
export function projectDigest(project: Project): string {
  const parts: string[] = [];
  parts.push(`== ПРОЕКТ ==\nНазвание: ${project.meta.title || '(без названия)'}\nРейтинг: ${project.meta.contentRating}`);
  if (project.lore.worldDescription.trim()) parts.push(`== ОПИСАНИЕ МИРА ==\n${project.lore.worldDescription}`);
  if (project.lore.plotOutline.trim()) parts.push(`== АРКА СЮЖЕТА ==\n${project.lore.plotOutline}`);
  if (project.lore.openingScene.trim()) parts.push(`== СТАРТОВАЯ СЦЕНА ==\n${project.lore.openingScene}`);
  if (project.lore.narrativeRules.trim()) parts.push(`== ПРАВИЛА ПОВЕСТВОВАНИЯ ==\n${project.lore.narrativeRules}`);

  parts.push(
    project.characters.length
      ? `== ПЕРСОНАЖИ (${project.characters.length}) ==\n` +
          project.characters.map((c) => '- ' + characterDigest(c)).join('\n')
      : '== ПЕРСОНАЖИ ==\n(ни одного)'
  );

  parts.push(
    project.lorebook.length
      ? `== ЛОРБУК (${project.lorebook.length} записей; показаны заголовки и ключи, содержимое спрашивайте) ==\n` +
          project.lorebook.map((e) => `- #${e.id} «${e.title}» [${e.keys.join(', ')}]`).join('\n')
      : '== ЛОРБУК ==\n(пусто)'
  );

  if (project.stats.length) {
    parts.push(
      `== СТАТЫ ==\n` +
        project.stats.map((s) => `- «${s.name}» ${s.min}…${s.max}, старт ${s.initial}${s.description ? ` — ${s.description}` : ''}`).join('\n')
    );
  }
  return parts.join('\n\n');
}

export const DEFAULT_ASSISTANT_PERSONA = `Ты — соавтор и редактор этого проекта. Спокойный, конкретный, с хорошим вкусом к прозе.
Говоришь коротко и по делу, без комплиментов и воды. Если задумка слабая — говоришь прямо и предлагаешь, чем заменить.
Не пишешь за автора то, о чём не просили, и не «улучшаешь» молча уже написанное.`;

const PROTOCOL = `КАК ТЫ ПРАВИШЬ ПРОЕКТ.

Ты можешь менять проект сам — но только явными операциями и только когда автор об этом попросил.
Сначала обычным текстом коротко скажи, что делаешь. Потом, если правки нужны, добавь В САМОМ КОНЦЕ ответа ровно один блок:

${ASSIST_OPEN}
[ { "op": "...", ... }, ... ]
${ASSIST_CLOSE}

Операции (все поля-строки — обычный текст, без markdown-заголовков):
- { "op": "character.create", "name": "...", "role": "protagonist|love_interest|important_character|npc", "appearance": "...", "personality": "...", "speechStyle": "...", "backstory": "...", "relationshipArc": "..." }
- { "op": "character.update", "id": "<id из ростера>", "name": "...", "role": "...", "appearance": "...", "personality": "...", "speechStyle": "...", "backstory": "...", "relationshipArc": "..." }  — присылай ТОЛЬКО те поля, которые меняешь
- { "op": "lorebook.add", "title": "...", "keys": ["...", "..."], "content": "...", "alwaysActive": false }
- { "op": "lorebook.update", "id": "<id>", "title": "...", "keys": [...], "content": "...", "alwaysActive": false }  — только меняемые поля
- { "op": "lore.world", "content": "..." }      — заменить описание мира целиком
- { "op": "lore.plot", "content": "..." }       — заменить арку сюжета
- { "op": "lore.opening", "content": "..." }    — заменить стартовую сцену
- { "op": "lore.rules", "content": "..." }      — заменить правила повествования
- { "op": "stat.create", "name": "...", "min": 0, "max": 100, "initial": 50, "description": "..." }

ЖЁСТКИЕ ПРАВИЛА:
- Нет блока — ничего не меняется. Это нормальный и частый случай: на вопрос отвечают текстом.
- Не трогай то, о чём не просили. Заменять описание мира, когда попросили придумать соседа, — это порча работы автора.
- lore.* заменяют поле ЦЕЛИКОМ. Прежде чем заменить непустое поле, дописав к нему абзац, — пришли текст целиком, вместе со старым содержимым.
- Правишь существующего персонажа или запись — бери id из списка выше и шли только изменившиеся поля. Заводить второго «Дэма» вместо правки первого нельзя.
- Всё, что ты пишешь в поля, — на языке проекта (том же, на котором написан лор).
- Ничего, кроме прозы ответа и одного блока в конце. Никаких комментариев внутри JSON.`;

export function buildAssistantSystem(project: Project, persona: string): string {
  const who = persona.trim() || DEFAULT_ASSISTANT_PERSONA;
  return [who, projectDigest(project), PROTOCOL].join('\n\n---\n\n');
}

// ---- Разбор ответа --------------------------------------------------------

export interface ParsedAssistantReply {
  /** Текст для показа: без служебного блока. */
  text: string;
  /** Сырые операции — ещё не применённые и не проверенные. */
  ops: any[];
}

export function stripApplyBlock(raw: string): string {
  return raw.replace(APPLY_RE, '').trim();
}

export function parseAssistantReply(raw: string): ParsedAssistantReply {
  const text = stripApplyBlock(raw);
  const m = APPLY_RE.exec(raw);
  if (!m) return { text, ops: [] };
  try {
    const parsed = JSON.parse(m[1].trim());
    return { text, ops: Array.isArray(parsed) ? parsed : [parsed] };
  } catch (e) {
    logEvent('warn', 'prompt', 'Ассистент прислал блок правок с невалидным JSON — правки не применены: ' + (e as Error).message);
    return { text, ops: [] };
  }
}

// Текст для показа, пока ответ ещё набирается: служебный блок не должен мелькать.
export function streamingAssistantText(raw: string): string {
  let t = raw.replace(APPLY_RE, '');
  const at = t.indexOf(ASSIST_OPEN);
  if (at !== -1) t = t.slice(0, at);
  t = t.replace(/<[a-z]*$/i, '');
  return t.trimStart();
}

// ---- Применение -----------------------------------------------------------

const ROLES = new Set<CharacterRole>(['protagonist', 'love_interest', 'important_character', 'npc']);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function shorten(s: string, n = 60): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

const LORE_FIELDS: Record<string, { field: keyof Project['lore']; label: string }> = {
  'lore.world': { field: 'worldDescription', label: 'описание мира' },
  'lore.plot': { field: 'plotOutline', label: 'арку сюжета' },
  'lore.opening': { field: 'openingScene', label: 'стартовую сцену' },
  'lore.rules': { field: 'narrativeRules', label: 'правила повествования' },
};

// Применяет операции к ЧЕРНОВИКУ проекта (мутирует его — так работает projectStore.update)
// и возвращает список изменений с откатом. Непонятную операцию пропускаем молча в
// проект, но громко в лог: ассистент не должен ронять редактор опечаткой в op.
export function applyAssistantOps(draft: Project, ops: any[]): AppliedChange[] {
  const changes: AppliedChange[] = [];

  for (const raw of ops) {
    const op = str(raw?.op);
    if (!op) continue;

    if (op === 'character.create') {
      const name = str(raw.name)?.trim();
      if (!name) continue;
      const role = ROLES.has(raw.role) ? (raw.role as CharacterRole) : 'important_character';
      const c: Character = {
        id: uid('chr'),
        name,
        role,
        card: {
          appearance: str(raw.appearance) ?? '',
          personality: str(raw.personality) ?? '',
          backstory: str(raw.backstory) ?? '',
          speechStyle: str(raw.speechStyle) ?? '',
          relationshipArc: str(raw.relationshipArc),
        },
        sprites: {},
        relationship: emptyRelationship(),
        importedFrom: 'manual',
      };
      draft.characters = [...draft.characters, c];
      changes.push({ label: `Создан персонаж «${name}» (${role})`, revert: { kind: 'deleteCharacter', id: c.id } });
      continue;
    }

    if (op === 'character.update') {
      const id = str(raw.id);
      const idx = draft.characters.findIndex((c) => c.id === id);
      if (idx === -1) {
        logEvent('warn', 'prompt', `Ассистент правит несуществующего персонажа (${id}) — пропущено`);
        continue;
      }
      const prev: Character = JSON.parse(JSON.stringify(draft.characters[idx]));
      const c = { ...prev, card: { ...prev.card } };
      const touched: string[] = [];
      const nm = str(raw.name)?.trim();
      if (nm && nm !== c.name) {
        c.name = nm;
        touched.push('имя');
      }
      if (ROLES.has(raw.role) && raw.role !== c.role) {
        c.role = raw.role;
        touched.push('роль');
      }
      const cardFields: [string, keyof Character['card'], string][] = [
        ['appearance', 'appearance', 'внешность'],
        ['personality', 'personality', 'характер'],
        ['speechStyle', 'speechStyle', 'манеру речи'],
        ['backstory', 'backstory', 'прошлое'],
        ['relationshipArc', 'relationshipArc', 'арку отношений'],
      ];
      for (const [key, field, label] of cardFields) {
        const v = str(raw[key]);
        if (v !== undefined && v !== c.card[field]) {
          (c.card as any)[field] = v;
          touched.push(label);
        }
      }
      if (!touched.length) continue;
      draft.characters = draft.characters.map((x, i) => (i === idx ? c : x));
      changes.push({
        label: `«${c.name}»: обновлены ${touched.join(', ')}`,
        revert: { kind: 'restoreCharacter', id: c.id, prev },
      });
      continue;
    }

    if (op === 'lorebook.add') {
      const title = str(raw.title)?.trim();
      const content = str(raw.content);
      if (!title || !content) continue;
      const e: LorebookEntry = {
        id: uid('lore'),
        title,
        keys: Array.isArray(raw.keys) ? raw.keys.filter((k: unknown) => typeof k === 'string' && k.trim()) : [],
        content,
        alwaysActive: !!raw.alwaysActive,
        priority: 0,
      };
      draft.lorebook = [...draft.lorebook, e];
      changes.push({
        label: `Запись лорбука «${title}» (ключи: ${e.keys.join(', ') || '—'})`,
        revert: { kind: 'deleteLorebook', id: e.id },
      });
      continue;
    }

    if (op === 'lorebook.update') {
      const id = str(raw.id);
      const idx = draft.lorebook.findIndex((e) => e.id === id);
      if (idx === -1) {
        logEvent('warn', 'prompt', `Ассистент правит несуществующую запись лорбука (${id}) — пропущено`);
        continue;
      }
      const prev: LorebookEntry = JSON.parse(JSON.stringify(draft.lorebook[idx]));
      const e = { ...prev };
      const touched: string[] = [];
      const title = str(raw.title)?.trim();
      if (title && title !== e.title) {
        e.title = title;
        touched.push('заголовок');
      }
      const content = str(raw.content);
      if (content !== undefined && content !== e.content) {
        e.content = content;
        touched.push('текст');
      }
      if (Array.isArray(raw.keys)) {
        const keys = raw.keys.filter((k: unknown) => typeof k === 'string' && k.trim());
        if (keys.join('|') !== e.keys.join('|')) {
          e.keys = keys;
          touched.push('ключи');
        }
      }
      if (typeof raw.alwaysActive === 'boolean' && raw.alwaysActive !== e.alwaysActive) {
        e.alwaysActive = raw.alwaysActive;
        touched.push('всегда активна');
      }
      if (!touched.length) continue;
      draft.lorebook = draft.lorebook.map((x, i) => (i === idx ? e : x));
      changes.push({
        label: `Лорбук «${e.title}»: обновлены ${touched.join(', ')}`,
        revert: { kind: 'restoreLorebook', id: e.id, prev },
      });
      continue;
    }

    if (op === 'stat.create') {
      const name = str(raw.name)?.trim();
      if (!name) continue;
      const min = Number.isFinite(raw.min) ? Math.round(raw.min) : 0;
      const max = Number.isFinite(raw.max) ? Math.round(raw.max) : 100;
      const s: StatDefinition = {
        id: uid('stat'),
        name,
        min: Math.min(min, max),
        max: Math.max(min, max),
        initial: Number.isFinite(raw.initial) ? Math.round(raw.initial) : Math.round((min + max) / 2),
        visible: true,
        description: str(raw.description) ?? '',
      };
      draft.stats = [...draft.stats, s];
      changes.push({ label: `Создан стат «${name}» (${s.min}…${s.max})`, revert: { kind: 'deleteStat', id: s.id } });
      continue;
    }

    const lore = LORE_FIELDS[op];
    if (lore) {
      const content = str(raw.content);
      if (content === undefined) continue;
      const prev = draft.lore[lore.field];
      if (content === prev) continue;
      draft.lore[lore.field] = content;
      changes.push({
        label: `Заменено ${lore.label}: «${shorten(content)}»`,
        revert: { kind: 'restoreLore', field: lore.field, prev },
      });
      continue;
    }

    logEvent('warn', 'prompt', `Ассистент прислал неизвестную операцию «${op}» — пропущена`);
  }

  return changes;
}

// Откат применяется в ОБРАТНОМ порядке: правки одного ответа могли опираться друг
// на друга (создали персонажа, потом его же обновили).
export function revertAssistantChanges(draft: Project, changes: AppliedChange[]): void {
  for (const ch of [...changes].reverse()) {
    const r = ch.revert;
    switch (r.kind) {
      case 'deleteCharacter':
        draft.characters = draft.characters.filter((c) => c.id !== r.id);
        break;
      case 'restoreCharacter':
        draft.characters = draft.characters.map((c) => (c.id === r.id ? r.prev : c));
        break;
      case 'deleteLorebook':
        draft.lorebook = draft.lorebook.filter((e) => e.id !== r.id);
        break;
      case 'restoreLorebook':
        draft.lorebook = draft.lorebook.map((e) => (e.id === r.id ? r.prev : e));
        break;
      case 'deleteStat':
        draft.stats = draft.stats.filter((s) => s.id !== r.id);
        break;
      case 'restoreLore':
        draft.lore[r.field] = r.prev;
        break;
    }
  }
}
