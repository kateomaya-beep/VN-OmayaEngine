import type { Project, AiTurn, Beat, RuntimeState, RelationshipStats, Character } from '../shared/types';
import { EMOTIONS, AUDIO_MOODS, RELATIONSHIP_FIELDS, PHONE_BALANCE_STAT } from '../shared/types';
import { aiTurnSchema } from './schema';
import { characterOutfits, defaultOutfitTag } from '../shared/outfits';
import { clamp } from '../shared/utils';
import { isValidDate, parseTime } from '../shared/gameDate';

// Статы отношений адресуются как statId = `rel:<charId>:<field>` (см. CR v2 §C.3).
const REL_FIELD_SET = new Set<string>(RELATIONSHIP_FIELDS);
export function parseRelStatId(
  statId: string
): { charId: string; field: keyof RelationshipStats } | null {
  if (!statId.startsWith('rel:')) return null;
  const rest = statId.slice(4);
  const idx = rest.lastIndexOf(':');
  if (idx === -1) return null;
  const charId = rest.slice(0, idx);
  const field = rest.slice(idx + 1);
  if (!charId || !REL_FIELD_SET.has(field)) return null;
  return { charId, field: field as keyof RelationshipStats };
}

export interface ParseResult {
  ok: boolean;
  turn?: AiTurn;
  error?: string;
}

