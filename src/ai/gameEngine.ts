import type { Project, RuntimeState, AiTurn, CanonicalFact, AudioMood, MemoryBookEntry } from '../shared/types';
import { RELATIONSHIP_META } from '../shared/types';
import { buildRequest } from './promptBuilder';
import { runCompletion } from './providers';
import { parseAiResponse, applyStatChanges, applyRelationshipChanges } from './responseParser';
import { maybeCompress } from './memoryEngine';
import { uid } from '../shared/utils';

// Порог, с которого сдвиг отношений считается «заметным событием» и попадает
// в Меморибук автоматически (обычный шаг ±1..5 — см. CR v2 §C.3).
const NOTABLE_RELATIONSHIP_DELTA = 5;

export interface TurnResult {
  turn: AiTurn;
  state: RuntimeState;
}

const RETRY_HINT =
  '\n\nОтвет не прошёл валидацию. Верни СТРОГО один JSON-объект по схеме, без markdown и текста вне JSON.';

// Подбор трека под настроение: ротация среди треков этого настроения; нет треков →
// пробуем 'calm'; ничего нет → null (тишина). Не крашит.
export function pickTrackForMood(
  project: Project,
  mood: AudioMood | string | null,
  prevAssetId: string | null
): string | null {
  if (!mood) return prevAssetId;
  const pool = project.assets.filter((a) => a.type === 'music' && a.audioMood === mood);
  const chosen = pool.length ? pool : project.assets.filter((a) => a.type === 'music' && a.audioMood === 'calm');
  if (!chosen.length) return null;
  if (chosen.length === 1) return chosen[0].id;
  // Ротация: избегаем повтора текущего трека.
  const candidates = chosen.filter((a) => a.id !== prevAssetId);
  const pickFrom = candidates.length ? candidates : chosen;
  return pickFrom[Math.floor(Math.random() * pickFrom.length)].id;
}

// Run one player turn: build context -> call LLM -> parse/repair -> apply to state.
export async function runTurn(
  project: Project,
  state: RuntimeState,
  playerMove: string
): Promise<TurnResult> {
  const req = await buildRequest(project, state, playerMove);

  let raw = await runCompletion(project.aiConfig, {
    system: req.system,
    messages: req.messages,
    prefill: req.prefill,
    model: project.aiConfig.model,
    temperature: project.aiConfig.temperature,
  });

  let parsed = parseAiResponse(raw, project, state.currentBackgroundId, state.currentMusicMood);

  // One automatic retry on invalid JSON.
  if (!parsed.ok) {
    raw = await runCompletion(project.aiConfig, {
      system: req.system,
      messages: [...req.messages, { role: 'user', content: RETRY_HINT }],
      prefill: req.prefill,
      model: project.aiConfig.model,
      temperature: Math.min(project.aiConfig.temperature, 0.5),
    });
    parsed = parseAiResponse(raw, project, state.currentBackgroundId, state.currentMusicMood);
  }

  if (!parsed.ok || !parsed.turn) {
    throw new Error(parsed.error || 'Не удалось разобрать ответ ИИ');
  }

  const turn = parsed.turn;
  const nextTurnNumber = state.turnCount + 1;

  // Apply stat changes (clamped) and collect canonical facts (turn-indexed, not chapter-indexed).
  const { values, effective } = applyStatChanges(project, state.statValues, turn.statChanges);
  const rel = applyRelationshipChanges(project, state.relationship, turn.statChanges);
  const facts: CanonicalFact[] = [
    ...state.memory.facts,
    { turn: nextTurnNumber, kind: 'choice', text: `выбор: ${playerMove}` },
  ];
  const memorybookAdds: MemoryBookEntry[] = [];
  for (const ch of turn.statChanges) {
    const orig = effective.find((e) => e.statId === ch.statId);
    if (orig) {
      const name = project.stats.find((s) => s.id === ch.statId)?.name || ch.statId;
      facts.push({
        turn: nextTurnNumber,
        kind: 'stat',
        text: `${name} ${orig.delta > 0 ? '+' : ''}${orig.delta} (${ch.reason})`,
      });
    }
  }
  for (const e of rel.effective) {
    const cName = project.characters.find((c) => c.id === e.charId)?.name || e.charId;
    const text = `${cName}: ${RELATIONSHIP_META[e.field].ru} ${e.delta > 0 ? '+' : ''}${e.delta}`;
    facts.push({ turn: nextTurnNumber, kind: 'stat', text });
    // Заметные сдвиги отношений — авто-запись в Меморибук (см. CR v2 §E1).
    if (Math.abs(e.delta) >= NOTABLE_RELATIONSHIP_DELTA) {
      memorybookAdds.push({ id: uid('mem'), text, turn: nextTurnNumber, source: 'auto', pinned: false });
    }
  }
  if (turn.chapterEvent === 'cg_moment') {
    const gist = turn.beats.find((b) => b.type === 'narration')?.text || 'Ключевой момент сюжета';
    memorybookAdds.push({
      id: uid('mem'),
      text: gist.slice(0, 200),
      turn: nextTurnNumber,
      source: 'auto',
      pinned: true, // CG-моменты — крупная веха, продвигается в постоянные сразу
    });
  }

  // On-screen sprites: только персонажи из списка (с characterId). NPC/name — без слота.
  const onScreenMap = new Map(state.onScreen.map((s) => [s.characterId, s]));
  for (const b of turn.beats) {
    if (b.type === 'dialogue' && b.characterId) {
      onScreenMap.set(b.characterId, {
        characterId: b.characterId,
        emotion: b.emotion,
        position: b.position,
      });
    }
  }
  const onScreen = [...onScreenMap.values()].slice(-3);

  // Музыка: настроение -> конкретный трек (движок сам выбирает).
  const nextMood = turn.scene.musicMood ?? state.currentMusicMood;
  const nextTrack =
    nextMood === state.currentMusicMood
      ? state.currentMusicAssetId
      : pickTrackForMood(project, nextMood, state.currentMusicAssetId);

  const history = [
    ...state.history,
    { role: 'user' as const, content: playerMove },
    { role: 'assistant' as const, content: raw },
  ];

  if (turn.chapterEvent === 'chapter_end') {
    facts.push({ turn: nextTurnNumber, kind: 'event', text: 'сюжетная веха' });
  }

  let nextState: RuntimeState = {
    ...state,
    statValues: values,
    relationship: rel.relationship,
    currentBackgroundId: turn.scene.backgroundId ?? state.currentBackgroundId,
    currentMusicMood: nextMood,
    currentMusicAssetId: nextTrack,
    onScreen,
    history,
    lastTurn: turn,
    turnCount: nextTurnNumber,
    memory: {
      ...state.memory,
      facts,
      memorybook: [...state.memory.memorybook, ...memorybookAdds],
      messagesSinceSummary: state.memory.messagesSinceSummary + 2,
    },
  };

  // «Веха» из ИИ (бывший chapter_end) — форсируем немедленную свёртку живого окна,
  // не дожидаясь счётчика (глав больше нет, но крупный сюжетный рубеж всё ещё
  // повод подытожить историю — см. CR v2 §E).
  nextState = await maybeCompress(project, nextState, turn.chapterEvent === 'chapter_end');

  return { turn, state: nextState };
}
