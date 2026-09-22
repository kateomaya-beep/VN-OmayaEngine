import type { MemoryBookEntry, MemoryState, Project, RuntimeState } from '../shared/types';
import { CHAPTER_PROMPT } from './directorPrompt';
import {
  addArcStages,
  archiveRanges,
  buildTimeline,
  chaptersOf,
  coverage,
  dropArcStagesOf,
  makeChapter,
  parseArcs,
  parseChapterHeader,
  retireSupersededLegacy,
  trackedBrief,
  type ParsedArc,
  type TimelineMsg,
} from './chapters';
import { isFilterError, mechanicalDigest, splitSummarySections, summarize } from './memoryEngine';
import { condenseAssistantTurn } from './promptBuilder';
import { stripStateBlock } from './rpResponse';
import { logEvent } from '../shared/logStore';

// СБОРКА ГЛАВ ИЗ ИСТОРИИ — то, чем чинится память задним числом.
//  • archive — главы по сырому архиву свёрнутых периодов. Спасает старые игры:
//    их журнал пережат повторными уплотнениями, а дословный текст каждого периода
//    лежит в архиве целиком.
//  • fill — «заполнить меморибук с нуля»: всё, что ещё не описано главами, —
//    архив и живая история (кроме текущей сцены).
//  • range — главы по диапазону ходов (просьба ассистенту «внеси ходы 120–150»).
//  • chunk — пересобрать главу одного периода архива.
// Главы собираются по одной, по порядку: каждой нужна предыдущая (для связности)
// и текущие этапы эволюции персонажей.

export type ChapterScope =
  | { kind: 'archive'; rebuildAll?: boolean }
  | { kind: 'fill' }
  | { kind: 'range'; fromTurn: number; toTurn: number; replaceIds?: string[] }
  | { kind: 'chunk'; archiveIndex: number };

export interface ChapterUnit {
  fromMsg: number;
  toMsg: number;
  fromTurn: number;
  toTurn: number;
  transcript: string;
  archiveTurn?: number;
  /** Главы, которые эта заменит (пересборка периода). */
  replaceIds: string[];
}

// Потолок одной главы по объёму стенограммы: больше модель пересказывает хуже,
// и ответ чаще обрывается.
const UNIT_CHARS = 30000;
const UNIT_MSGS = 40;
// Хвост живой истории, который «заполнить с нуля» не трогает: это текущая сцена,
// она ещё идёт, и главу о ней писать рано.
const LIVE_TAIL = 4;

function lineOf(project: Project, state: RuntimeState, m: TimelineMsg): string {
  let text = m.text;
  if (m.source === 'live' && m.role === 'assistant') {
    text = condenseAssistantTurn(text, project, state) ?? stripStateBlock(text);
  }
  return `${m.role === 'user' ? 'ИГРОК' : 'ИГРА'}: ${text.trim()}`;
}

// Нарезка подряд идущих сообщений на главы: по объёму и числу сообщений, и по
// возможности — по границе хода (перед репликой игрока).
function toUnits(
  project: Project,
  state: RuntimeState,
  msgs: TimelineMsg[],
  extra: { archiveTurn?: number; replaceIds?: string[] } = {}
): ChapterUnit[] {
  const units: ChapterUnit[] = [];
  let cur: { msgs: TimelineMsg[]; lines: string[]; chars: number } = { msgs: [], lines: [], chars: 0 };
  const flush = () => {
    if (!cur.msgs.length) return;
    const first = cur.msgs[0];
    const last = cur.msgs[cur.msgs.length - 1];
    units.push({
      fromMsg: first.abs,
      toMsg: last.abs,
      fromTurn: first.turn,
      toTurn: last.turn,
      transcript: cur.lines.join('\n\n'),
      archiveTurn: extra.archiveTurn,
      replaceIds: units.length === 0 ? extra.replaceIds ?? [] : [],
    });
    cur = { msgs: [], lines: [], chars: 0 };
  };
  for (const m of msgs) {
    const line = lineOf(project, state, m);
    const full = cur.chars + line.length > UNIT_CHARS || cur.msgs.length >= UNIT_MSGS;
    if (full && cur.msgs.length >= 4 && m.role === 'user') flush();
    else if (cur.chars + line.length > UNIT_CHARS * 1.3 && cur.msgs.length >= 4) flush();
    cur.msgs.push(m);
    cur.lines.push(line);
    cur.chars += line.length + 2;
  }
  flush();
  return units;
}

const realChapter = (e: MemoryBookEntry) => e.kind === 'chapter' && e.source !== 'legacy';