// Strip markdown fences and locate the first balanced JSON object.
export function extractJson(raw: string): string | null {
  let text = raw.trim();
  // Управляемое размышление: модель пишет план в <thinking>/<think> перед JSON —
  // вырезаем эти блоки, чтобы они не мешали разбору. Если тег не закрыт, но дальше
  // есть JSON — балансный поиск ниже всё равно найдёт первый '{'.
  text = text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').trim();
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

// Резолв ссылки на персонажа: точный id, иначе имя (без регистра). Модели (особенно
// Gemini) часто пишут отображаемое ИМЯ вместо id — раньше такие биты молча
// выбрасывались (наряды «не менялись», реплики теряли спрайт). Чиним, не роняем.
export function charByRef(project: Project, ref: unknown): Character | undefined {
  if (typeof ref !== 'string' || !ref.trim()) return undefined;
  const exact = project.characters.find((c) => c.id === ref);
  if (exact) return exact;
  const n = ref.trim().toLowerCase();
  return project.characters.find((c) => c.name.trim().toLowerCase() === n);
}

// Алиасы полей отношений, которые модели пишут вместо канонических.
const REL_FIELD_ALIAS: Record<string, string> = { passion: 'passion_stat', love: 'affection' };

// Иногда ИИ ошибочно префиксит текст служебной меткой хода игрока
// ([CHOICE]/[VERBATIM]/… или их старыми русскими вариантами). В отображаемом
// тексте (реплики, варианты выбора) их быть не должно — вырезаем ведущую метку.
const MOVE_TAG_RE =
  /^\s*\[(?:choice|verbatim|ooc|continue|game start|author note|выбор|дословно|оос|продолжить|заметка автора|начало игры)\]\s*/i;
export function stripMoveTag(text: string): string {
  return typeof text === 'string' ? text.replace(MOVE_TAG_RE, '') : text;
}

// Чинит один beat против манифеста (используется и потоковым, и обычным путём).
export function repairBeat(project: Project, b: any): Beat {
  const bgIds = new Set(project.assets.filter((a) => a.type === 'background').map((a) => a.id));
  const txt = (v: unknown) => stripMoveTag(String(v ?? ''));
  // Динамический фон бита: оставляем только валидный id фона, иначе — undefined
  // (движок протянет прежний). Всегда undefined на невалидном — без крашей.
  const bgOf = (v: unknown) => (typeof v === 'string' && bgIds.has(v) ? v : undefined);
  const bg = bgOf(b?.bg);
  const mood = typeof b?.mood === 'string' && b.mood.trim() ? b.mood.trim() : undefined;

  // Управляющие биты (Batch 6 §1). scene_change: фон (backgroundId|bg) и/или muz-настроение.
  if (b?.type === 'scene_change') {
    const scBg = bgOf(b.backgroundId) ?? bgOf(b.bg);
    const scMood = typeof b.musicMood === 'string' && b.musicMood.trim() ? b.musicMood.trim() : undefined;
    // Полностью пустой scene_change бесполезен — сворачиваем в пустой нарратив (движок отфильтрует).
    return { type: 'scene_change', ...(scBg ? { bg: scBg } : {}), ...(scMood ? { musicMood: scMood } : {}) };
  }
  // outfit_change: персонаж по id ИЛИ имени + каноничный (по регистру) наряд, иначе — игнор.
  if (b?.type === 'outfit_change') {
    const ch = charByRef(project, b.characterId);
    const raw = typeof b.outfit === 'string' ? b.outfit.trim() : '';
    const canon = ch && raw ? characterOutfits(ch).find((o) => o.toLowerCase() === raw.toLowerCase()) : undefined;
    if (ch && canon) return { type: 'outfit_change', characterId: ch.id, outfit: canon };
    return { type: 'narration', text: '' }; // невалидно → пустой нарратив (движок отфильтрует)
  }
  // Телефон (Batch 7 §7.2): transaction / money_change / sms_incoming / contact_added.
  if (b?.type === 'transaction') {
    const amount = typeof b.amount === 'number' && Number.isFinite(b.amount) ? Math.round(b.amount) : 0;
    if (amount === 0) return { type: 'narration', text: '' };
    const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    return { type: 'transaction', amount, vendor: s(b.vendor), item: s(b.item), time: s(b.time) };
  }
  if (b?.type === 'money_change') {
    const amount = typeof b.amount === 'number' && Number.isFinite(b.amount) ? Math.round(b.amount) : 0;
    if (amount === 0) return { type: 'narration', text: '' };
    return { type: 'money_change', amount, reason: typeof b.reason === 'string' ? b.reason : undefined };
  }
  if (b?.type === 'sms_incoming') {
    const ch = charByRef(project, b.characterId);
    const text = txt(b.text);
    if (ch && text.trim()) return { type: 'sms_incoming', characterId: ch.id, text };
    return { type: 'narration', text: '' };
  }
  if (b?.type === 'contact_added') {
    const ch = charByRef(project, b.characterId);
    if (ch) return { type: 'contact_added', characterId: ch.id };
    return { type: 'narration', text: '' };
  }
  // Симулятор жизни (Batch 8): time_advance / inventory_add / inventory_remove.
  if (b?.type === 'time_advance') {
    const nd = isValidDate(b.newDate) ? (b.newDate as string) : undefined;
    const nt = parseTime(b.newTime) || undefined;
    if (!nd && !nt) return { type: 'narration', text: '' };
    return { type: 'time_advance', newDate: nd, newTime: nt };
  }
  if (b?.type === 'inventory_add') {
    const name = txt(b.name).trim();
    if (!name) return { type: 'narration', text: '' };
    const qty = typeof b.quantity === 'number' && b.quantity > 0 ? Math.round(b.quantity) : 1;
    const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    return { type: 'inventory_add', name, emoji: s(b.emoji), quantity: qty, category: s(b.category), source: s(b.source) };
  }
  if (b?.type === 'inventory_remove') {
    const name = txt(b.name).trim();
    if (!name) return { type: 'narration', text: '' };
    const qty = typeof b.quantity === 'number' && b.quantity > 0 ? Math.round(b.quantity) : 1;
    const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    return { type: 'inventory_remove', name, quantity: qty, reason: s(b.reason) };
  }
  // Реестр персонажей (patch character-registry).
  if (b?.type === 'character_new') {
    const canonicalName = txt(b.canonicalName).trim();
    if (!canonicalName) return { type: 'narration', text: '' };
    const roles = ['protagonist', 'love_interest', 'important_character', 'npc'];
    const aliases = Array.isArray(b.aliases) ? b.aliases.filter((x: unknown): x is string => typeof x === 'string' && !!x.trim()) : undefined;
    return {
      type: 'character_new',
      id: typeof b.id === 'string' && b.id.trim() ? b.id.trim() : undefined,
      canonicalName,
      aliases,
      role: roles.includes(b.role) ? b.role : undefined,
    };
  }
  if (b?.type === 'character_alias_add') {
    const id = txt(b.id).trim();
    const alias = txt(b.alias).trim();
    if (!id || !alias) return { type: 'narration', text: '' };
    return { type: 'character_alias_add', id, alias };
  }
  if (b?.type === 'character_update') {
    const id = txt(b.id).trim();
    if (!id) return { type: 'narration', text: '' };
    const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    let sheetPatch: Record<string, string> | undefined;
    if (b.sheetPatch && typeof b.sheetPatch === 'object') {
      sheetPatch = {};
      for (const [k, v] of Object.entries(b.sheetPatch)) if (typeof v === 'string') sheetPatch[k] = v;
      if (!Object.keys(sheetPatch).length) sheetPatch = undefined;
    }
    return { type: 'character_update', id, status: s(b.status), canonicalName: s(b.canonicalName), sheetPatch };
  }

  if (!b || b.type !== 'dialogue') {
    if (b?.type === 'thought') return { type: 'thought', text: txt(b.text), bg, mood };
    return { type: 'narration', text: txt(b?.text), bg, mood };
  }
  const position = ['left', 'center', 'right'].includes(b.position) ? b.position : 'center';
  // Персонаж по id ИЛИ имени (модели пишут «Дэмиан» вместо char_x — раньше такая
  // реплика деградировала в NPC без спрайта/наряда и рвала непрерывность сцены).
  const ch = charByRef(project, b.characterId);
  if (ch) {
    // Эмоция — только из закрытого словаря (защита от рассинхрона мимики). Конкретный
    // спрайт наряд+эмоция подбирает resolveSprite на отрисовке (с fallback-цепочкой),
    // поэтому эмоцию к «доступным» больше НЕ приводим — сохраняем задумку ИИ.
    let emotion = b.emotion;
    if (!EMOTION_SET.has(emotion)) emotion = 'neutral';
    // Наряд — открытый тег: сопоставляем БЕЗ учёта регистра к каноничному тегу
    // персонажа (модель может слегка менять регистр). Дефолтный храним как undefined.
    // resolveSprite всё равно подстрахует.
    const outfits = characterOutfits(ch);
    const raw = typeof b.outfit === 'string' ? b.outfit.trim() : '';
    const canon = raw ? outfits.find((o) => o.toLowerCase() === raw.toLowerCase()) : undefined;
    const outfit = canon && canon !== defaultOutfitTag(ch) ? canon : undefined;
    return { type: 'dialogue', characterId: ch.id, emotion, ...(outfit ? { outfit } : {}), position, text: txt(b.text), bg, mood };
  }
  // NPC: имя из name; если его нет, а characterId — «человеческая» строка (не наш
  // id-формат), это и есть имя эпизодника — не теряем реплику.
  const cidStr = typeof b.characterId === 'string' ? b.characterId.trim() : '';
  const name = ((b.name || '').trim() || (cidStr && !/^(char|np)_/i.test(cidStr) ? cidStr : '')).trim();
  if (name) {
    const emotion = EMOTION_SET.has(b.emotion) ? b.emotion : 'neutral';
    return { type: 'dialogue', name, emotion, position, text: txt(b.text), bg, mood };
  }
  return { type: 'narration', text: txt(b.text), bg, mood };
}

// Чинит объект scene против манифеста.
export function repairScene(
  project: Project,
  scene: any,
  currentBg: string | null,
  currentMood: string | null
): AiTurn['scene'] {
  const assetIds = new Set(project.assets.map((a) => a.id));
  const moodSet = new Set<string>([...AUDIO_MOODS, ...project.audioMoods]);
  const s = scene || {};
  return {
    backgroundId: s.backgroundId && assetIds.has(s.backgroundId) ? s.backgroundId : currentBg,
    musicMood: s.musicMood && moodSet.has(s.musicMood) ? s.musicMood : currentMood,
    sfxId: s.sfxId && assetIds.has(s.sfxId) ? s.sfxId : null,
    cutsceneCgId: s.cutsceneCgId && assetIds.has(s.cutsceneCgId) ? s.cutsceneCgId : null,
  };
}

// Repair ids against the project manifest so hallucinations never crash render.
// Нормализация statId (ФИКС «статы не обновляются»): раньше принимался только
// ТОЧНЫЙ id — statChange с именем стата («Деньги»), именем персонажа в rel:
// (rel:Дэмиан:affection) или phone_balance молча выбрасывался. Теперь чиним:
// id как есть → имя стата (без регистра) → rel с резолвом персонажа по имени
// и алиасами полей → phone_balance. Невалидное — по-прежнему отбрасываем.
export function normalizeStatId(project: Project, raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const s = raw.trim();
  if (project.stats.some((d) => d.id === s)) return s;
  if (s === PHONE_BALANCE_STAT) return s;
  const byName = project.stats.find((d) => d.name.trim().toLowerCase() === s.toLowerCase());
  if (byName) return byName.id;
  if (s.startsWith('rel:')) {
    const rest = s.slice(4);
    const idx = rest.lastIndexOf(':');
    if (idx > 0) {
      const ref = rest.slice(0, idx);
      const fieldRaw = rest.slice(idx + 1).trim().toLowerCase();
      const field = REL_FIELD_ALIAS[fieldRaw] || fieldRaw;
      const ch = charByRef(project, ref);
      if (ch && REL_FIELD_SET.has(field)) return `rel:${ch.id}:${field}`;
    }
  }
  return null;
}

function repair(
  project: Project,
  parsed: AiTurn,
  currentBg: string | null,
  currentMood: string | null
): AiTurn {
  const scene = repairScene(project, parsed.scene, currentBg, currentMood);
  const beats: Beat[] = parsed.beats.map((b) => repairBeat(project, b));

  // Нормализуем statId (id/имя/rel-имя/phone_balance); ненайденные отбрасываем.
  const statChanges = parsed.statChanges
    .map((s) => {
      const id = normalizeStatId(project, s.statId);
      return id ? { ...s, statId: id } : null;
    })
    .filter((s): s is AiTurn['statChanges'][number] => !!s);

  const choices = parsed.choices.map((c) => {
    const costId = c.cost ? normalizeStatId(project, c.cost.statId) : null;
    return {
      ...c,
      text: stripMoveTag(c.text),
      cost: c.cost && costId ? { ...c.cost, statId: costId } : null,
    };
  });

  return { scene, beats, statChanges, choices, chapterEvent: parsed.chapterEvent, worldState: parsed.worldState };
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
    if (parseRelStatId(ch.statId)) continue; // rel-статы обрабатываются отдельно
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

// Apply relationship stat changes (rel:<charId>:<field>), clamped -100..100.
export function applyRelationshipChanges(
  project: Project,
  relationship: Record<string, RelationshipStats>,
  changes: AiTurn['statChanges']
): {
  relationship: Record<string, RelationshipStats>;
  effective: { charId: string; field: keyof RelationshipStats; delta: number }[];
} {
  const next: Record<string, RelationshipStats> = {};
  for (const [k, v] of Object.entries(relationship)) next[k] = { ...v };
  const effective: { charId: string; field: keyof RelationshipStats; delta: number }[] = [];
  const charIds = new Set(project.characters.map((c) => c.id));
  for (const ch of changes) {
    const rel = parseRelStatId(ch.statId);
    if (!rel || !charIds.has(rel.charId)) continue;
    if (!next[rel.charId]) next[rel.charId] = { affection: 0, passion_stat: 0, friendship: 0, respect: 0 };
    const before = next[rel.charId][rel.field] ?? 0;
    const after = clamp(before + ch.delta, -100, 100);
    if (after !== before) {
      next[rel.charId][rel.field] = after;
      effective.push({ charId: rel.charId, field: rel.field, delta: after - before });
    }
  }
  return { relationship: next, effective };
}
