import type { Project, RuntimeState, AiTurn, Beat } from '../shared/types';
import { EMOTIONS, EMOTION_LABELS, AUDIO_MOODS, AUDIO_MOOD_LABELS } from '../shared/types';
import { characterOutfits, defaultOutfitTag, hasExtraOutfits } from '../shared/outfits';
import { runCompletionWith } from './providers';
import { embedLocal, cosineSim } from './vectorEngine';
import { extractJson } from './responseParser';
import { logEvent } from '../shared/logStore';

// Разделение ролей ИИ (Batch 5.4). Рассказчик уже вернул beats/статы (и, как раньше,
// свой выбор emotion/наряд/фон/музыки). Если проект настроен на отдельный Селектор
// ассетов ('custom'/'local'), здесь мы ПЕРЕВЫБИРАЕМ ассеты из ЗАКРЫТЫХ списков
// (emotion — 11; наряд — теги персонажа; музыка — 8+кастом), снимая эту задачу с
// дорогого основного запроса. Любая ошибка/невалидный ответ → молча оставляем выбор
// Рассказчика (fallback не меняется, краша нет).

// Индекс-выровненные по turn.beats переопределения + сценовые.
interface Selection {
  beats: { emotion?: string; outfit?: string | null }[];
  musicMood?: string | null;
}

