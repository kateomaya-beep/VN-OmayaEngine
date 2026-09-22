import type {
  ArcStage,
  Character,
  CharacterRole,
  LorebookEntry,
  MemoryBookEntry,
  MemoryEntryKind,
  MemoryEntryMode,
  MemoryState,
  Project,
  RuntimeState,
  StatDefinition,
} from '../shared/types';
import { chaptersOf } from './chapters';
import type { ChapterScope } from './chapterJobs';
import { emptyRelationship } from '../shared/types';
import { uid } from '../shared/utils';
import { logEvent } from '../shared/logStore';
import { stripStateBlock } from './rpResponse';

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
  | { kind: 'restoreLore'; field: keyof Project['lore']; prev: string }
  // Правки ПАМЯТИ ПРОХОЖДЕНИЯ (меморибук, эволюция) — только из игры.
  | { kind: 'deleteMemory'; id: string }
  | { kind: 'restoreMemory'; prev: MemoryBookEntry; index?: number }
  | { kind: 'deleteArcStage'; name: string; id: string }
  | { kind: 'dropJob'; jobId: string };

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

// Слепок ТЕКУЩЕГО ПРОХОЖДЕНИЯ — то, чего в проекте нет: часы, досье, связи,
// журнал эпизодов, последние ходы. Уходит, только когда ассистент открыт из игры.
//
// Зачем. Без него ассистент знал сеттинг, но не знал ИСТОРИЮ, и на просьбу «заведи
// того, кто появился» отвечать ему было нечем: он видел ростер из конструктора, где
// нового персонажа как раз и нет. Приходилось пересказывать своими словами то, что
// движок и так помнит, — либо собирать карточку руками в панели Game Master.
//
// Что важнее всего: люди, которых история уже знает, а проект — ещё нет. Они
// помечены явно, потому что это ровно тот случай, ради которого слепок и нужен.
const MAX_HISTORY_TURNS = 8;
const MAX_GM_CHARACTERS = 24;

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

