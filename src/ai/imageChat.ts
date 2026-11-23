import type { ImageAspectRatio, ImageChatMsg, ImageGenConfig, Project, RuntimeState } from '../shared/types';
import { IMAGE_ASPECT_RATIOS, defaultNaiConfig, normalizeNarrativeMode } from '../shared/types';
import { studioCompletion } from './studioConnection';
import { extractJson } from './responseParser';
import { describePerson, personsInText, resolvePerson, type Person } from './characterRegistry';
import { imageGenFor } from './imageConnection';
import { effectiveImageModel } from './imageProvider';
import { naiMaxCharacters, naiModel, splitNaiPrompt } from './novelai';
import { NAI_TAG_RULES, appearanceTagsOf, naiModelRules, parseNaiWorker } from './novelaiPrompt';
import { scenePeople } from './illustrations';
import { stripStateBlock } from './rpResponse';
import { withPreset } from './presetPassThrough';

// РУЧНОЙ РЕЖИМ СТУДИИ: ассистент картинок. Человек пишет по-простому («Тони и
// Пеппер на крыше, закат, она смеётся»), ассистент отвечает промптом для
// ТЕКУЩЕГО провайдера: NovelAI — теги «сцена | персонаж | …» по правилам
// NovelAI, Nano Banana и прочие — подробное английское описание. Следующие
// сообщения правят прошлый промпт, а не пишут новый с нуля. Людей из истории
// ассистент узнаёт по имени: их внешность (теги / описание) он видит, а рефы и
// описания к картинке добавляет общая сборка (renderImage) по списку «в кадре».

const CHAT_RULES_COMMON = `CONVERSATION:
- The user writes in plain words, often in Russian. Understand the intent and write the best possible prompt for it.
- If there is a previous prompt and the user asks for a change ("сделай ночь", "пусть она улыбается", "убери меч"), EDIT the previous prompt: change only what was asked, keep everything else word for word. Start from scratch only when the user clearly asks for a different picture.
- If the user asks a question instead of a picture, answer it in "reply" and keep the previous prompt unchanged.
- "reply": one or two short sentences in the user's language — what you drew or changed, and anything worth knowing (e.g. "NovelAI может не знать этого персонажа — добавила внешность тегами").
- Story people from the list: use their exact listed name in "cast"/"name". Their looks are given below — keep them.
- WELL-KNOWN characters (anime, manga, games, films, TV series, Marvel / DC…) the user names are drawn as THOSE characters, not as look-alikes.
- Depict exactly what the user asks for, nothing softened.`;

function naiChatSystem(ig: ImageGenConfig): string {
  const model = naiModel(effectiveImageModel(ig));
  return `You are an image prompt assistant for NovelAI Diffusion (an anime model trained on Danbooru tags).

${CHAT_RULES_COMMON}

PROMPT STRUCTURE:
- "scene": count tags first (rule 2), then framing and camera, a short sentence of what happens, location, time, lighting, mood, enhancing tags (rule 7). If the user explicitly names an art style, put those style tags right after the count tags; otherwise no style tags (the studio adds them).
- "characters": one per visible person, left to right: girl / boy / other, character + copyright tags for a well-known character (rule 4), APPEARANCE TAGS verbatim when given below (otherwise detailed appearance), clothing item by item, expression, gaze, pose, hands, action, interaction tags (rule 5).
- If the user wants NSFW, describe it explicitly with proper tags and add "nsfw" to the scene.

${NAI_TAG_RULES}

${naiModelRules(model)}

Output ONLY this JSON, no commentary:
{"reply": "...", "scene": "...", "characters": [{"name": "<listed name, or the well-known character's name>", "prompt": "..."}], "aspect": "2:3"}
"aspect" is one of 1:1, 2:3, 3:2, 3:4, 4:3, 9:16, 16:9 — what serves the composition (keep the previous one unless the change needs another).`;
}

