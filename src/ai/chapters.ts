import type {
  ArcStage,
  CharacterArc,
  LlmMessage,
  MemoryBookEntry,
  MemoryState,
  Project,
  RawArchiveChunk,
  RuntimeState,
} from '../shared/types';
import { estimateTokens, uid } from '../shared/utils';
import { normName } from './characterRegistry';

// ГЛАВЫ И МЕМОРИБУК — чистая логика без запросов к модели: сопоставление ключей,
// нумерация сообщений по всей истории, покрытие главами, разбор ответа
// саммарайзера, эволюция персонажей. Запросы живут в memoryEngine/chapterJobs.

// ---- Ключевые слова ---------------------------------------------------------

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const CYR = /\p{Script=Cyrillic}/u;
const RU_VOWEL_END = /[аяоеёиыуюйьэ]$/u;

// Шаблон одного слова ключа. Русский склоняется, и ключ «Микаса» раньше не
// находил «Микасу» и «Микасой» — запись молчала ровно тогда, когда о человеке
// говорили. Поэтому у русских слов длиной от пяти букв отрезаем гласную на конце
// и разрешаем до трёх букв окончания. Короткие на согласную (Эрен, дом) получают
// окончание с гласной (Эрена, дома). Короткие на гласную (Леви, Анна) — точно:
// иначе «Леви» ловил бы «левый».
function wordPattern(w: string): string {
  const lw = w.toLowerCase();
  if (CYR.test(lw)) {
    if (lw.length >= 5) {
      const stem = RU_VOWEL_END.test(lw) ? lw.slice(0, -1) : lw;
      return escapeRegex(stem) + '\\p{L}{0,3}';
    }
    if (lw.length >= 3 && !RU_VOWEL_END.test(lw)) return escapeRegex(lw) + '(?:[аеуоыи]\\p{L}{0,2})?';
    return escapeRegex(lw);
  }
  if (lw.length >= 4 && /^[a-z]+$/.test(lw)) return escapeRegex(lw) + '(?:s|es)?';
  return escapeRegex(lw);
}

const keyCache = new Map<string, RegExp | null>();
function keyRegex(key: string): RegExp | null {
  const k = key.trim().toLowerCase();
  if (keyCache.has(k)) return keyCache.get(k)!;
  const words = k.match(/[\p{L}\p{N}]+/gu) || [];
  const re = words.length
    ? new RegExp(`(^|[^\\p{L}\\p{N}])${words.map(wordPattern).join('[^\\p{L}\\p{N}]+')}(?=[^\\p{L}\\p{N}]|$)`, 'u')
    : null;
  if (keyCache.size > 2000) keyCache.clear();
  keyCache.set(k, re);
  return re;
}

/** Встречается ли ключ в тексте (с учётом русских окончаний). */
export function memoryKeyHit(key: string, text: string): boolean {
  const re = keyRegex(key);
  return !!re && re.test(text.toLowerCase());
}

// ---- Главы -----------------------------------------------------------------

/** Главы в хронологическом порядке. */
export function chaptersOf(memory: MemoryState): MemoryBookEntry[] {
  return memory.memorybook
    .filter((e) => e.kind === 'chapter')
    .slice()
    .sort((a, b) => (a.toMsg ?? a.turn * 2) - (b.toMsg ?? b.turn * 2) || a.turn - b.turn);
}

/** Номер главы для людей: порядковый среди действующих глав, 1-based (0 — выключена). */
export function chapterNumber(memory: MemoryState, id: string): number {
  return chaptersOf(memory).filter((c) => c.mode !== 'off').findIndex((c) => c.id === id) + 1;
}

/** Глава описывает ещё НЕ свёрнутые сообщения (их модель видит дословно). */
export function isLiveChapter(e: MemoryBookEntry, memory: MemoryState): boolean {
  return e.kind === 'chapter' && typeof e.fromMsg === 'number' && e.fromMsg > memory.foldedMsgCount;
}

/**
 * Какая доля сообщений [from..to] уже описана главами. Считаются только
 * настоящие главы: legacy-записи — пережатые остатки старого журнала, и
 * «покрытым» по ним период считать нельзя.
 */
