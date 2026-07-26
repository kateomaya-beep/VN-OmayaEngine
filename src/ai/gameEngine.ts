import type { Project, RuntimeState, AiTurn, CanonicalFact, AudioMood, MemoryBookEntry } from '../shared/types';
import { RELATIONSHIP_META, DEFAULT_TURN_LENGTH } from '../shared/types';
import { buildRequest } from './promptBuilder';
import { runCompletion } from './providers';
import { getPresetSettings } from './presetSettings';
import { parseAiResponse, applyStatChanges, applyRelationshipChanges } from './responseParser';
import { mergeWorldState } from './gameMaster';
import { selectAssets } from './assetSelector';
import { maybeCompress } from './memoryEngine';
import { rollRandomEvent } from './randomEvents';
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
  raw: string,
  opts?: { eventFired?: boolean }
): Promise<RuntimeState> {
  const nextTurnNumber = state.turnCount + 1;

  // Частота выборов: если задан минимальный интервал (choiceMinGap) и с прошлого
  // показа выбора прошло меньше N ходов — глушим choices этого хода. Модель считать
  // ходы не умеет, поэтому решает движок (детерминированно). turn.choices мутируем,
  // чтобы и немедленный рендер, и сохранённый lastTurn отражали троттлинг.
  const choiceGap = getPresetSettings().choiceMinGap ?? 0;
  let lastChoiceTurn = state.lastChoiceTurn ?? -1e9;
  if (choiceGap > 0 && turn.choices.length > 0 && nextTurnNumber - lastChoiceTurn < choiceGap) {
    turn.choices = [];
  }
  if (turn.choices.length > 0) lastChoiceTurn = nextTurnNumber;

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

  // Единый проход по beats (Batch 6 §1): управляющие биты scene_change/outfit_change
  // применяются В ТОЧКЕ появления в потоке, их эффект «протягивается» на последующие
  // content-биты (эффективные bg/mood), а сами управляющие биты убираются из потока
  // (текста не несут). Наряд персонажа — СОСТОЯНИЕ: сеем из onScreen, обновляем сменами,
  // сохраняем вперёд (персонаж остаётся в новом наряде и на следующие ходы).
  const outfitByChar = new Map<string, string | undefined>();
  for (const os of state.onScreen) outfitByChar.set(os.characterId, os.outfit);
  const onScreenMap = new Map(state.onScreen.map((s) => [s.characterId, s]));

  let runBg: string | null = turn.scene.backgroundId ?? state.currentBackgroundId;
  let runMood: string | null = turn.scene.musicMood ?? state.currentMusicMood;

  const contentBeats: typeof turn.beats = [];
  for (const b of turn.beats) {
    if (b.type === 'scene_change') {
      if (b.bg) runBg = b.bg;
      if (b.musicMood) runMood = b.musicMood;
      continue;
    }
    if (b.type === 'outfit_change') {
      outfitByChar.set(b.characterId, b.outfit);
      const cur = onScreenMap.get(b.characterId);
      if (cur) onScreenMap.set(b.characterId, { ...cur, outfit: b.outfit });
      continue;
    }
    // Пустой нарратив (артефакт невалидного управляющего бита) — тоже отбрасываем.
    if (b.type === 'narration' && !b.text.trim() && !b.bg && !b.mood) continue;

    // Content-бит: печём эффективные фон и настроение на его момент.
    if (b.bg) runBg = b.bg;
    else b.bg = runBg ?? undefined;
    if (b.mood) runMood = b.mood;
    else if (runMood) b.mood = runMood;

    if (b.type === 'dialogue' && b.characterId) {
      // Наряд бита приоритетнее; иначе — текущий наряд персонажа из состояния.
      if (b.outfit) outfitByChar.set(b.characterId, b.outfit);
      else if (outfitByChar.get(b.characterId)) b.outfit = outfitByChar.get(b.characterId);
      onScreenMap.set(b.characterId, {
        characterId: b.characterId,
        emotion: b.emotion,
        outfit: b.outfit,
        position: b.position,
      });
    }
    contentBeats.push(b);
  }
  turn.beats = contentBeats;
  const onScreen = [...onScreenMap.values()].slice(-3);
  const finalBackgroundId = runBg ?? state.currentBackgroundId;

  // Музыка: финальное настроение хода -> конкретный трек (мид-турн смены играет плеер).
  const nextMood = runMood ?? state.currentMusicMood;
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

  // Game Master: мержим дельту мира от ИИ (досье/статусы/часы/отношения/адженда).
  const gm = mergeWorldState(state.gm, turn.worldState, nextTurnNumber);

  let nextState: RuntimeState = {
    ...state,
    statValues: values,
    relationship: rel.relationship,
    currentBackgroundId: finalBackgroundId,
    currentMusicMood: nextMood,
    currentMusicAssetId: nextTrack,
    onScreen,
    history,
    gm,
    lastTurn: turn,
    turnCount: nextTurnNumber,
    lastChoiceTurn,
    // Кулдаун случайных событий (Batch 6 §3): сброс при срабатывании, иначе +1.
    turnsSinceLastEvent: opts?.eventFired ? 0 : (state.turnsSinceLastEvent ?? 999) + 1,
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
  playerMove: string,
  signal?: AbortSignal
): Promise<TurnResult> {
  // Случайное событие (Batch 6 §3): скрытая директива в контекст этого хода.
  const evt = rollRandomEvent(project, state);
  const req = await buildRequest(project, state, playerMove, { extraDirective: evt.directive || undefined });

  // Потолок токенов — под верхнюю границу длины хода (слова→токены ≈ ×2.2 для
  // кириллицы) + запас на JSON-обвязку/worldState. Держим НЕ слишком большим,
  // иначе модель выбирает весь бюджет и уходит в «полотно» (медленно). Но и не
  // ниже дефолта шлюза, который иначе режет ход.
  const ps = getPresetSettings();
  const tl = ps.turnLength || DEFAULT_TURN_LENGTH;
  const maxTokens = Math.min(6000, Math.max(1200, Math.round(tl.max * 2.2) + 700));
  // При управляемом размышлении родную «думалку» глушим (none) — иначе она сложится
  // с нашим планом и станет только медленнее.
  const reasoningEffort = ps.guidedThinking ? 'none' : ps.reasoningEffort;

  let raw = await runCompletion({
    system: req.system,
    messages: req.messages,
    prefill: req.prefill,
    temperature: ps.temperature,
    maxTokens,
    reasoningEffort,
    signal,
  });

  let parsed = parseAiResponse(raw, project, state.currentBackgroundId, state.currentMusicMood);

  // One automatic retry on invalid JSON.
  if (!parsed.ok) {
    raw = await runCompletion({
      system: req.system,
      messages: [...req.messages, { role: 'user', content: RETRY_HINT }],
      prefill: req.prefill,
      temperature: Math.min(ps.temperature, 0.5),
      maxTokens,
      reasoningEffort,
      signal,
    });
    parsed = parseAiResponse(raw, project, state.currentBackgroundId, state.currentMusicMood);
  }

  if (!parsed.ok || !parsed.turn) {
    throw new Error(parsed.error || 'Не удалось разобрать ответ ИИ');
  }

  // Разделение ролей ИИ (Batch 5.4): если настроен отдельный Селектор ассетов
  // ('custom'/'local'), он переопределяет emotion/наряд/музыку из закрытых списков.
  // source==='main' или ошибка → ход без изменений (выбор Рассказчика).
  const turn = await selectAssets(project, state, parsed.turn);
  const nextState = await applyTurn(project, state, playerMove, turn, raw, { eventFired: evt.fired });
  return { turn, state: nextState };
}
