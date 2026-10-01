import type { LlmMessage, MemoryState, RuntimeState } from '../shared/types';
import { uid } from '../shared/utils';

// ВЕТКА ОТ СООБЩЕНИЯ И ОТКАТ ХВОСТА.
//
// Раньше удаление сообщений стирало только текст из ленты. Всё остальное —
// часы и локация, досье Game Master, статы, телефон, главы о вырезанных ходах,
// этапы эволюции — оставалось «из будущего». Модель видела ленту, обрывающуюся
// на старом сообщении, и мир, ушедший дальше, и вела себя так, будто сообщения
// просто не видны, а не будто их не было.
//
// Теперь состояние собирается заново: мир — из снимка, снятого, когда это
// сообщение было последним (см. turnLedger), а память — из живой, с вырезанными
// записями о том, что после него. Снимка нет (ход сыгран до появления снимков) —
// мир остаётся текущим, но всё, что несёт отметку хода, подчищается.

// Поля мира, которые принадлежат ходу и берутся из снимка целиком.
const WORLD_KEYS = [
  'statValues',
  'relationship',
  'currentBackgroundId',
  'currentMusicMood',
  'currentMusicAssetId',
  'onScreen',
  'gm',
  'lastTurn',
  'turnCount',
  'lastChoiceTurn',
  'turnsSinceLastEvent',
  'turnsSinceLastSms',
  'phone',
  'inventory',
  'stateBlockLog',
] as const satisfies readonly (keyof RuntimeState)[];

/** Снимок для журнала: мир без ленты и без тяжёлой памяти (её режем по живой). */
export function compactState(state: RuntimeState): RuntimeState {
  const m = state.memory;
  return JSON.parse(
    JSON.stringify({
      ...state,
      history: [],
      memory: { ...m, rawArchive: [], memorybook: [], chronicle: [], arcs: [], storyState: undefined },
    })
  );
}

/** Каждому сообщению — стабильный id. Возвращает тот же объект, если менять нечего. */
export function withMessageIds(state: RuntimeState): RuntimeState {
  if (state.history.every((m) => m.id)) return state;
  return { ...state, history: state.history.map((m) => (m.id ? m : { ...m, id: uid('msg') })) };
}

/** Номер хода, на котором сообщение anchor было последним. */
export function turnAtMessage(state: RuntimeState, anchor: number): number {
  const later = state.history.slice(anchor + 1).filter((m) => m.role === 'user').length;
  return Math.max(0, state.turnCount - later);
}

export interface BranchResult {
  state: RuntimeState;
  /** exact — мир из снимка этого сообщения; earlier — из снимка более раннего; none — снимка нет. */
  precision: 'exact' | 'earlier' | 'none';
  cutTurn: number;
  droppedChapters: number;
}

/** Память ветки: живая, без записей о том, что случилось после среза. */
function trimMemory(live: MemoryState, cutAbs: number, cutTurn: number): { memory: MemoryState; dropped: number } {
  const droppedIds = new Set<string>();
  const memorybook = live.memorybook.filter((e) => {
    let keep: boolean;
    if (e.kind === 'chapter') {
      keep = typeof e.toMsg === 'number' ? e.toMsg <= cutAbs : (e.toTurn ?? e.turn) <= cutTurn;
    } else {
      // Свои записи игрока и ассистента — лор, а не события: остаются.
      keep = e.source !== 'auto' || e.turn <= cutTurn;
    }
    if (!keep) droppedIds.add(e.id);
    return keep;
  });
  const liveArcs = live.arcs || [];
  // Лента, опустевшая из-за среза, уходит; изначально пустая (завели руками) — остаётся.
  const arcs = liveArcs
    .map((a) => ({
      ...a,
      stages: a.stages.filter(
        (st) => !(st.chapterId && droppedIds.has(st.chapterId)) && !(st.source === 'auto' && st.turn > cutTurn)
      ),
    }))
    .filter((a, i) => a.stages.length > 0 || liveArcs[i].stages.length === 0);
  return {
    memory: {
      ...live,
      memorybook,
      arcs,
      facts: live.facts.filter((f) => f.turn <= cutTurn),
      storyStateAtTurn:
        typeof live.storyStateAtTurn === 'number' ? Math.min(live.storyStateAtTurn, cutTurn) : live.storyStateAtTurn,
    },
    dropped: [...droppedIds].filter((id) => live.memorybook.find((e) => e.id === id)?.kind === 'chapter').length,
  };
}

/**
 * Состояние, в котором сообщение `anchor` (индекс в живой ленте) — последнее.
 * snap — снимок мира на момент этого (exact) или более раннего (earlier) сообщения.
 */
export function branchState(
  live: RuntimeState,
  anchor: number,
  snap: { state: RuntimeState; precision: 'exact' | 'earlier' } | null
): BranchResult {
  const history: LlmMessage[] = live.history.slice(0, anchor + 1);
  // Свёрнутые сообщения лежат до живой ленты, поэтому срез всегда после них.
  const cutAbs = live.memory.foldedMsgCount + history.length;
  // Номер хода у сообщения — по снимку, если он именно этого сообщения; иначе
  // считаем по ленте (у более раннего снимка он меньше настоящего).
  const cutTurn = snap?.precision === 'exact' ? snap.state.turnCount : turnAtMessage(live, anchor);
  const { memory, dropped } = trimMemory(live.memory, cutAbs, cutTurn);
  memory.messagesSinceSummary = Math.min(live.memory.messagesSinceSummary, history.length);
  if (snap) {
    // Каноничные факты — часть хода: берём из снимка, но не позже среза.
    memory.facts = (snap.state.memory.facts || []).filter((f) => f.turn <= cutTurn);
  }

  let next: RuntimeState = { ...live, history, memory };
  if (snap) {
    const world: Partial<RuntimeState> = {};
    for (const k of WORLD_KEYS) (world as any)[k] = JSON.parse(JSON.stringify((snap.state as any)[k] ?? null));
    next = { ...next, ...world, turnCount: cutTurn };
  } else {
    // Снимка нет: мир текущий, но всё с отметкой хода подчищаем.
    const gm = live.gm;
    next = {
      ...next,
      turnCount: cutTurn,
      lastTurn: null,
      onScreen: live.onScreen.filter((o) => (o.atTurn ?? 0) <= cutTurn),
      stateBlockLog: (live.stateBlockLog || []).filter((x) => x.turn <= cutTurn),
      gm: { ...gm, events: gm.events.filter((e) => e.turn <= cutTurn) },
      phone: live.phone
        ? {
            ...live.phone,
            chats: live.phone.chats.map((c) => ({
              ...c,
              messages: c.messages.filter((m) => typeof m.turn !== 'number' || m.turn <= cutTurn),
            })),
          }
        : live.phone,
    };
  }
  return { state: next, precision: snap ? snap.precision : 'none', cutTurn, droppedChapters: dropped };
}