export function playthroughDigest(project: Project, state: RuntimeState): string {
  const parts: string[] = [];
  const gm = state.gm;

  const clock = [gm.clock.day, gm.clock.month, gm.clock.year].filter(Boolean).join(' ');
  const whereWhen = [clock, gm.clock.time, gm.clock.location].filter(Boolean).join(', ');
  parts.push(
    `== ТЕКУЩЕЕ ПРОХОЖДЕНИЕ ==\nХод: ${state.turnCount}` +
      (whereWhen ? `\nСейчас в истории: ${whereWhen}` : '') +
      (state.protagonistName ? `\nГерой: ${state.protagonistName}` : '')
  );

  if (state.memory.storyState?.trim()) {
    parts.push(`== ПОЛОЖЕНИЕ ДЕЛ (снапшот памяти) ==\n${state.memory.storyState.trim()}`);
  }
  parts.push(memorybookDigest(state));

  // Ключевые и важные события видны все: их и так немного, а мелочь вытесняется.
  const events = gm.events.filter((e) => e.level === 'key' || e.level === 'important').slice(-12);
  if (events.length) {
    parts.push(
      `== КЛЮЧЕВЫЕ СОБЫТИЯ ==\n` +
        events.map((e) => `- [ход ${e.turn}${e.date ? ', ' + e.date : ''}] ${truncate(e.summary, 200)}`).join('\n')
    );
  }

  if (gm.characters.length) {
    const known = new Set(project.characters.map((c) => c.id));
    // На длинной партии досье набирается на десятки людей, и целиком они съели бы
    // весь запрос. Режем, но НЕ по свежести: первыми идут те, у кого карточки нет —
    // ради них слепок и собирается. Дальше по возрасту записи.
    const carded = (c: (typeof gm.characters)[number]) => !!(c.charId && known.has(c.charId));
    const ordered = [...gm.characters].sort((a, b) => {
      if (carded(a) !== carded(b)) return carded(a) ? 1 : -1;
      return (b.updatedAtTurn ?? 0) - (a.updatedAtTurn ?? 0);
    });
    const shown = ordered.slice(0, MAX_GM_CHARACTERS);
    const cut = gm.characters.length - shown.length;
    const line = (c: (typeof gm.characters)[number]) => {
      const carded = c.charId && known.has(c.charId);
      const bits = [
        c.dossier && `кто: ${truncate(c.dossier, 160)}`,
        c.roleToHero && `герою: ${truncate(c.roleToHero, 100)}`,
        c.appearance && `внешность: ${truncate(c.appearance, 160)}`,
        c.personality && `характер: ${truncate(c.personality, 160)}`,
        c.status && `статус: ${truncate(c.status, 80)}`,
        c.location && `где: ${truncate(c.location, 60)}`,
        c.tags.length && `знает/помнит: ${c.tags.map((t) => truncate(t, 80)).join('; ')}`,
      ].filter(Boolean);
      return (
        `- «${c.name}»${carded ? ` (карточка #${c.charId})` : ' — КАРТОЧКИ В ПРОЕКТЕ НЕТ'}\n  ` +
        bits.join('\n  ')
      );
    };
    parts.push(
      `== ЛЮДИ В ЭТОЙ ИСТОРИИ (досье движка) ==\n` +
        shown.map(line).join('\n') +
        (cut > 0 ? `\n(ещё ${cut} — давно не упоминались, спросите, если нужны)` : '')
    );
  }

  if (gm.relations.length) {
    parts.push(
      `== СВЯЗИ ==\n` +
        gm.relations.slice(-40).map((r) => `- ${r.from} → ${r.to}: ${r.label}`).join('\n')
    );
  }
  if (gm.locations.length) {
    parts.push(
      `== МЕСТА, ГДЕ УЖЕ БЫВАЛИ ==\n` +
        gm.locations
          .slice(-24)
          .map((l) => `- ${l.name}${l.description ? ': ' + truncate(l.description, 160) : ''}`)
          .join('\n')
    );
  }
  const openTasks = gm.agenda.filter((t) => !t.done);
  if (openTasks.length) {
    parts.push(`== ОТКРЫТЫЕ ЛИНИИ ==\n` + openTasks.map((t) => `- ${t.text}`).join('\n'));
  }

  // Последние ходы дословно: досье говорит, ЧТО есть, а этот кусок — каким тоном
  // это написано. Без него ассистент правит карточки вслепую по пересказу.
  //
  // Служебное вычищаем: <state> в конце хода — это тот же список досье, только
  // сырым JSON (второй копией он лишь съедает место), а «[VERBATIM]» — пометка
  // движка, которую ассистенту незачем ни читать, ни повторять.
  const tail = state.history.slice(-MAX_HISTORY_TURNS);
  if (tail.length) {
    parts.push(
      `== ПОСЛЕДНИЕ ХОДЫ (${tail.length}) ==\n` +
        tail
          .map((m) => {
            const body = stripStateBlock(String(m.content)).replace(/^\s*\[[A-Z ]+\]\s*/, '');
            return `[${m.role === 'user' ? 'игрок' : 'история'}] ${truncate(body, 700)}`;
          })
          .filter((l) => l.split('] ')[1])
          .join('\n')
    );
  }
  return parts.join('\n\n');
}

// Меморибук и эволюция для ассистента. Главы — оглавлением (id, ходы, режим,
// ключи, суть): целиком их десятки тысяч знаков. Последние три — полнее, чтобы
// было от чего оттолкнуться, дописывая следующую запись.
const MAX_MB_ENTRIES = 80;
function memorybookDigest(state: RuntimeState): string {
  const m = state.memory;
  const allCh = chaptersOf(m);
  // Нумерация — только действующих глав (как в запросе к модели); выключенные
  // идут списком после, чтобы ассистент знал об их существовании.
  const chapters = allCh.filter((c) => c.mode !== 'off');
  const offChapters = allCh.filter((c) => c.mode === 'off');
  const others = [...m.memorybook.filter((e) => e.kind !== 'chapter'), ...offChapters];
  const turns = (e: MemoryBookEntry) =>
    e.fromTurn && e.toTurn ? `ходы ${e.fromTurn}–${e.toTurn}` : e.turn ? `ход ${e.turn}` : '';
  const meta = (e: MemoryBookEntry) =>
    [turns(e), e.mode === 'constant' ? 'постоянная' : e.mode === 'off' ? 'ВЫКЛ' : 'по ключам', e.keys.length ? `ключи: ${e.keys.join(', ')}` : 'без ключей']
      .filter(Boolean)
      .join('; ');
  const lines: string[] = [];
  const shownCh = chapters.slice(-MAX_MB_ENTRIES);
  shownCh.forEach((c, i) => {
    const n = chapters.length - shownCh.length + i + 1;
    const full = i >= shownCh.length - 3;
    lines.push(
      `- #${c.id} Глава ${n} «${c.title}» (${meta(c)})${c.source === 'legacy' ? ' [из старого журнала]' : ''}\n  ${
        full ? truncate(c.text, 900) : truncate(c.gist || c.text, 200)
      }`
    );
  });
  for (const e of others.slice(-40)) {
    const label = e.kind === 'fact' ? 'Факт' : e.kind === 'chapter' ? 'Глава (выкл)' : 'Событие';
    lines.push(`- #${e.id} ${label} «${e.title}» (${meta(e)})\n  ${truncate(e.text, 240)}`);
  }
  const arcs = (m.arcs || []).filter((a) => a.stages.length);
  const arcLines = arcs.map((a) => {
    const last = a.stages[a.stages.length - 1];
    return `- ${a.name}: ${a.stages.map((x) => x.label).join(' → ')} (сейчас: ${truncate(last.now || last.change, 200)})`;
  });
  const covered = m.foldedMsgCount
    ? `Свёрнуто сообщений: ${m.foldedMsgCount}; архив периодов: ${m.rawArchive.length}; живая история: ${state.history.length} сообщ.`
    : `Живая история: ${state.history.length} сообщ., свёрток ещё не было.`;
  return (
    `== МЕМОРИБУК (${m.memorybook.length} записей: действующих глав ${chapters.length}) ==\n${covered}\n` +
    (lines.length ? lines.join('\n') : '(пусто — ни одной записи)') +
    (arcLines.length ? `\n\n== ЭВОЛЮЦИЯ ПЕРСОНАЖЕЙ ==\n${arcLines.join('\n')}` : '')
  );
}

// Добавка к протоколу для работы ИЗ ИГРЫ. Отдельным куском, потому что в
// конструкторе прохождения ещё нет и половина этих правил там бессмысленна.
const IN_GAME_PROTOCOL = `ТЫ ОТКРЫТ ПРЯМО ВО ВРЕМЯ ИГРЫ.

Выше слепок текущего прохождения: часы, досье движка, меморибук (главы), эволюция персонажей, связи и последние ходы. Пользуйся им как первоисточником о том, ЧТО уже произошло, — он свежее, чем описание мира в проекте.

- Персонаж с пометкой «КАРТОЧКИ В ПРОЕКТЕ НЕТ» появился в истории, но постоянной карточки у него нет: досье движка живёт в прохождении и в другую партию не переедет. Если автор просит его завести — собери character.create ПО ТОМУ, ЧТО УЖЕ НАПИСАНО в досье и в последних ходах, а не выдумывай заново. Имя бери в точности как в досье: движок связывает карточку с досье по имени.
- Правки уходят В ПРОЕКТ (в сеттинг), а не в текущую партию. Отредактировать сам ход истории отсюда нельзя — карточка повлияет на следующие ходы, а не на уже написанные.
- Досье, часы, статусы и связи ты НЕ правишь: они принадлежат прохождению и меняются самой игрой (и вручную — в панели Game Master). Заметил в них противоречие — скажи словами, не пытайся исправить операцией.
- Не пересказывай автору его же историю. Он её только что прочитал.

МЕМОРИБУК И ЭВОЛЮЦИЯ ТЫ ПРАВИТЬ МОЖЕШЬ — это память ЭТОЙ партии. Меморибук работает как лорбук: запись «по ключам» приходит модели, когда её ключ встречается в сцене; «постоянная» — всегда; «выкл» — никогда. Операции (только из игры):
- { "op": "memory.add", "kind": "event|fact|chapter", "title": "...", "text": "...", "keys": ["...", "..."], "mode": "keyword|constant|off" }
- { "op": "memory.update", "id": "<id записи>", "title": "...", "text": "...", "keys": [...], "mode": "..." }  — только меняемые поля
- { "op": "memory.delete", "id": "<id записи>" }
- { "op": "memory.chapters", "fromTurn": 120, "toTurn": 150 }  — движок САМ соберёт главы по дословному тексту этих ходов (из архива и живой истории)
- { "op": "memory.fill" }  — заполнить меморибук с нуля: главы для всего, что ещё не описано главами (архив + живая история, кроме текущей сцены)
- { "op": "arc.add", "name": "<имя персонажа>", "label": "название этапа", "change": "что в нём изменилось", "cause": "из-за чего", "now": "кто он теперь" }
Как выбирать:
- Просят «внести/запомнить событие, факт» — memory.add: коротко, по сути, ключи — имена, места и предметы В ТОЧНОСТИ как они пишутся в тексте игры (на её языке, с учётом того, как их там называют). Важное навсегда (родство, клятва, смерть) — mode "constant"; остальное — "keyword".
- Просят занести в память кусок истории или «то, что было раньше», — memory.chapters с диапазоном ходов. Сам пересказывать давнюю историю НЕ пытайся: ты видишь только последние ходы, а движок читает дословный текст.
- Меморибук пуст или памяти не было вовсе («заполни меморибук», «память не записывалась») — memory.fill. Это долгая фоновая сборка: так и скажи автору, прогресс виден в Game Master → Меморибук.
- Id бери только из списка меморибука выше. Не заводи вторую запись о том, что уже есть, — правь существующую.`;

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

// state передаётся, только когда ассистент открыт из игры: в конструкторе
// прохождения нет, и слепок был бы пустым разделом на пустом месте.
export function buildAssistantSystem(
  project: Project,
  persona: string,
  state?: RuntimeState | null
): string {
  const who = persona.trim() || DEFAULT_ASSISTANT_PERSONA;
  const parts = [who, projectDigest(project)];
  if (state) parts.push(playthroughDigest(project, state));
  parts.push(PROTOCOL);
  if (state) parts.push(IN_GAME_PROTOCOL);
  return parts.join('\n\n---\n\n');
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

    // Операции над памятью прохождения применяет плеер (applyAssistantMemoryOps).
    if (op.startsWith('memory.') || op === 'arc.add') continue;
    logEvent('warn', 'prompt', `Ассистент прислал неизвестную операцию «${op}» — пропущена`);
  }

  return changes;
}