const DESCRIPTIVE_CHAT_SYSTEM = `You are an image prompt assistant for a natural-language image model (Gemini image / "Nano Banana", GPT image and similar). It reads plain English descriptions, not tag lists.

${CHAT_RULES_COMMON}

HOW TO WRITE THE PROMPT ("prompt"), in English, as a vivid but precise description, 60–180 words:
1. Shot first: shot type (close-up, medium shot, full body, wide establishing shot), camera angle (low angle, high angle, over-the-shoulder, dutch angle, eye level), lens feel (35mm, telephoto compression, shallow depth of field) — choose a composition that is interesting, not two people standing still facing the camera.
2. Each person SEPARATELY and by position ("On the left, …", "In the foreground, …"): who they are, appearance (for story people keep their listed look), clothing as it is now, expression, gaze, pose, what the hands do. For a well-known character write their name and franchise ("Makima from Chainsaw Man", "Tony Stark from the Marvel Cinematic Universe") plus their signature design details (hair, eyes, iconic outfit or armor), so the model draws THAT character. Never name real actors or real people.
3. The interaction in one clear sentence: who does what to whom, with contact points ("she rests her head on his shoulder while he holds an umbrella over both of them").
4. Setting: location with concrete details, time of day, weather.
5. Lighting and colour: light source and direction, mood, palette.
6. Art style ONLY if the user asks for one; otherwise say nothing about style — the studio appends its own style.
- Describe what SHOULD be in the image; do not write "no …" lists (the studio has a separate avoid list).
- Do not write people's names for story people as if the model knew them: describe them; their reference images are attached automatically when they are in "cast".

Output ONLY this JSON, no commentary:
{"reply": "...", "prompt": "...", "aspect": "16:9", "cast": ["<listed names of story people in the picture>"]}
"aspect" is one of 1:1, 2:3, 3:2, 3:4, 4:3, 9:16, 16:9.`;

export function imageChatSystem(ig: ImageGenConfig): string {
  return ig.providerKind === 'novelai' ? naiChatSystem(ig) : DESCRIPTIVE_CHAT_SYSTEM;
}

/** Все, кого ассистент может узнать по имени: на сцене, персонажи проекта, найденные GM. */
export function chatPeople(project: Project, state: RuntimeState): { person: Person; here: boolean }[] {
  const out: { person: Person; here: boolean }[] = [];
  const push = (p: Person | null, here: boolean) => {
    if (!p) return;
    const was = out.find((x) => x.person.id === p.id);
    if (was) was.here ||= here;
    else out.push({ person: p, here });
  };
  for (const p of scenePeople(project, state)) push(p, true);
  for (const c of project.characters) push(resolvePerson(project, state, { id: c.id }), false);
  for (const r of state.gm?.registry || []) push(resolvePerson(project, state, { id: r.id }), false);
  return out.slice(0, 30);
}

function sceneContext(project: Project, state: RuntimeState): string {
  const loc = state.gm?.clock?.location || project.assets.find((a) => a.id === state.currentBackgroundId)?.name || '';
  const rp = normalizeNarrativeMode(project.mode) === 'rp';
  const last = rp ? [...state.history].reverse().find((m) => m.role === 'assistant') : undefined;
  const recent =
    (last ? stripStateBlock(last.content) : '') ||
    (state.lastTurn?.beats || [])
      .filter((b): b is Extract<typeof b, { text: string }> => 'text' in b && !!b.text)
      .map((b) => b.text)
      .join(' ');
  return `CURRENT STORY SCENE (use it when the user refers to "this scene", "сейчас", "тут"; otherwise it is only background knowledge):
Location: ${loc || 'unspecified'}
What just happened: ${recent.slice(-1500) || '(nothing yet)'}`;
}

export interface ChatTurnResult {
  reply: string;
  prompt: string;
  aspect?: ImageAspectRatio;
  cast: string[];
}

/** Один ход ассистента: история + новое сообщение → ответ и промпт. */
export async function imageChatTurn(
  project: Project,
  state: RuntimeState,
  history: ImageChatMsg[],
  request: string,
  opts: { seeScene: boolean; signal?: AbortSignal }
): Promise<ChatTurnResult> {
  const ig = imageGenFor(project);
  const nai = ig.nai ?? defaultNaiConfig();
  const isNai = ig.providerKind === 'novelai';
  const people = chatPeople(project, state);
  const lines = people.map(({ person, here }) => {
    const tags = isNai ? appearanceTagsOf(nai, person) : '';
    const look = describePerson(person).slice(0, 350);
    return `- ${person.name}${person.aliases.length ? ` (also: ${person.aliases.slice(0, 3).join(', ')})` : ''}${here && opts.seeScene ? ' [in the current scene]' : ''}${
      tags ? `\n  APPEARANCE TAGS (copy verbatim): ${tags}` : ''
    }${look ? `\n  look: ${look}` : ''}`;
  });
  const context = [
    `STORY PEOPLE (recognise them by name, in any language or case form):\n${lines.join('\n') || '(none)'}`,
    opts.seeScene ? sceneContext(project, state) : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  // Прошлые ходы: что просили и какой промпт вышел (с правками руками — они уже в msg.prompt).
  const past = history.filter((m) => m.text.trim() || m.prompt).slice(-12);
  const messages: { role: 'user' | 'assistant'; content: string }[] = [{ role: 'user', content: context }, { role: 'assistant', content: 'OK.' }];
  for (const m of past) {
    if (m.role === 'user') messages.push({ role: 'user', content: m.text });
    else if (m.prompt && m.provider === ig.providerKind) messages.push({ role: 'assistant', content: assistantEcho(m, isNai) });
    else messages.push({ role: 'assistant', content: JSON.stringify({ reply: m.text }) });
  }
  messages.push({ role: 'user', content: request });
  // Две подряд реплики одной роли некоторые API не принимают — склеиваем.
  const merged: typeof messages = [];
  for (const m of messages) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === m.role) prev.content += `\n\n${m.content}`;
    else merged.push({ ...m });
  }

  // Блоки пресета — те же правила, что у рассказчика (разрешения, тон); свою
  // задачу и формат ответа ассистент держит поверх них (см. presetPassThrough).
  const raw = await studioCompletion(
    withPreset(
      { system: imageChatSystem(ig), messages: merged, model: project.aiConfig.summarizerModel || undefined, temperature: 0.6, maxTokens: 2000 },
      project,
      state,
      ig.sendPreset !== false
    )
  );
  if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  return parseChatReply(raw, ig, people.map((x) => x.person), history);
}

