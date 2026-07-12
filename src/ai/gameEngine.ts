import type { Project, RuntimeState, AiTurn, CanonicalFact, AudioMood, MemoryBookEntry } from '../shared/types';
import { RELATIONSHIP_META } from '../shared/types';
import { buildRequest } from './promptBuilder';
import { runCompletion, runCompletionStream } from './providers';
import {
  parseAiResponse,
  applyStatChanges,
  applyRelationshipChanges,
  repairScene,
  repairBeat,
} from './responseParser';
import { TurnStreamParser } from './streamParser';
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
  '\n\nThe response failed validation. Reply with EXACTLY one JSON object per the schema — no markdown, no text outside the JSON.';

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

// Применяет разобранный ход к state: статы, отношения, канон-факты, меморибук,
// спрайты на сцене, музыку, историю, память. Общая часть для обычного и
// потокового пути (см. Batch 3 §7). `raw` — сырой ответ ИИ для истории.
export async function applyTurn(
  project: Project,
  state: RuntimeState,
  playerMove: string,
  turn: AiTurn,
  raw: string
): Promise<RuntimeState> {
  const nextTurnNumber = state.turnCount + 1;

  // Apply stat changes (clamped) and collect canonical facts (turn-indexed, not chapter-indexed).
  const { values, effective } = applyStatChanges(project, state.statValues, turn.statChanges);
  const rel = applyRelationshipChanges(project, state.relationship, turn.statChanges);
  // Гарантируем запись отношений для КАЖДОГО персонажа проекта — чтобы персонажи,
  // добавленные по ходу игры, сразу отслеживались, эволюционировали и сохранялись
  // (а не оставались статичными). Протагонист статов отношений не имеет.
  for (const c of project.characters) {
    if (c.role !== 'protagonist' && !rel.relationship[c.id]) {
      rel.relationship[c.id] = { ...c.relationship };
    }
  }
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

  return nextState;
}

// Run one player turn: build context -> call LLM -> parse/repair -> apply to state.
export async function runTurn(
  project: Project,
  state: RuntimeState,
  playerMove: string
): Promise<TurnResult> {
  const req = await buildRequest(project, state, playerMove);

  let raw = await runCompletion({
    system: req.system,
    messages: req.messages,
    prefill: req.prefill,
    temperature: project.aiConfig.temperature,
  });

  let parsed = parseAiResponse(raw, project, state.currentBackgroundId, state.currentMusicMood);

  // One automatic retry on invalid JSON.
  if (!parsed.ok) {
    raw = await runCompletion({
      system: req.system,
      messages: [...req.messages, { role: 'user', content: RETRY_HINT }],
      prefill: req.prefill,
      temperature: Math.min(project.aiConfig.temperature, 0.5),
    });
    parsed = parseAiResponse(raw, project, state.currentBackgroundId, state.currentMusicMood);
  }

  if (!parsed.ok || !parsed.turn) {
    throw new Error(parsed.error || 'Не удалось разобрать ответ ИИ');
  }

  const turn = parsed.turn;
  const nextState = await applyTurn(project, state, playerMove, turn, raw);
  return { turn, state: nextState };
}

// Колбэки потокового хода: инкрементально сообщают о сцене (рано — чтобы фон/музыка
// грузились) и о каждом завершённом beat (эффект «печатания»).
export interface StreamCallbacks {
  onScene?: (scene: AiTurn['scene']) => void;
  onBeat?: (beat: AiTurn['beats'][number], index: number) => void;
}

// Потоковый ход (Batch 3 §7): стримит ответ провайдера, парсит инкрементально,
// отдаёт сцену и beats по мере готовности через колбэки; финальный state собирает
// полноценным парсером (источник правды). Фолбэк на обычный ход при сбое стрима.
export async function streamTurn(
  project: Project,
  state: RuntimeState,
  playerMove: string,
  callbacks: StreamCallbacks
): Promise<TurnResult> {
  const req = await buildRequest(project, state, playerMove);
  // Форсируем префилл '{"scene":' — чтобы объект scene пришёл первым и фон/музыка
  // подхватились раньше диалога (если пользователь не задал свой префилл).
  const prefill = req.prefill && req.prefill.includes('scene') ? req.prefill : '{"scene":';

  const parser = new TurnStreamParser();
  let sceneSent = false;
  let beatsSent = 0;

  try {
    for await (const chunk of runCompletionStream({
      system: req.system,
      messages: req.messages,
      prefill,
      temperature: project.aiConfig.temperature,
    })) {
      const ev = parser.push(chunk);
      if (!sceneSent && ev.scene && callbacks.onScene) {
        callbacks.onScene(repairScene(project, ev.scene, state.currentBackgroundId, state.currentMusicMood));
        sceneSent = true;
      }
      for (const b of ev.beats) {
        if (callbacks.onBeat) callbacks.onBeat(repairBeat(project, b), beatsSent);
        beatsSent++;
      }
    }
  } catch {
    // Стрим сорвался — тихо падаем на обычный (нестриминговый) ход.
    return runTurn(project, state, playerMove);
  }

  const raw = parser.raw;
  let parsed = parseAiResponse(raw, project, state.currentBackgroundId, state.currentMusicMood);

  // Если потоковый сбор дал невалидный JSON — один обычный ретрай.
  if (!parsed.ok) {
    const retryRaw = await runCompletion({
      system: req.system,
      messages: [...req.messages, { role: 'user', content: RETRY_HINT }],
      prefill: req.prefill,
      temperature: Math.min(project.aiConfig.temperature, 0.5),
    });
    parsed = parseAiResponse(retryRaw, project, state.currentBackgroundId, state.currentMusicMood);
    if (parsed.ok && parsed.turn) {
      const nextState = await applyTurn(project, state, playerMove, parsed.turn, retryRaw);
      return { turn: parsed.turn, state: nextState };
    }
  }

  if (!parsed.ok || !parsed.turn) {
    throw new Error(parsed.error || 'Не удалось разобрать ответ ИИ');
  }

  const turn = parsed.turn;
  const nextState = await applyTurn(project, state, playerMove, turn, raw);
  return { turn, state: nextState };
}
