import type { RuntimeState, GmCharacter } from '../shared/types';
import { runCompletion } from './providers';

// «Волшебная палочка» Game Master: сканирует контекст истории и автозаполняет данные
// (персонаж / события / адженда) через основную LLM. Возвращает распарсенный JSON;
// при сбое — бросает ошибку (вызывающий показывает тост).

// Достаём первый сбалансированный JSON (объект или массив) из ответа модели.
function extractJson(raw: string): string | null {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const startObj = text.indexOf('{');
  const startArr = text.indexOf('[');
  let start = -1;
  let open = '{';
  let close = '}';
  if (startArr !== -1 && (startObj === -1 || startArr < startObj)) {
    start = startArr;
    open = '[';
    close = ']';
  } else if (startObj !== -1) {
    start = startObj;
  }
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
      else if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

async function scanJson(system: string, user: string): Promise<any> {
  const raw = await runCompletion({
    system,
    messages: [{ role: 'user', content: user }],
    temperature: 0.2,
  });
  const json = extractJson(raw);
  if (!json) throw new Error('no JSON in scan response');
  return JSON.parse(json);
}

// Контекст для анализа: недавняя история + свёрнутая хроника.
function contextText(state: RuntimeState): string {
  const recent = state.history
    .slice(-40)
    .map((m) => `${m.role === 'user' ? 'PLAYER' : 'GAME'}: ${m.content}`)
    .join('\n');
  const chronicle = state.memory.chronicle.map((c) => c.text).join('\n');
  return [chronicle && `EARLIER (summary):\n${chronicle}`, `RECENT:\n${recent}`]
    .filter(Boolean)
    .join('\n\n')
    .slice(-12000);
}

const s = (v: unknown): string => (typeof v === 'string' ? v : '');
const sArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

// Автозаполнение досье персонажа по имени.
export async function scanCharacter(state: RuntimeState, name: string): Promise<Partial<GmCharacter>> {
  const system =
    'You are a story analyst for a visual-novel engine. From the transcript, build a compact dossier ' +
    `for the character named "${name}". Reply with ONLY a JSON object (no prose, English values): ` +
    '{"dossier":string,"appearance":string,"personality":string,"roleToHero":string,"outfit":string,"mood":string,"status":string,"location":string,"tags":[string]}. ' +
    'Base every field strictly on what the transcript shows; leave a field as "" if unknown.';
  const obj = await scanJson(system, contextText(state));
  return {
    dossier: s(obj.dossier),
    appearance: s(obj.appearance),
    personality: s(obj.personality),
    roleToHero: s(obj.roleToHero),
    outfit: s(obj.outfit),
    mood: s(obj.mood),
    status: s(obj.status),
    location: s(obj.location),
    tags: sArr(obj.tags),
  };
}

export interface ScannedEvent {
  summary: string;
  chars: string[];
  mood: string;
}

// Извлекает ключевые события из недавнего контекста (для журнала событий).
export async function scanEvents(state: RuntimeState): Promise<ScannedEvent[]> {
  const system =
    'You are a story analyst. Extract the key events from the transcript in chronological order. ' +
    'Reply with ONLY a JSON array (English values): [{"summary":string,"chars":[string],"mood":string}]. ' +
    'Keep each summary to one sentence; at most 12 items; only genuinely notable beats.';
  const arr = await scanJson(system, contextText(state));
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((e) => e && typeof e.summary === 'string')
    .map((e) => ({ summary: s(e.summary), chars: sArr(e.chars), mood: s(e.mood) }));
}

// Сканирование контактов (Batch 8 §V): люди, с которыми протагонист ЗНАКОМ и чей
// номер мог бы быть в телефоне. `known` — имена, которые уже есть (не предлагать снова).
export async function scanContacts(state: RuntimeState, known: string[]): Promise<string[]> {
  const system =
    'You are a story analyst for a phone-contacts feature. From the transcript, list the NAMED people ' +
    'the protagonist personally knows and could realistically have a phone number for (friends, love ' +
    'interests, family, colleagues, acquaintances they have actually interacted with). ' +
    'EXCLUDE: strangers, one-off passersby, groups, and anyone only mentioned in passing without a real ' +
    'acquaintance. Reply with ONLY a JSON array of names (strings), most relevant first, at most 12.';
  const known2 = known.map((n) => n.toLowerCase());
  const arr = await scanJson(system, contextText(state));
  return sArr(arr)
    .map((n) => n.trim())
    .filter((n) => n && !known2.includes(n.toLowerCase()))
    // Дедуп без учёта регистра.
    .filter((n, i, a) => a.findIndex((x) => x.toLowerCase() === n.toLowerCase()) === i)
    .slice(0, 12);
}

export interface GeneratedSheet {
  name: string;
  appearance: string;
  personality: string;
  backstory: string;
  speechStyle: string;
  scenario?: string;
  greetings?: string[];
}

// Генерация полной анкеты персонажа на английском (Batch 8 §VI.2) — формат нашего
// конструктора / ST-совместимый, независимо от языка нарратива.
export async function generateCharacterSheet(state: RuntimeState, name: string): Promise<GeneratedSheet> {
  const system =
    'You are a character-card writer for a visual-novel engine. Build a FULL character sheet for the ' +
    `character named "${name}", based strictly on what the transcript shows (infer tastefully where the ` +
    'transcript is silent, staying consistent). ALL VALUES IN ENGLISH regardless of the story language. ' +
    'Gather EVERYTHING known about this character from the transcript (summary sections, canonical ' +
    'facts, events) and produce ONE consistent sheet that preserves established facts and never ' +
    'contradicts canon — this UPDATES the character, it does not invent a second version of them. ' +
    'Reply with ONLY a JSON object: {"name":string,"appearance":string,"personality":string,' +
    '"backstory":string,"speechStyle":string,"scenario":string,"greetings":[string]}. ' +
    'appearance/personality/backstory are a few sentences each; speechStyle describes how they talk; ' +
    'scenario is the situation framing; greetings is 1-2 opening lines in their voice.';
  const obj = await scanJson(system, contextText(state));
  return {
    name: s(obj.name) || name,
    appearance: s(obj.appearance),
    personality: s(obj.personality),
    backstory: s(obj.backstory),
    speechStyle: s(obj.speechStyle),
    scenario: s(obj.scenario) || undefined,
    greetings: sArr(obj.greetings),
  };
}

// Извлекает открытые задачи/цели из контекста (для адженды).
export async function scanAgenda(state: RuntimeState): Promise<string[]> {
  const system =
    'You are a story analyst. From the transcript, list the currently OPEN goals, quests, promises, ' +
    'and unresolved tasks facing the protagonist. Reply with ONLY a JSON array of short strings ' +
    '(English), at most 10 items, most important first.';
  const arr = await scanJson(system, contextText(state));
  return sArr(arr);
}
