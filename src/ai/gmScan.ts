import { chaptersOf } from './chapters';
import type { Project, RuntimeState, GmCharacter } from '../shared/types';
import { runCompletion } from './providers';
import { nameHit } from './characterRegistry';

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

// Что известно о людях ВНЕ стенограммы: анкеты персонажей, досье Game Master,
// реестр, лорбук и снапшот состояния. Без этого блока сканер не видел, например,
// маму и папу героя, прописанных в его анкете, — в стенограмме их могло не быть
// вовсе, и «просканировать контакты» их не находило.
function whoIsWho(project: Project | undefined, state: RuntimeState): string {
  const parts: string[] = [];
  for (const c of project?.characters || []) {
    const card = [c.card.personality, c.card.backstory, c.card.appearance]
      .map((x) => x?.trim())
      .filter(Boolean)
      .join(' ')
      .slice(0, 700);
    parts.push(`- ${c.name} (${c.role})${card ? `: ${card}` : ''}`);
  }
  for (const e of project?.lorebook || []) {
    const body = e.content?.trim().slice(0, 400);
    if (body) parts.push(`- [lore] ${e.title || e.keys?.join(', ') || ''}: ${body}`);
  }
  for (const r of state.gm.registry || []) {
    parts.push(`- ${r.canonicalName}${r.aliases.length ? ` (aka ${r.aliases.join(', ')})` : ''} — ${r.status || r.role}`);
  }
  for (const d of state.gm.characters) {
    const bits = [d.dossier, d.roleToHero].map((x) => x?.trim()).filter(Boolean).join('; ').slice(0, 300);
    if (bits) parts.push(`- ${d.name}: ${bits}`);
  }
  if (state.memory.storyState?.trim()) parts.push(`\nCURRENT STORY STATE:\n${state.memory.storyState.trim().slice(0, 2000)}`);
  return parts.length ? `WHO IS WHO (character sheets, lore, dossiers — people can be mentioned here and NOT appear in the transcript):\n${parts.join('\n')}` : '';
}

// Контекст для анализа: анкеты/лор/досье + недавняя история + свёрнутая хроника.
// Стенограмму режем с конца (нужен свежий хвост), а блок «кто есть кто» кладём
// ПОСЛЕ обрезки — иначе он же первым и вылетал из контекста.
function contextText(state: RuntimeState, project?: Project): string {
  const recent = state.history
    .slice(-40)
    .map((m) => `${m.role === 'user' ? 'PLAYER' : 'GAME'}: ${m.content}`)
    .join('\n');
  const chronicle = chaptersOf(state.memory)
    .filter((c) => c.mode !== 'off')
    .map((c) => `«${c.title}»: ${c.text}`)
    .join('\n');
  const transcript = [chronicle && `EARLIER (summary):\n${chronicle}`, `RECENT:\n${recent}`]
    .filter(Boolean)
    .join('\n\n')
    .slice(-12000);
  const who = whoIsWho(project, state);
  return [who, transcript].filter(Boolean).join('\n\n');
}

const s = (v: unknown): string => (typeof v === 'string' ? v : '');
const sArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

// Автозаполнение досье персонажа по имени.
export async function scanCharacter(
  state: RuntimeState,
  name: string,
  project?: Project
): Promise<Partial<GmCharacter>> {
  const system =
    `Build a compact dossier for "${name}" from the context (sheets and lore are canon). ` +
    'Reply with ONLY this JSON, English values, "" if unknown: ' +
    '{"dossier":string,"appearance":string,"personality":string,"roleToHero":string,"outfit":string,"mood":string,"status":string,"location":string,"tags":[string]}.';
  const obj = await scanJson(system, contextText(state, project));
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
    'Extract the notable events from the transcript, chronological, max 12, one sentence each. ' +
    'Reply with ONLY a JSON array, English values: [{"summary":string,"chars":[string],"mood":string}].';
  const arr = await scanJson(system, contextText(state));
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((e) => e && typeof e.summary === 'string')
    .map((e) => ({ summary: s(e.summary), chars: sArr(e.chars), mood: s(e.mood) }));
}

// Сканирование контактов (Batch 8 §V): люди, с которыми протагонист ЗНАКОМ и чей
// номер мог бы быть в телефоне. `known` — имена, которые уже есть (не предлагать снова).
export async function scanContacts(
  state: RuntimeState,
  known: string[],
  project?: Project
): Promise<string[]> {
  const system =
    'List people the protagonist personally knows and would have a phone number for (family, friends, love interests, colleagues, acquaintances). ' +
    'Sources: the WHO IS WHO block (sheets, lore, dossiers) and the transcript; people never on stage count too (e.g. a parent from the hero\'s sheet). ' +
    'Unnamed relatives → the name the story uses ("Мама", "Папа", "Mom"). ' +
    'Exclude strangers, passersby, organisations, people with no personal tie. ' +
    'Reply with ONLY a JSON array of names, most relevant first, max 12.';
  // Отсев уже известных и дедуп — с точностью до падежа: «Лиза» и «Лизу» это
  // один человек, и предлагать его дважды не надо.
  const arr = await scanJson(system, contextText(state, project));
  return sArr(arr)
    .map((n) => n.trim())
    .filter((n) => n && !known.some((k) => nameHit(k, n)))
    .filter((n, i, a) => a.findIndex((x) => nameHit(x, n)) === i)
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
export async function generateCharacterSheet(
  state: RuntimeState,
  name: string,
  project?: Project
): Promise<GeneratedSheet> {
  const system =
    `Write a full character sheet for "${name}" from everything the context shows (chapters, facts, events). ` +
    'Keep established facts; never contradict canon; infer only where silent, consistently. English values. ' +
    'Reply with ONLY this JSON: {"name":string,"appearance":string,"personality":string,' +
    '"backstory":string,"speechStyle":string,"scenario":string,"greetings":[string]}. ' +
    'appearance/personality/backstory: a few sentences each; speechStyle: how they talk; scenario: situation framing; greetings: 1–2 opening lines in their voice.';
  const obj = await scanJson(system, contextText(state, project));
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
    'List the protagonist\'s open goals, quests, promises and unresolved tasks from the transcript. ' +
    'Reply with ONLY a JSON array of short English strings, max 10, most important first.';
  const arr = await scanJson(system, contextText(state));
  return sArr(arr);
}