/** Прошлый ответ ассистента — в том же JSON, что он пишет, чтобы правил его. */
function assistantEcho(m: ImageChatMsg, isNai: boolean): string {
  if (!isNai) return JSON.stringify({ reply: m.text, prompt: m.prompt, aspect: m.aspect, cast: m.cast || [] });
  const sp = splitNaiPrompt(m.prompt || '');
  const names = m.cast || [];
  return JSON.stringify({
    reply: m.text,
    scene: sp.base,
    characters: sp.characters.map((c, i) => ({ name: names[i] || `person ${i + 1}`, prompt: c })),
    aspect: m.aspect,
  });
}

export function parseChatReply(raw: string, ig: ImageGenConfig, people: Person[], history: ImageChatMsg[] = []): ChatTurnResult {
  let data: any = null;
  try {
    const j = extractJson(raw);
    if (j) data = JSON.parse(j);
  } catch {
    data = null;
  }
  const prev = [...history].reverse().find((m) => m.role === 'assistant' && m.prompt && m.provider === ig.providerKind);
  const reply = typeof data?.reply === 'string' ? data.reply.trim() : '';
  const aspect = (IMAGE_ASPECT_RATIOS as readonly string[]).includes(data?.aspect) ? (data.aspect as ImageAspectRatio) : undefined;
  if (ig.providerKind === 'novelai') {
    const nai = ig.nai ?? defaultNaiConfig();
    const max = naiMaxCharacters(naiModel(effectiveImageModel(ig)));
    if (data && typeof data.scene === 'string' && data.scene.trim()) {
      const r = parseNaiWorker(JSON.stringify(data), people, nai, max);
      return { reply: reply || 'Готово.', prompt: r.prompt, aspect: aspect ?? r.aspectRatio, cast: r.cast || [] };
    }
    // Вопрос без картинки — прежний промпт остаётся.
    if (data && reply) return { reply, prompt: prev?.prompt || '', aspect: prev?.aspect, cast: prev?.cast || [] };
    return { reply: reply || 'Промпт ниже.', prompt: raw.replace(/^```[a-z]*\n?|```$/gi, '').trim(), cast: [] };
  }
  if (data && typeof data.prompt === 'string' && data.prompt.trim()) {
    const named: string[] = Array.isArray(data.cast) ? data.cast.filter((x: unknown): x is string => typeof x === 'string' && !!x.trim()) : [];
    return { reply: reply || 'Готово.', prompt: data.prompt.trim(), aspect, cast: named };
  }
  if (data && reply) return { reply, prompt: prev?.prompt || '', aspect: prev?.aspect, cast: prev?.cast || [] };
  return { reply: 'Промпт ниже.', prompt: raw.replace(/^```[a-z]*\n?|```$/gi, '').trim(), cast: [] };
}

/** Кто в кадре по ответу: названные ассистентом + узнанные в тексте запроса и промпта. */
export function chatCast(project: Project, state: RuntimeState, names: string[], request: string): Person[] {
  const out: Person[] = [];
  const push = (p: Person | null | undefined) => {
    if (p && !out.some((x) => x.id === p.id)) out.push(p);
  };
  for (const n of names) {
    const p = resolvePerson(project, state, { name: n });
    push(p && !p.ids.length ? personsInText(project, state, n)[0] || p : p);
  }
  if (!names.length) for (const p of personsInText(project, state, request)) push(p);
  return out;
}