function sceneText(turn: AiTurn): string {
  return turn.beats
    .map((b) => ('text' in b && b.text ? b.text : ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1500);
}

function moodOptions(project: Project): string[] {
  return [...AUDIO_MOODS, ...project.audioMoods];
}

function moodLabel(mood: string): string {
  return (AUDIO_MOOD_LABELS as Record<string, { en: string }>)[mood]?.en || mood;
}

// Применяет валидированный Selection к копии хода (клонируем только затронутое).
function applySelection(project: Project, turn: AiTurn, sel: Selection): AiTurn {
  const charById = new Map(project.characters.map((c) => [c.id, c]));
  const moods = new Set(moodOptions(project));

  const beats: Beat[] = turn.beats.map((b, i) => {
    if (b.type !== 'dialogue' || !b.characterId) return b;
    const ov = sel.beats[i];
    if (!ov) return b;
    const ch = charById.get(b.characterId);
    let emotion = b.emotion;
    if (ov.emotion && (EMOTIONS as readonly string[]).includes(ov.emotion)) emotion = ov.emotion;
    let outfit = b.outfit;
    if (ch && ov.outfit !== undefined) {
      const tag = (ov.outfit || '').trim();
      outfit = tag && characterOutfits(ch).includes(tag) && tag !== defaultOutfitTag(ch) ? tag : undefined;
    }
    return { ...b, emotion, ...(outfit ? { outfit } : { outfit: undefined }) };
  });

  let scene = turn.scene;
  if (sel.musicMood && moods.has(sel.musicMood) && sel.musicMood !== turn.scene.musicMood) {
    scene = { ...turn.scene, musicMood: sel.musicMood };
  }
  return { ...turn, beats, scene };
}

// ---- Локальный источник: эмбеддинги MiniLM в Web Worker (семантическая близость к
// закрытым спискам). Ничего не отправляет наружу. ----
async function nearestKey(query: string, candidates: { key: string; text: string }[]): Promise<string | null> {
  if (!query.trim() || !candidates.length) return null;
  const vecs = await embedLocal([query, ...candidates.map((c) => c.text)]);
  const q = vecs[0];
  let best = -Infinity;
  let bestKey: string | null = null;
  for (let i = 0; i < candidates.length; i++) {
    const s = cosineSim(q, vecs[i + 1]);
    if (s > best) {
      best = s;
      bestKey = candidates[i].key;
    }
  }
  return bestKey;
}

async function selectLocal(project: Project, turn: AiTurn): Promise<Selection> {
  const charById = new Map(project.characters.map((c) => [c.id, c]));
  const scene = sceneText(turn);
  const emoCands = EMOTIONS.map((e) => ({ key: e, text: `${e}: ${EMOTION_LABELS[e].en}` }));
  const moodCands = moodOptions(project).map((m) => ({ key: m, text: moodLabel(m) }));

  const beats: Selection['beats'] = [];
  for (const b of turn.beats) {
    if (b.type !== 'dialogue' || !b.characterId) {
      beats.push({});
      continue;
    }
    const ch = charById.get(b.characterId);
    const emotion = (await nearestKey(b.text, emoCands)) || undefined;
    let outfit: string | null | undefined;
    if (ch && hasExtraOutfits(ch)) {
      const outfitCands = characterOutfits(ch).map((o) => ({ key: o, text: o }));
      outfit = (await nearestKey(scene, outfitCands)) ?? null;
    }
    beats.push({ emotion, outfit });
  }

  const musicMood = (await nearestKey(scene, moodCands)) || undefined;
  return { beats, musicMood };
}

// ---- Отдельное подключение: один компактный классифицирующий запрос к дешёвой
// модели. Возвращает JSON, который мы валидируем по закрытым спискам. ----
async function selectCustom(project: Project, turn: AiTurn): Promise<Selection> {
  const conn = project.aiConfig.assetSelector?.customApi;
  if (!conn) throw new Error('custom source without connection');
  const charById = new Map(project.characters.map((c) => [c.id, c]));
  const scene = sceneText(turn);

  // Список реплик для классификации (только персонажи из списка).
  const lines = turn.beats
    .map((b, i) => {
      if (b.type !== 'dialogue' || !b.characterId) return null;
      const ch = charById.get(b.characterId);
      const outfits = ch && hasExtraOutfits(ch) ? ` outfits=[${characterOutfits(ch).join(', ')}]` : '';
      return `#${i} ${ch?.name || b.characterId}: "${b.text.slice(0, 200)}"${outfits}`;
    })
    .filter(Boolean)
    .join('\n');

  const system =
    'You are an asset classifier for a visual novel engine. Pick values ONLY from the closed lists. ' +
    'Reply with EXACTLY one JSON object, no prose.';
  const user = [
    `SCENE:\n${scene}`,
    `\nEMOTIONS (closed): ${EMOTIONS.join(', ')}`,
    `MUSIC MOODS (closed): ${moodOptions(project).join(', ')}`,
    `\nLINES (classify each; use the outfit list shown for that line, omit outfit if none):\n${lines || '(none)'}`,
    `\nReturn JSON: { "beats": [ { "i": number, "emotion": string, "outfit": string|null } ], "musicMood": string|null }`,
  ].join('\n');

  const raw = await runCompletionWith(conn, 'assetSelector', {
    system,
    messages: [{ role: 'user', content: user }],
    temperature: 0,
    maxTokens: 600,
  });
  const parsed = extractJson(raw) as any;
  const beats: Selection['beats'] = turn.beats.map(() => ({}));
  if (parsed && Array.isArray(parsed.beats)) {
    for (const item of parsed.beats) {
      const i = Number(item?.i);
      if (Number.isInteger(i) && i >= 0 && i < beats.length) {
        beats[i] = {
          emotion: typeof item.emotion === 'string' ? item.emotion : undefined,
          outfit: item.outfit === null ? null : typeof item.outfit === 'string' ? item.outfit : undefined,
        };
      }
    }
  }
  const musicMood = typeof parsed?.musicMood === 'string' ? parsed.musicMood : undefined;
  return { beats, musicMood };
}

// Точка входа: возвращает ход с (возможно) переопределёнными ассетами. source==='main'
// или любая ошибка → ход без изменений (выбор Рассказчика). Никогда не бросает.
export async function selectAssets(
  project: Project,
  _state: RuntimeState,
  turn: AiTurn
): Promise<AiTurn> {
  const cfg = project.aiConfig.assetSelector;
  if (!cfg || cfg.source === 'main') return turn;
  const started = Date.now();
  try {
    const sel = cfg.source === 'local' ? await selectLocal(project, turn) : await selectCustom(project, turn);
    logEvent('info', 'llm', `Селектор ассетов (${cfg.source}) отработал за ${Date.now() - started} мс`);
    return applySelection(project, turn, sel);
  } catch (e) {
    logEvent('info', 'llm', `Селектор ассетов (${cfg.source}) не сработал — выбор Рассказчика: ${(e as Error).message}`);
    return turn;
  }
}