export function coverage(memory: MemoryState, from: number, to: number): number {
  if (to < from) return 1;
  const ranges = memory.memorybook
    .filter((e) => e.kind === 'chapter' && e.source !== 'legacy' && e.mode !== 'off')
    .filter((e) => typeof e.fromMsg === 'number' && typeof e.toMsg === 'number')
    .map((e) => [Math.max(from, e.fromMsg!), Math.min(to, e.toMsg!)] as const)
    .filter(([a, b]) => b >= a)
    .sort((a, b) => a[0] - b[0]);
  let covered = 0;
  let cursor = from - 1;
  for (const [a, b] of ranges) {
    const start = Math.max(a, cursor + 1);
    if (b >= start) {
      covered += b - start + 1;
      cursor = b;
    }
  }
  return covered / (to - from + 1);
}

// ---- Нумерация всей истории -------------------------------------------------

/** Разбор архивного транскрипта («ИГРОК: …» / «ИГРА: …») в сообщения. */
export function parseTranscript(text: string): LlmMessage[] {
  const parts = (text || '').split(/\n\n(?=(?:ИГРОК|ИГРА|PLAYER|GAME):\s)/);
  const out: LlmMessage[] = [];
  for (const part of parts) {
    const m = /^(ИГРОК|ИГРА|PLAYER|GAME):\s([\s\S]*)$/.exec(part.trim());
    if (!m) continue;
    const content = m[2].trim();
    if (!content) continue;
    out.push({ role: m[1] === 'ИГРОК' || m[1] === 'PLAYER' ? 'user' : 'assistant', content });
  }
  return out;
}

export interface TimelineMsg {
  abs: number; // абсолютный номер сообщения, 1-based
  turn: number;
  role: LlmMessage['role'];
  text: string;
  source: 'archive' | 'live';
  archiveIndex?: number;
}

export interface ChunkRange {
  fromMsg: number;
  toMsg: number;
  fromTurn: number;
  toTurn: number;
  count: number;
}

/**
 * Вся доступная история сообщениями — архив + живая — с абсолютными номерами
 * сообщений и ходов.
 *
 * Номера считаются ОДНИМ проходом с конца: последнее сообщение живой истории
 * знает свой номер точно, каждое предыдущее — на единицу меньше, а ход
 * уменьшается на каждом ответе ИИ. Архив пишется подряд, поэтому при целом
 * архиве счёт точный, а если ранние периоды свернулись ещё до появления архива,
 * верными остаются как раз свежие куски. Новые куски архива несут свои номера
 * сами — на них счёт выравнивается (якорь), так что дыра посреди архива (период
 * вернули в историю) не сбивает всё, что старше.
 */
export function buildTimeline(state: RuntimeState): TimelineMsg[] {
  const memory = state.memory;
  type Seq = { role: LlmMessage['role']; text: string; source: 'archive' | 'live'; archiveIndex?: number; lastOfChunk?: boolean };
  const seq: Seq[] = [];
  memory.rawArchive.forEach((c, i) => {
    const msgs = parseTranscript(c.text);
    msgs.forEach((m, j) =>
      seq.push({ role: m.role, text: m.content, source: 'archive', archiveIndex: i, lastOfChunk: j === msgs.length - 1 })
    );
  });
  for (const m of state.history) seq.push({ role: m.role, text: String(m.content), source: 'live' });

  const out: TimelineMsg[] = new Array(seq.length);
  let abs = memory.foldedMsgCount + state.history.length + 1;
  let nextTurn = state.turnCount + 1;
  for (let i = seq.length - 1; i >= 0; i--) {
    const m = seq[i];
    abs -= 1;
    if (m.lastOfChunk && m.archiveIndex !== undefined) {
      const c = memory.rawArchive[m.archiveIndex];
      if (typeof c.toMsg === 'number') abs = c.toMsg;
      if (typeof c.toTurn === 'number' && c.toTurn > 0) nextTurn = m.role === 'assistant' ? c.toTurn + 1 : c.toTurn;
    }
    if (m.role === 'assistant') nextTurn -= 1;
    out[i] = {
      abs: Math.max(1, abs),
      turn: Math.max(0, nextTurn),
      role: m.role,
      text: m.text,
      source: m.source,
      archiveIndex: m.archiveIndex,
    };
  }
  return out;
}