// ---- Операции над памятью прохождения ----------------------------------------

const MEM_KINDS = new Set<MemoryEntryKind>(['chapter', 'event', 'fact']);
const MEM_MODES = new Set<MemoryEntryMode>(['constant', 'keyword', 'off']);
const strKeys = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string' && !!k.trim()).map((k) => k.trim()) : undefined;

export interface MemoryOpsResult {
  changes: AppliedChange[];
  /** Сборки глав, которые нужно запустить (долгие, в фоне). */
  jobs: { scope: ChapterScope; jobId: string }[];
}

/** Есть ли в ответе операции над памятью (их применяет плеер, а не конструктор). */
export function hasMemoryOps(ops: any[]): boolean {
  return ops.some((o) => typeof o?.op === 'string' && (o.op.startsWith('memory.') || o.op === 'arc.add'));
}

// Мутирует ЧЕРНОВИК памяти (patchMemory передаёт клон).
export function applyAssistantMemoryOps(memory: MemoryState, ops: any[], turn: number): MemoryOpsResult {
  const changes: AppliedChange[] = [];
  const jobs: MemoryOpsResult['jobs'] = [];
  for (const raw of ops) {
    const op = str(raw?.op);
    if (!op) continue;
    if (op === 'memory.add') {
      const title = str(raw.title)?.trim();
      const text = str(raw.text)?.trim();
      if (!title || !text) continue;
      const e: MemoryBookEntry = {
        id: uid('mem'),
        kind: MEM_KINDS.has(raw.kind) ? raw.kind : 'event',
        title,
        text,
        keys: strKeys(raw.keys) ?? [],
        mode: MEM_MODES.has(raw.mode) ? raw.mode : 'keyword',
        turn,
        source: 'assistant',
      };
      memory.memorybook.push(e);
      changes.push({
        label: `Меморибук: «${title}» (${e.mode === 'constant' ? 'постоянная' : e.mode === 'off' ? 'выкл' : `ключи: ${e.keys.join(', ') || '—'}`})`,
        revert: { kind: 'deleteMemory', id: e.id },
      });
      continue;
    }
    if (op === 'memory.update') {
      const id = str(raw.id);
      const idx = memory.memorybook.findIndex((e) => e.id === id);
      if (idx === -1) {
        logEvent('warn', 'prompt', `Ассистент правит несуществующую запись меморибука (${id}) — пропущено`);
        continue;
      }
      const prev: MemoryBookEntry = JSON.parse(JSON.stringify(memory.memorybook[idx]));
      const e = { ...prev };
      const touched: string[] = [];
      const title = str(raw.title)?.trim();
      if (title && title !== e.title) {
        e.title = title;
        touched.push('название');
      }
      const text = str(raw.text);
      if (text !== undefined && text.trim() && text !== e.text) {
        e.text = text;
        touched.push('текст');
      }
      const keys = strKeys(raw.keys);
      if (keys && keys.join('|') !== e.keys.join('|')) {
        e.keys = keys;
        touched.push('ключи');
      }
      if (MEM_MODES.has(raw.mode) && raw.mode !== e.mode) {
        e.mode = raw.mode;
        touched.push('режим');
      }
      if (MEM_KINDS.has(raw.kind) && raw.kind !== e.kind) {
        e.kind = raw.kind;
        touched.push('тип');
      }
      if (!touched.length) continue;
      memory.memorybook[idx] = e;
      changes.push({ label: `Меморибук «${e.title}»: обновлены ${touched.join(', ')}`, revert: { kind: 'restoreMemory', prev } });
      continue;
    }
    if (op === 'memory.delete') {
      const id = str(raw.id);
      const index = memory.memorybook.findIndex((e) => e.id === id);
      if (index === -1) continue;
      const prev = memory.memorybook[index];
      memory.memorybook = memory.memorybook.filter((e) => e.id !== id);
      changes.push({
        label: `Меморибук: удалена «${prev.title}»`,
        revert: { kind: 'restoreMemory', prev: JSON.parse(JSON.stringify(prev)), index },
      });
      continue;
    }
    if (op === 'memory.chapters') {
      const from = Math.round(Number(raw.fromTurn));
      const to = Math.round(Number(raw.toTurn));
      if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
      const jobId = uid('job');
      jobs.push({ scope: { kind: 'range', fromTurn: Math.min(from, to), toTurn: Math.max(from, to) }, jobId });
      changes.push({ label: `Запущена сборка глав по ходам ${Math.min(from, to)}–${Math.max(from, to)}`, revert: { kind: 'dropJob', jobId } });
      continue;
    }
    if (op === 'memory.fill') {
      const jobId = uid('job');
      jobs.push({ scope: { kind: 'fill' }, jobId });
      changes.push({ label: 'Запущено заполнение меморибука с нуля (главы для всей неописанной истории)', revert: { kind: 'dropJob', jobId } });
      continue;
    }
    if (op === 'arc.add') {
      const name = str(raw.name)?.trim();
      const now = str(raw.now)?.trim() || '';
      const change = str(raw.change)?.trim() || '';
      if (!name || (!now && !change)) continue;
      memory.arcs ||= [];
      let arc = memory.arcs.find((a) => a.name.toLowerCase() === name.toLowerCase());
      if (!arc) {
        arc = { name, stages: [] };
        memory.arcs.push(arc);
      }
      const stage: ArcStage = {
        id: uid('arc'),
        turn,
        label: str(raw.label)?.trim() || '—',
        change,
        cause: str(raw.cause)?.trim() || '',
        now,
        source: 'assistant',
      };
      arc.stages.push(stage);
      arc.stages.sort((a, b) => a.turn - b.turn);
      changes.push({ label: `Эволюция «${arc.name}»: этап «${stage.label}»`, revert: { kind: 'deleteArcStage', name: arc.name, id: stage.id } });
      continue;
    }
  }
  return { changes, jobs };
}

