import type { Project, RuntimeState, AiTurn, CanonicalFact } from '../shared/types';
import { buildRequest } from './promptBuilder';
import { runCompletion } from './providers';
import { parseAiResponse, applyStatChanges } from './responseParser';
import { maybeCompress, closeChapter } from './memoryEngine';

export interface TurnResult {
  turn: AiTurn;
  state: RuntimeState;
}

const RETRY_HINT =
  '\n\nОтвет не прошёл валидацию. Верни СТРОГО один JSON-объект по схеме, без markdown и текста вне JSON.';

// Run one player turn: build context -> call LLM -> parse/repair -> apply to state.
export async function runTurn(
  project: Project,
  state: RuntimeState,
  playerMove: string
): Promise<TurnResult> {
  const req = buildRequest(project, state, playerMove);

  let raw = await runCompletion(project.aiConfig, {
    system: req.system,
    messages: req.messages,
    model: project.aiConfig.model,
    temperature: project.aiConfig.temperature,
  });

  let parsed = parseAiResponse(raw, project, state.currentBackgroundId, state.currentMusicId);

  // One automatic retry on invalid JSON (see ТЗ §7).
  if (!parsed.ok) {
    raw = await runCompletion(project.aiConfig, {
      system: req.system,
      messages: [...req.messages, { role: 'user', content: RETRY_HINT }],
      model: project.aiConfig.model,
      temperature: Math.min(project.aiConfig.temperature, 0.5),
    });
    parsed = parseAiResponse(raw, project, state.currentBackgroundId, state.currentMusicId);
  }

  if (!parsed.ok || !parsed.turn) {
    throw new Error(parsed.error || 'Не удалось разобрать ответ ИИ');
  }

  const turn = parsed.turn;

  // Apply stat changes (clamped) and collect canonical facts.
  const { values, effective } = applyStatChanges(project, state.statValues, turn.statChanges);
  const facts: CanonicalFact[] = [
    ...state.memory.facts,
    { chapter: state.memory.chapter, kind: 'choice', text: `выбор: ${playerMove}` },
  ];
  for (const ch of turn.statChanges) {
    const orig = effective.find((e) => e.statId === ch.statId);
    if (orig) {
      const name = project.stats.find((s) => s.id === ch.statId)?.name || ch.statId;
      facts.push({
        chapter: state.memory.chapter,
        kind: 'stat',
        text: `${name} ${orig.delta > 0 ? '+' : ''}${orig.delta} (${ch.reason})`,
      });
    }
  }

  // Compute on-screen sprites from dialogue beats.
  const onScreenMap = new Map(state.onScreen.map((s) => [s.characterId, s]));
  for (const b of turn.beats) {
    if (b.type === 'dialogue') {
      onScreenMap.set(b.characterId, {
        characterId: b.characterId,
        emotion: b.emotion,
        position: b.position,
      });
    }
  }
  const onScreen = [...onScreenMap.values()].slice(-3);

  // Persist this exchange into the LLM history verbatim.
  const history = [
    ...state.history,
    { role: 'user' as const, content: playerMove },
    { role: 'assistant' as const, content: raw },
  ];

  let nextState: RuntimeState = {
    ...state,
    statValues: values,
    currentBackgroundId: turn.scene.backgroundId ?? state.currentBackgroundId,
    currentMusicId: turn.scene.musicId ?? state.currentMusicId,
    onScreen,
    history,
    lastTurn: turn,
    turnCount: state.turnCount + 1,
    memory: { ...state.memory, facts },
  };

  // Memory management (see ТЗ §10). Chapter boundary first, then budget compression.
  if (turn.chapterEvent === 'chapter_end') {
    facts.push({
      chapter: nextState.memory.chapter,
      kind: 'event',
      text: `конец главы ${nextState.memory.chapter}`,
    });
    nextState = await closeChapter(project, nextState);
  }
  nextState = await maybeCompress(project, nextState);

  return { turn, state: nextState };
}