/** Номер хода каждого сообщения живой истории (тем же счётом, что и buildTimeline). */
export function liveTurns(state: RuntimeState): number[] {
  const out: number[] = new Array(state.history.length);
  let nextTurn = state.turnCount + 1;
  for (let i = state.history.length - 1; i >= 0; i--) {
    if (state.history[i].role === 'assistant') nextTurn -= 1;
    out[i] = Math.max(0, nextTurn);
  }
  return out;
}

/** Диапазоны сообщений и ходов для каждого куска архива. */
export function archiveRanges(state: RuntimeState, timeline = buildTimeline(state)): ChunkRange[] {
  const out: ChunkRange[] = state.memory.rawArchive.map(() => ({ fromMsg: 0, toMsg: 0, fromTurn: 0, toTurn: 0, count: 0 }));
  for (const m of timeline) {
    if (m.archiveIndex === undefined) continue;
    const r = out[m.archiveIndex];
    if (!r.count) {
      r.fromMsg = m.abs;
      r.fromTurn = m.turn;
    }
    r.toMsg = m.abs;
    r.toTurn = m.turn;
    r.count += 1;
  }
  return out;
}

// ---- Разбор ответа саммарайзера -------------------------------------------

/** Режет ответ на секции === NAME ===. */
export function splitSections(raw: string): Record<string, string> {
  const text = (raw || '').trim();
  const out: Record<string, string> = {};
  const re = /===\s*([A-Za-z][A-Za-z ]+?)\s*===/g;
  const marks: { name: string; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) marks.push({ name: m[1].trim().toUpperCase(), start: m.index, end: m.index + m[0].length });
  marks.forEach((mk, i) => {
    const body = text.slice(mk.end, i + 1 < marks.length ? marks[i + 1].start : text.length).trim();
    out[mk.name] = body;
  });
  return out;
}

export interface ChapterHeader {
  title: string;
  keys: string[];
  dates: string;
  gist: string;
  body: string;
}