/** Откат правок памяти (в обратном порядке). Проектные правки пропускает. */
export function revertMemoryChanges(memory: MemoryState, changes: AppliedChange[]): void {
  for (const ch of [...changes].reverse()) {
    const r = ch.revert;
    switch (r.kind) {
      case 'deleteMemory':
        memory.memorybook = memory.memorybook.filter((e) => e.id !== r.id);
        break;
      case 'restoreMemory': {
        const i = memory.memorybook.findIndex((e) => e.id === r.prev.id);
        if (i >= 0) memory.memorybook[i] = r.prev;
        // Удалённая запись возвращается на своё место, а не в конец списка.
        else memory.memorybook.splice(Math.min(r.index ?? memory.memorybook.length, memory.memorybook.length), 0, r.prev);
        break;
      }
      case 'deleteArcStage':
        memory.arcs = (memory.arcs || []).map((a) =>
          a.name === r.name ? { ...a, stages: a.stages.filter((x) => x.id !== r.id) } : a
        );
        break;
      case 'dropJob': {
        const gone = new Set(memory.memorybook.filter((e) => e.jobId === r.jobId).map((e) => e.id));
        memory.memorybook = memory.memorybook.filter((e) => !gone.has(e.id));
        memory.arcs = (memory.arcs || []).map((a) => ({
          ...a,
          stages: a.stages.filter((x) => !x.chapterId || !gone.has(x.chapterId)),
        }));
        break;
      }
    }
  }
}

/** Правки из списка, которые касаются памяти прохождения. */
export function isMemoryChange(ch: AppliedChange): boolean {
  return ['deleteMemory', 'restoreMemory', 'deleteArcStage', 'dropJob'].includes(ch.revert.kind);
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
