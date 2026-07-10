import type { Project, AiTurn, Beat } from '../shared/types';
import { EMOTIONS } from '../shared/types';
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

// Repair ids against the project manifest so hallucinations never crash render (ТЗ §7).
function repair(project: Project, parsed: AiTurn, currentBg: string | null, currentMusic: string | null): AiTurn {
  const assetIds = new Set(project.assets.map((a) => a.id));
  const charById = new Map(project.characters.map((c) => [c.id, c]));
  const statIds = new Set(project.stats.map((s) => s.id));

  // Scene: invalid ids fall back to current (bg/music) or null.
  const scene = {
    backgroundId: parsed.scene.backgroundId && assetIds.has(parsed.scene.backgroundId)
      ? parsed.scene.backgroundId
      : currentBg,
    musicId: parsed.scene.musicId && assetIds.has(parsed.scene.musicId)
      ? parsed.scene.musicId
      : currentMusic,
    sfxId: parsed.scene.sfxId && assetIds.has(parsed.scene.sfxId) ? parsed.scene.sfxId : null,
    cutsceneCgId:
      parsed.scene.cutsceneCgId && assetIds.has(parsed.scene.cutsceneCgId)
        ? parsed.scene.cutsceneCgId
        : null,
  };

  // Beats: unknown character -> narration; unknown emotion -> fall back to a valid one.
  const beats: Beat[] = parsed.beats.map((b): Beat => {
    if (b.type === 'dialogue') {
      const ch = charById.get(b.characterId);
      if (!ch) return { type: 'narration', text: b.text };
      const known = new Set(ch.sprites.map((s) => s.emotion));
      let emotion = b.emotion;
      if (!known.has(emotion)) {
        emotion = known.has('neutral')
          ? 'neutral'
          : ch.sprites[0]?.emotion || (EMOTIONS.includes(emotion as any) ? emotion : 'neutral');
      }
      const position = ['left', 'center', 'right'].includes(b.position) ? b.position : 'center';
      return { type: 'dialogue', characterId: b.characterId, emotion, position, text: b.text };
    }
    return b;
  });

  // Stat changes: drop unknown stat ids (delta is clamped later against live values).
  const statChanges = parsed.statChanges.filter((s) => statIds.has(s.statId));

  // Choices: keep, but drop cost referencing unknown stats.
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
  currentMusic: string | null
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
  const turn = repair(project, result.data as AiTurn, currentBg, currentMusic);
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
