import type { Project, AiTurn, Beat } from '../shared/types';
import { EMOTIONS, AUDIO_MOODS } from '../shared/types';
import { aiTurnSchema } from './schema';
import { clamp } from '../shared/utils';

export interface ParseResult {
  ok: boolean;
  turn?: AiTurn;
  error?: string;
}

// Strip markdown fences and locate the first balanced JSON object.
function extractJson(raw: string): string | null {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();

  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else {
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

const EMOTION_SET = new Set<string>(EMOTIONS);
const MOOD_SET = new Set<string>(AUDIO_MOODS);

// Repair ids against the project manifest so hallucinations never crash render.
function repair(
  project: Project,
  parsed: AiTurn,
  currentBg: string | null,
  currentMood: string | null
): AiTurn {
  const assetIds = new Set(project.assets.map((a) => a.id));
  const charById = new Map(project.characters.map((c) => [c.id, c]));
  const statIds = new Set(project.stats.map((s) => s.id));

  const scene = {
    backgroundId:
      parsed.scene.backgroundId && assetIds.has(parsed.scene.backgroundId)
        ? parsed.scene.backgroundId
        : currentBg,
    // musicMood: только из закрытого словаря, иначе оставляем текущее настроение.
    musicMood:
      parsed.scene.musicMood && MOOD_SET.has(parsed.scene.musicMood)
        ? parsed.scene.musicMood
        : currentMood,
    sfxId: parsed.scene.sfxId && assetIds.has(parsed.scene.sfxId) ? parsed.scene.sfxId : null,
    cutsceneCgId:
      parsed.scene.cutsceneCgId && assetIds.has(parsed.scene.cutsceneCgId)
        ? parsed.scene.cutsceneCgId
        : null,
  };

  // Beats: единое правило.
  // - dialogue с валидным characterId → нормализуем эмоцию по доступным этому персонажу.
  // - dialogue без characterId, но с name → эпизодический NPC (рендер имя+текст).
  // - dialogue без characterId и без name → деградируем в narration.
  const beats: Beat[] = parsed.beats.map((b): Beat => {
    if (b.type !== 'dialogue') return b;

    const position = ['left', 'center', 'right'].includes(b.position as string)
      ? (b.position as 'left' | 'center' | 'right')
      : 'center';

    const cid = b.characterId || undefined;
    const ch = cid ? charById.get(cid) : undefined;

    if (ch) {
      // Эмоция: из закрытого словаря И из доступных спрайтов; иначе neutral.
      // (Если спрайта нет вовсе — движок отрисует имя+текст, эмоция роли не играет,
      // но всё равно держим её валидной для консистентности.)
      const available = Object.keys(ch.sprites);
      let emotion = b.emotion;
      if (!EMOTION_SET.has(emotion)) emotion = 'neutral';
      if (available.length && !available.includes(emotion)) {
        emotion = available.includes('neutral') ? 'neutral' : available[0];
      }
      return { type: 'dialogue', characterId: ch.id, emotion, position, text: b.text };
    }

    const name = (b.name || '').trim();
    if (name) {
      const emotion = EMOTION_SET.has(b.emotion) ? b.emotion : 'neutral';
      return { type: 'dialogue', name, emotion, position, text: b.text };
    }

    return { type: 'narration', text: b.text };
  });

  const statChanges = parsed.statChanges.filter((s) => statIds.has(s.statId));

  const choices = parsed.choices.map((c) => ({
    ...c,
    cost: c.cost && statIds.has(c.cost.statId) ? c.cost : null,
  }));

  return { scene, beats, statChanges, choices, chapterEvent: parsed.chapterEvent };
}

export function parseAiResponse(
  raw: string,
  project: Project,
  currentBg: string | null,
  currentMood: string | null
): ParseResult {
  const json = extractJson(raw);
  if (!json) return { ok: false, error: 'В ответе нет JSON-объекта' };
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch (e) {
    return { ok: false, error: 'Невалидный JSON: ' + (e as Error).message };
  }
  const result = aiTurnSchema.safeParse(obj);
  if (!result.success) {
    return { ok: false, error: 'Ответ не соответствует схеме: ' + result.error.issues[0]?.message };
  }
  const turn = repair(project, result.data as AiTurn, currentBg, currentMood);
  return { ok: true, turn };
}

// Apply clamped stat changes to a live values map, returning new values + effective deltas.
export function applyStatChanges(
  project: Project,
  values: Record<string, number>,
  changes: AiTurn['statChanges']
): { values: Record<string, number>; effective: { statId: string; delta: number }[] } {
  const next = { ...values };
  const effective: { statId: string; delta: number }[] = [];
  for (const ch of changes) {
    const def = project.stats.find((s) => s.id === ch.statId);
    if (!def) continue;
    const before = next[ch.statId] ?? def.initial;
    const after = clamp(before + ch.delta, def.min, def.max);
    if (after !== before) {
      next[ch.statId] = after;
      effective.push({ statId: ch.statId, delta: after - before });
    }
  }
  return { values: next, effective };
}