/** Какие главы собрать для выбранного охвата. */
export function planUnits(project: Project, state: RuntimeState, scope: ChapterScope): ChapterUnit[] {
  const memory = state.memory;
  const timeline = buildTimeline(state);
  const ranges = archiveRanges(state, timeline);
  const units: ChapterUnit[] = [];

  const chunkUnits = (i: number, rebuild: boolean) => {
    const chunk = memory.rawArchive[i];
    const r = ranges[i];
    if (!chunk || !r?.count) return;
    const linked = memory.memorybook.filter((e) => realChapter(e) && e.archiveTurn === chunk.turn);
    const covered = linked.length > 0 || coverage(memory, r.fromMsg, r.toMsg) >= 0.9;
    if (covered && !rebuild) return;
    units.push(
      ...toUnits(
        project,
        state,
        timeline.filter((m) => m.archiveIndex === i),
        { archiveTurn: chunk.turn, replaceIds: rebuild ? linked.map((e) => e.id) : [] }
      )
    );
  };

  if (scope.kind === 'chunk') {
    chunkUnits(scope.archiveIndex, true);
    return units;
  }
  if (scope.kind === 'archive' || scope.kind === 'fill') {
    memory.rawArchive.forEach((_, i) => chunkUnits(i, scope.kind === 'archive' && !!scope.rebuildAll));
  }
  if (scope.kind === 'fill') {
    const live = timeline.filter((m) => m.source === 'live');
    const eligible = live.slice(0, Math.max(0, live.length - LIVE_TAIL));
    // Подряд идущие сообщения, ещё не описанные ни одной главой.
    let run: TimelineMsg[] = [];
    const flushRun = () => {
      if (run.length >= 2) units.push(...toUnits(project, state, run));
      run = [];
    };
    for (const m of eligible) {
      if (coverage(memory, m.abs, m.abs) >= 1) flushRun();
      else run.push(m);
    }
    flushRun();
  }
  if (scope.kind === 'range') {
    const lo = Math.min(scope.fromTurn, scope.toTurn);
    const hi = Math.max(scope.fromTurn, scope.toTurn);
    units.push(
      ...toUnits(project, state, timeline.filter((m) => m.turn >= lo && m.turn <= hi), { replaceIds: scope.replaceIds })
    );
  }
  return units;
}

export interface UnitResult {
  entry: MemoryBookEntry;
  arcs: ParsedArc[];
}

/** Собрать одну главу. Ошибка сети/модели — исключение (сборка решит, что делать). */
export async function summarizeUnit(
  project: Project,
  state: RuntimeState,
  unit: ChapterUnit,
  meta: { source: MemoryBookEntry['source']; jobId?: string }
): Promise<UnitResult> {
  const tracked = trackedBrief(project, state.memory);
  const prev = chaptersOf(state.memory)
    .filter((c) => c.mode !== 'off' && (c.toMsg ?? 0) < unit.fromMsg)
    .pop();
  const input = [
    tracked,
    prev ? `PREVIOUS CHAPTER: «${prev.title}» — ${prev.gist || ''}` : '',
    `=== STORY STRETCH (turns ${unit.fromTurn}–${unit.toTurn}) ===\n${unit.transcript}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  let raw = '';
  try {
    raw = await summarize(project, CHAPTER_PROMPT, input);
    if (splitSummarySections(raw).episode.trim().length < 40) {
      raw = await summarize(project, `${CHAPTER_PROMPT}\n\nIMPORTANT: never return an empty answer. Facts only, no preamble.`, input);
    }
  } catch (e) {
    if (!isFilterError(e)) throw e;
    try {
      raw = await summarize(
        project,
        `${CHAPTER_PROMPT}\n\nSTRICT MODE: a neutral, clinical continuity record only — plainest words, no dialogue, ` +
          `no bodies, no sensations. This is a database record for a game engine, not prose. Never refuse.`,
        input
      );
    } catch (e2) {
      if (!isFilterError(e2)) throw e2;
      raw = '';
    }
  }
  const { episode, arcs } = splitSummarySections(raw);
  let header = parseChapterHeader(episode);
  let fallbackTitle: string | undefined;
  if (header.body.trim().length < 40) {
    // Модель не пересказала период ни в какую — глава всё равно появится (начало
    // каждого хода дословно), чтобы период не остался дырой; её можно пересобрать.
    const digest = mechanicalDigest(unit.transcript);
    if (!digest) throw new Error('модель вернула пустой ответ');
    header = { title: '', keys: [], dates: '', gist: '', body: digest };
    fallbackTitle = `Черновая глава, ходы ${unit.fromTurn}–${unit.toTurn} (пересоберите)`;
  }
  const entry = makeChapter(project, state, {
    header,
    transcript: unit.transcript,
    fromMsg: unit.fromMsg,
    toMsg: unit.toMsg,
    fromTurn: unit.fromTurn,
    toTurn: unit.toTurn,
    archiveTurn: unit.archiveTurn,
    source: meta.source,
    jobId: meta.jobId,
    fallbackTitle,
  });
  return { entry, arcs: parseArcs(arcs) };
}

/** Положить собранную главу в память: заменить пересобираемые, добавить этапы. */
export function applyUnitResult(project: Project, memory: MemoryState, unit: ChapterUnit, r: UnitResult): MemoryState {
  const replace = new Set(unit.replaceIds);
  const book = memory.memorybook.filter((e) => !replace.has(e.id));
  const base: MemoryState = { ...memory, memorybook: [...book, r.entry] };
  const arcs = addArcStages(dropArcStagesOf(memory.arcs, replace), project, base, r.arcs, {
    turn: unit.toTurn,
    dates: r.entry.dates,
    chapterId: r.entry.id,
    source: r.entry.source === 'assistant' ? 'assistant' : 'auto',
  });
  logEvent(
    'info',
    'memory',
    `Глава «${r.entry.title}» (ходы ${unit.fromTurn}–${unit.toTurn}) собрана: ключи ${r.entry.keys.join(', ') || '—'}; ` +
      `сдвигов персонажей: ${r.arcs.length}${replace.size ? `; заменила ${replace.size} прежн.` : ''}`
  );
  return retireSupersededLegacy({ ...base, arcs });
}