// Шапка главы — строки TITLE/KEYS/DATES/GIST в начале эпизода. Модель может
// обернуть их в markdown (**TITLE:**), поставить в другом порядке или забыть
// часть — берём, что есть, остальное движок достроит сам.
export function parseChapterHeader(episode: string): ChapterHeader {
  const lines = (episode || '').split('\n');
  const head: Record<string, string> = {};
  let i = 0;
  for (; i < lines.length; i++) {
    const l = lines[i].trim().replace(/^[*_#\s-]+/, '');
    if (!l) {
      if (Object.keys(head).length) continue;
      continue;
    }
    const m = /^(TITLE|KEYS|DATES|DATE|GIST)\s*[*_]*\s*:\s*[*_]*\s*(.*)$/i.exec(l);
    if (!m) break;
    head[m[1].toUpperCase().replace(/^DATE$/, 'DATES')] = m[2].replace(/[*_]+$/, '').trim();
  }
  const body = lines.slice(i).join('\n').trim();
  const clean = (s?: string) => (s || '').replace(/^["«']+|["»']+$/g, '').trim();
  const keys = clean(head.KEYS)
    .split(/[,;]/)
    .map((k) => clean(k))
    .filter((k) => k && k.length <= 40);
  const dates = clean(head.DATES);
  return {
    title: clean(head.TITLE).slice(0, 120),
    keys,
    dates: /^(n\/?a|none|unknown|—|-)$/i.test(dates) ? '' : dates,
    gist: clean(head.GIST).slice(0, 300),
    body,
  };
}

export interface ParsedArc {
  name: string;
  label: string;
  change: string;
  cause: string;
  now: string;
}

// Строки вида «- Имя | STAGE: … | CHANGE: … | CAUSE: … | NOW: …».
export function parseArcs(section: string): ParsedArc[] {
  const out: ParsedArc[] = [];
  for (const raw of (section || '').split('\n')) {
    const line = raw.trim().replace(/^[-*•\d.)\s]+/, '');
    if (!line || !line.includes('|')) continue;
    const parts = line.split('|').map((p) => p.trim());
    const name = parts[0].replace(/[*_]/g, '').trim();
    const field = (k: string) => {
      const p = parts.find((x) => new RegExp(`^[*_]*${k}[*_]*\\s*:`, 'i').test(x));
      return p ? p.replace(new RegExp(`^[*_]*${k}[*_]*\\s*:\\s*`, 'i'), '').replace(/[*_]+$/, '').trim() : '';
    };
    const arc = { name, label: field('STAGE'), change: field('CHANGE'), cause: field('CAUSE'), now: field('NOW') };
    if (!arc.name || /^none$/i.test(arc.name)) continue;
    if (!arc.change && !arc.now) continue;
    out.push(arc);
  }
  return out;
}

// ---- Ключи главы -----------------------------------------------------------

/** Имена и места, которые движок знает: из них собираются ключи главы. */
function knownNames(project: Project, state: RuntimeState): string[] {
  const hero = normName(state.protagonistName || '');
  const heroCard = project.characters.find((c) => c.role === 'protagonist')?.name;
  const skip = new Set([hero, normName(heroCard || '')].filter(Boolean));
  const names = new Set<string>();
  const add = (n?: string) => {
    const t = (n || '').trim();
    if (t.length >= 3 && t.length <= 40 && !skip.has(normName(t))) names.add(t);
  };
  for (const c of project.characters) add(c.name);
  for (const c of state.gm.characters) add(c.name);
  for (const r of state.gm.registry || []) {
    add(r.canonicalName);
    for (const a of r.aliases) add(a);
  }
  for (const l of state.gm.locations) add(l.name);
  for (const e of project.lorebook) add(e.title);
  return [...names];
}

/**
 * Ключи главы. Ключи модели оставляем, только если они реально есть в тексте
 * периода: английская транслитерация («Levi») в русской игре не сработала бы
 * никогда. К ним добавляем имена и места, которые движок знает и которые в
 * периоде встретились, — это и есть самые надёжные ключи. Героя не берём: он в
 * каждой сцене, и его имя будило бы все главы сразу.
 */
export function chapterKeys(project: Project, state: RuntimeState, transcript: string, modelKeys: string[]): string[] {
  const hero = normName(state.protagonistName || '');
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (k: string) => {
    const n = normName(k);
    if (!n || seen.has(n) || n === hero) return;
    seen.add(n);
    out.push(k.trim());
  };
  for (const k of modelKeys) if (memoryKeyHit(k, transcript)) push(k);
  for (const n of knownNames(project, state)) if (memoryKeyHit(n, transcript)) push(n);
  return out.slice(0, 14);
}

/** Собрать главу из разобранного ответа саммарайзера. */
export function makeChapter(
  project: Project,
  state: RuntimeState,
  p: {
    header: ChapterHeader;
    transcript: string;
    fromMsg?: number;
    toMsg?: number;
    fromTurn?: number;
    toTurn?: number;
    archiveTurn?: number;
    source: MemoryBookEntry['source'];
    jobId?: string;
    fallbackTitle?: string;
  }
): MemoryBookEntry {
  const body = p.header.body.trim();
  const firstPoint =
    body
      .split('\n')
      .map((l) => l.replace(/^[\s\d.)\-*•]+/, '').trim())
      .find(Boolean) || '';
  const n = chaptersOf(state.memory).filter((c) => c.source !== 'legacy').length + 1;
  return {
    id: uid('mem'),
    kind: 'chapter',
    title: p.header.title || p.fallbackTitle || `Глава ${n}`,
    text: body,
    keys: chapterKeys(project, state, p.transcript, p.header.keys),
    mode: 'keyword',
    gist: p.header.gist || firstPoint.slice(0, 200),
    turn: p.toTurn ?? state.turnCount,
    fromTurn: p.fromTurn,
    toTurn: p.toTurn,
    fromMsg: p.fromMsg,
    toMsg: p.toMsg,
    dates: p.header.dates || undefined,
    archiveTurn: p.archiveTurn,
    source: p.source,
    jobId: p.jobId,
  };
}

// ---- Эволюция персонажей ---------------------------------------------------

/** Кого отслеживаем: любовные интересы, важные персонажи и все, у кого лента уже есть. */
export function trackedCharacters(project: Project, memory: MemoryState): { name: string; charId?: string; sheet?: string }[] {
  const out: { name: string; charId?: string; sheet?: string }[] = [];
  const seen = new Set<string>();
  for (const c of project.characters) {
    if (c.role !== 'love_interest' && c.role !== 'important_character') continue;
    seen.add(normName(c.name));
    out.push({ name: c.name, charId: c.id, sheet: c.card.personality });
  }
  for (const a of memory.arcs || []) {
    if (seen.has(normName(a.name))) continue;
    seen.add(normName(a.name));
    out.push({ name: a.name, charId: a.charId });
  }
  return out;
}

/** Строка для саммарайзера: кого отслеживать и на каком этапе каждый сейчас. */
export function trackedBrief(project: Project, memory: MemoryState): string {
  const list = trackedCharacters(project, memory);
  if (!list.length) return '';
  const lines = list.map((t) => {
    const arc = (memory.arcs || []).find((a) => (t.charId && a.charId === t.charId) || normName(a.name) === normName(t.name));
    const last = arc?.stages[arc.stages.length - 1];
    const sheet = t.sheet ? ` | sheet: ${t.sheet.replace(/\s+/g, ' ').slice(0, 160)}` : '';
    return `- ${t.name}${sheet} | current stage: ${last ? `${last.label} — ${last.now}` : 'none yet (as in the sheet)'}`;
  });
  return `TRACKED CHARACTERS (report their evolution in === CHARACTER ARCS ===):\n${lines.join('\n')}`;
}

/** Найти ленту персонажа по имени (с учётом ростера проекта). */
function findArc(arcs: CharacterArc[], project: Project, name: string): { arc?: CharacterArc; charId?: string; canonical: string } {
  const n = normName(name);
  const card = project.characters.find((c) => normName(c.name) === n || normName(c.name).split(' ')[0] === n);
  const canonical = card?.name || name.trim();
  const arc = arcs.find(
    (a) => (card && a.charId === card.id) || normName(a.name) === normName(canonical) || normName(a.name) === n
  );
  return { arc, charId: card?.id, canonical };
}

/**
 * Добавить этапы в ленты. Берём только отслеживаемых — модель иногда пишет арку
 * проходному персонажу, и лента разрасталась бы на всех подряд.
 */
export function addArcStages(
  arcs: CharacterArc[] | undefined,
  project: Project,
  memory: MemoryState,
  parsed: ParsedArc[],
  meta: { turn: number; dates?: string; chapterId?: string; source: ArcStage['source'] }
): CharacterArc[] {
  const next: CharacterArc[] = (arcs || []).map((a) => ({ ...a, stages: [...a.stages] }));
  const tracked = trackedCharacters(project, memory).map((t) => normName(t.name));
  for (const p of parsed) {
    const { arc, charId, canonical } = findArc(next, project, p.name);
    if (!arc && !tracked.includes(normName(canonical))) continue;
    const stage: ArcStage = {
      id: uid('arc'),
      turn: meta.turn,
      dates: meta.dates || undefined,
      label: p.label.slice(0, 80) || '—',
      change: p.change,
      cause: p.cause,
      now: p.now,
      chapterId: meta.chapterId,
      source: meta.source,
    };
    const target = arc || { name: canonical, charId, stages: [] };
    if (!arc) next.push(target);
    target.stages.push(stage);
    target.stages.sort((a, b) => a.turn - b.turn);
  }
  return next;
}

/** Убрать этапы, пришедшие из указанных глав (глава пересобрана или удалена). */
export function dropArcStagesOf(arcs: CharacterArc[] | undefined, chapterIds: Set<string>): CharacterArc[] {
  return (arcs || []).map((a) => ({ ...a, stages: a.stages.filter((s) => !s.chapterId || !chapterIds.has(s.chapterId)) }));
}

// ---- Выбор записей меморибука под бюджет ------------------------------------

export interface MemorybookPick {
  constant: MemoryBookEntry[];
  triggered: { entry: MemoryBookEntry; keys: string[] }[];
  /** Сработали, но не влезли в бюджет. */
  skipped: MemoryBookEntry[];
  tokens: number;
}

export function entryTokens(e: MemoryBookEntry): number {
  return estimateTokens(e.title) + estimateTokens(e.text) + 12;
}

/**
 * Какие записи меморибука уходят в этот ход. Постоянные — всегда. По ключам —
 * по «весу» совпадения: редкий ключ (подвал, где нашли письмо) весит больше
 * частого (имя главной героини, которое есть в каждой главе), иначе одна частая
 * фамилия будила бы все главы разом. Не влезли в бюджет — остаются в оглавлении.
 */
export function pickMemorybook(
  memory: MemoryState,
  scanText: string,
  budgetTokens: number,
  exclude: Set<string>
): MemorybookPick {
  const eligible = memory.memorybook.filter(
    (e) => e.mode !== 'off' && !exclude.has(e.id) && !isLiveChapter(e, memory) && e.text.trim()
  );
  const constant = eligible.filter((e) => e.mode === 'constant');
  const keyed = eligible.filter((e) => e.mode === 'keyword' && e.keys.length);

  // Частота ключа по всем записям (IDF).
  const df = new Map<string, number>();
  for (const e of keyed) for (const k of new Set(e.keys.map((x) => normName(x)))) df.set(k, (df.get(k) || 0) + 1);
  const N = Math.max(1, keyed.length);

  const scored = keyed
    .map((e) => {
      const hits = e.keys.filter((k) => memoryKeyHit(k, scanText));
      const score = hits.reduce((s, k) => s + Math.log(1 + N / (df.get(normName(k)) || 1)), 0);
      return { entry: e, keys: hits, score };
    })
    .filter((x) => x.keys.length)
    .sort((a, b) => b.score - a.score || b.entry.turn - a.entry.turn);

  let tokens = constant.reduce((n, e) => n + entryTokens(e), 0);
  const triggered: MemorybookPick['triggered'] = [];
  const skipped: MemoryBookEntry[] = [];
  for (const s of scored) {
    const t = entryTokens(s.entry);
    if (tokens + t <= budgetTokens || (!triggered.length && tokens < budgetTokens)) {
      triggered.push({ entry: s.entry, keys: s.keys });
      tokens += t;
    } else skipped.push(s.entry);
  }
  // В запросе — в хронологическом порядке: так модели проще сложить картину.
  triggered.sort((a, b) => (a.entry.toMsg ?? a.entry.turn * 2) - (b.entry.toMsg ?? b.entry.turn * 2));
  return { constant, triggered, skipped, tokens };
}

// ---- Миграция старого журнала ----------------------------------------------

/**
 * Старый журнал эпизодов → главы меморибука (source: 'legacy'). Текст не
 * меняется ни на символ — меняется только место хранения. Повторный вызов
 * ничего не дублирует: после переноса журнал пуст.
 */
export function migrateChronicle(memory: MemoryState): MemoryState {
  if (!memory.chronicle.length) return memory;
  const moved: MemoryBookEntry[] = memory.chronicle.map((c, i) => {
    const firstLine = c.text.split('\n').map((l) => l.replace(/^[\s\d.)\-*•]+/, '').trim()).find(Boolean) || '';
    return {
      id: c.id || uid('mem'),
      kind: 'chapter',
      title: `Период ${i + 1}`,
      text: c.text,
      keys: [],
      mode: 'keyword',
      gist: firstLine.slice(0, 200),
      turn: c.atTurn || 0,
      toTurn: c.atTurn || undefined,
      fromMsg: c.fromMsg || undefined,
      toMsg: c.toMsg || undefined,
      archiveTurn: c.atTurn || undefined,
      source: 'legacy',
    };
  });
  return { ...memory, chronicle: [], memorybook: [...moved, ...memory.memorybook] };
}

/**
 * Старые записи, которые новые главы уже покрыли целиком, выключаются: их текст
 * — пережатая копия того же периода. Удалять не удаляем — вдруг там ручные
 * правки; запись остаётся видна в меморибуке с пометкой.
 */
export function retireSupersededLegacy(memory: MemoryState): MemoryState {
  let changed = false;
  const book = memory.memorybook.map((e) => {
    if (e.kind !== 'chapter' || e.source !== 'legacy' || e.mode === 'off') return e;
    let superseded = false;
    if (typeof e.fromMsg === 'number' && typeof e.toMsg === 'number') {
      superseded = coverage(memory, e.fromMsg, e.toMsg) >= 0.9;
    } else if (e.archiveTurn) {
      superseded = memory.memorybook.some(
        (x) => x.kind === 'chapter' && x.source !== 'legacy' && x.archiveTurn === e.archiveTurn
      );
    }
    if (!superseded) return e;
    changed = true;
    return { ...e, mode: 'off' as const, title: e.title.startsWith('(заменено)') ? e.title : `(заменено) ${e.title}` };
  });
  return changed ? { ...memory, memorybook: book } : memory;
}
