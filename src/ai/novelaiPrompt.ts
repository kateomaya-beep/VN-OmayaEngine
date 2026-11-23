import type { ImageAspectRatio, NaiImageConfig, Project, RuntimeState } from '../shared/types';
import { IMAGE_ASPECT_RATIOS, defaultNaiConfig } from '../shared/types';
import { runCompletion } from './providers';
import { extractJson } from './responseParser';
import { describePerson, nameHit, personsInText, resolvePerson, type Person } from './characterRegistry';
import { imageGenFor } from './imageConnection';
import { effectiveImageModel } from './imageProvider';
import { joinNaiPrompt, naiMaxCharacters, naiModel, type NaiModel } from './novelai';

// ВОРКЕР NOVELAI. Пишет не фразу, а то, что модель NovelAI понимает лучше всего:
// теги Danbooru + короткие фразы, сцену отдельно, каждого персонажа отдельно
// (docs.novelai.net/en/image/multiplecharacters), взаимодействия — тегами
// source#/target#/mutual#. Стиль, художники и теги качества сюда не входят — их
// дописывает провайдер из настроек студии.
//
// Результат — в синтаксисе «сцена | персонаж | персонаж»: в нём промпт хранится,
// показывается и правится руками, а в запрос уходит разобранным.

export const NAI_WORKER_ILLUSTRATION = `You write prompts for NovelAI Diffusion, an anime image model trained on Danbooru tags. Turn the CURRENT moment of the story into one striking illustration.

LANGUAGE: English. Danbooru tag names, lowercase, comma-separated, spaces instead of underscores. Short natural-language sentences are allowed and help with actions and interactions. Do NOT add art style, artist or quality tags — they are added separately.

HONESTY: depict the scene exactly as the story has it — nothing softened, censored or left out. If the moment is sexual or involves nudity, describe it explicitly with the proper Danbooru tags and put the tag "nsfw" in the scene prompt; if it is not, do not add "nsfw". Violence, blood, injuries, tears — as they are in the story.

PRIORITY: 1) the characters and what they are doing to each other; 2) composition; 3) environment.

SCENE prompt ("scene"):
- Start with subject count tags for every visible person: 1girl / 1boy / 2girls / 1girl, 1boy / 3boys… (add "solo" for one person, "no humans" for an empty scene).
- Framing (close-up, portrait, upper body, cowboy shot, full body, wide shot) and camera angle (from above, from below, from side, from behind, dutch angle, pov, over the shoulder).
- An interesting, illustrative composition: dynamic angle, depth, foreground elements, perspective, motion — never two people standing still facing the viewer.
- Location and background as concrete tags, time of day, weather, lighting (backlighting, rim light, sunset, candlelight, neon lights, light particles…), mood.
- One or two short sentences describing what happens between the characters.

CHARACTER prompts ("characters"): one per visible person, ordered left to right as they stand in the frame.
- Start with girl / boy / other (no number).
- If the person has APPEARANCE TAGS below, copy them verbatim right after that. Otherwise describe appearance in detail: hair length, hairstyle, hair color, eye color, skin, body type, apparent age, distinctive features.
- If the person is a well-known character from an existing series, add their Danbooru character tag and series tag.
- Current clothing item by item as it is NOW in the scene, with its state (open shirt, wet clothes, torn clothes, partially undressed, nude…).
- Expression, gaze direction, pose, what the hands do, the exact action.
- Interactions with action tags on BOTH characters: source#action on the one doing it, target#action on the one receiving it, mutual#action when both do it (source#hug / target#hug, mutual#kiss, source#pointing at another / target#pointing).
- Optionally one short sentence about this character.
- Never write character names in prompts: the model does not know them (well-known characters' Danbooru tags are the exception).

Output ONLY this JSON, no commentary:
{"scene": "...", "characters": [{"name": "<name exactly as in the list>", "prompt": "..."}], "aspect": "2:3"}
"aspect" is one of 1:1, 2:3, 3:2, 3:4, 4:3, 9:16, 16:9 — pick what serves the composition.`;

export const NAI_WORKER_MANHWA = `You write prompts for NovelAI Diffusion V5, an anime image model that can draw a whole comic page in one image. Turn the CURRENT moment of the story into ONE vertical manhwa / webtoon page.

LANGUAGE: English. Danbooru tag names, lowercase, comma-separated, plus natural-language sentences for the panels. Do NOT add art style, artist or quality tags — they are added separately.

HONESTY: depict the scene exactly as the story has it — nothing softened or left out. If it is sexual or involves nudity, describe it explicitly with the proper Danbooru tags and put "nsfw" in the scene prompt; otherwise do not add "nsfw".

PRIORITY: the characters, their emotions and interaction, told panel by panel.

SCENE prompt ("scene"):
- Start with subject count tags for everyone who appears on the page (1girl, 1boy, 2girls…).
- Then: comic, manhwa, multiple panels, vertical page, speech bubble, english text.
- Then describe 3–5 panels from top to bottom in short sentences: "Panel 1: … Panel 2: …" — each with its framing (close-up, upper body, wide shot), camera angle, action and emotion. Vary the shots like a real manhwa: an establishing wide shot, close-ups on faces, a dramatic angle at the climax.
- Location, lighting and mood tags.
- Dialogue LAST, at the very end of the scene prompt: "Text: <line 1>" then each further line separated by an empty line. Short lines, in English, at most ~300 characters in total.

CHARACTER prompts ("characters"): one per person on the page.
- Start with girl / boy / other (no number).
- If the person has APPEARANCE TAGS below, copy them verbatim right after that; otherwise describe hair, eyes, body, age look and distinctive features in detail.
- Well-known characters: add their Danbooru character tag and series tag.
- Clothing item by item as it is now, expression, and their actions on the page; interactions with source#/target#/mutual# action tags.
- Never write character names in prompts.

Output ONLY this JSON, no commentary:
{"scene": "...", "characters": [{"name": "<name exactly as in the list>", "prompt": "..."}], "aspect": "9:16"}`;

export function naiWorkerDefault(preset: NaiImageConfig['workerPreset']): string {
  return preset === 'manhwa' ? NAI_WORKER_MANHWA : NAI_WORKER_ILLUSTRATION;
}

export function naiWorkerPrompt(nai: NaiImageConfig): string {
  return nai.workerPrompt?.trim() || naiWorkerDefault(nai.workerPreset);
}

/** Теги внешности человека — по любому из его id (анкета, запись Game Master, контакт). */
export function appearanceTagsOf(nai: NaiImageConfig, person: Person | null | undefined): string {
  if (!person) return '';
  for (const id of person.ids) {
    const t = nai.appearanceTags[id];
    if (t?.trim()) return t.trim();
  }
  return '';
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').replace(/[,\s]+$/, '').trim();

/**
 * Теги внешности — дословно в промпт персонажа. Модель воркера их обычно
 * переписывает сама, но «обычно» мало: одно потерянное «scar over eye» — и дизайн
 * поплыл. Нет их в промпте — ставим сразу за girl/boy/other.
 */
export function ensureAppearance(prompt: string, tags: string): string {
  if (!tags) return prompt.trim();
  const p = prompt.trim();
  // Проверяем по первым тегам: модель могла переставить хвост, но не начало.
  const head = tags.split(',').map((t) => norm(t)).filter(Boolean).slice(0, 3);
  if (head.every((t) => norm(p).includes(t))) return p;
  const m = /^(girl|boy|other)\s*,\s*/i.exec(p);
  const tagsNoSubject = tags.replace(/^(girl|boy|other)\s*,\s*/i, '');
  return m ? `${m[0]}${tagsNoSubject}, ${p.slice(m[0].length)}` : `${tags}, ${p}`;
}

function peopleList(project: Project, state: RuntimeState, opts: NaiComposeOpts, recent: string): Person[] {
  if (opts.people?.length) return opts.people;
  const onScreen = state.onScreen
    .map((o) => resolvePerson(project, state, { id: o.characterId }))
    .filter((x): x is Person => !!x);
  if (onScreen.length) return onScreen;
  // Сцену ещё не разметили (Game Master не записал, кто рядом; спрайтов в РП нет) —
  // берём тех, кто назван в самом моменте: иначе воркер не узнал бы ни имён, ни
  // их тегов внешности, и дизайн рисовался бы с нуля.
  return personsInText(project, state, `${opts.moment ?? ''}\n${recent}`);
}

export interface NaiComposeOpts {
  onlyCharacterIds?: string[];
  people?: Person[];
  moment?: string;
  recent?: string;
}

/** Сцена → промпт NovelAI «сцена | персонаж | …», кадр и состав. */
export async function composeNaiPrompt(
  project: Project,
  state: RuntimeState,
  opts: NaiComposeOpts = {}
): Promise<{ prompt: string; aspectRatio?: ImageAspectRatio; cast?: string[] }> {
  const ig = imageGenFor(project);
  const nai = ig.nai ?? defaultNaiConfig();
  const model: NaiModel = naiModel(effectiveImageModel(ig));
  const manual = opts.onlyCharacterIds;
  const recent =
    opts.recent?.slice(-2000) ||
    (state.lastTurn?.beats || [])
      .filter((b): b is Extract<typeof b, { text: string }> => 'text' in b && !!b.text)
      .map((b) => b.text)
      .join(' ')
      .slice(0, 1500) ||
    state.history.slice(-1).map((m) => m.content).join(' ').slice(0, 1500);
  const people = peopleList(project, state, opts, recent).filter((p) => !manual || p.ids.some((id) => manual.includes(id)));

  const lines = people.map((p) => {
    const tags = appearanceTagsOf(nai, p);
    const look = describePerson(p).slice(0, 400);
    const d = p.dossier;
    const now = [d?.outfit ? `wearing now: ${d.outfit}` : '', d?.mood ? `mood: ${d.mood}` : ''].filter(Boolean).join('; ');
    return `- ${p.name}${tags ? `\n  APPEARANCE TAGS (copy verbatim): ${tags}` : ''}${look ? `\n  description: ${look}` : ''}${now ? `\n  ${now}` : ''}`;
  });
  const loc =
    state.gm?.clock?.location || project.assets.find((a) => a.id === state.currentBackgroundId)?.name || '';
  const max = naiMaxCharacters(model);
  const user = `MODEL: NovelAI ${model.label}. At most ${max || 'no'} separate character prompts${
    max ? '' : ' — describe everyone inside the scene prompt'
  }.
${opts.moment ? `THE MOMENT TO DRAW (chosen by the narrator — frame exactly this): ${opts.moment}\n` : ''}Location: ${loc || 'unspecified'}
People available (use these exact names in "name"). ${
    manual ? 'ONLY these people may appear.' : 'They are in the scene, not necessarily in this shot — include only those the moment is about.'
  }
${lines.join('\n') || '(no named characters — an environment / mood image)'}

What is happening at this exact moment:
${recent || '(quiet beat — infer from location and characters)'}`;

  const raw = await runCompletion({
    system: naiWorkerPrompt(nai),
    messages: [{ role: 'user', content: user }],
    model: project.aiConfig.summarizerModel || undefined,
    temperature: 0.7,
  });
  return parseNaiWorker(raw, people, nai, max);
}

export function parseNaiWorker(
  raw: string,
  people: Person[],
  nai: NaiImageConfig,
  max: number
): { prompt: string; aspectRatio?: ImageAspectRatio; cast?: string[] } {
  let data: any = null;
  try {
    const j = extractJson(raw);
    if (j) data = JSON.parse(j);
  } catch {
    data = null;
  }
  if (!data || typeof data.scene !== 'string') {
    // Не JSON — берём как есть: «|»-синтаксис NovelAI понимает и так.
    return { prompt: raw.replace(/^```[a-z]*\n?|```$/gi, '').trim() };
  }
  const chars: { name: string; prompt: string }[] = Array.isArray(data.characters)
    ? data.characters.filter((c: any) => c && typeof c.prompt === 'string' && c.prompt.trim())
    : [];
  const cast: string[] = [];
  const segments = chars.slice(0, max || 0).map((c) => {
    const person = people.find((p) => nameHit(p.name, String(c.name || '')) || p.aliases.some((a) => nameHit(a, String(c.name || ''))));
    if (c.name) cast.push(person?.name ?? String(c.name));
    // «|» внутри промпта персонажа сломал бы разбор на части.
    return ensureAppearance(c.prompt, appearanceTagsOf(nai, person)).replace(/\|/g, '/');
  });
  // Модель без промптов персонажей (V3): всех описываем внутри сцены.
  const scene =
    max === 0 && chars.length ? `${data.scene.trim()}, ${chars.map((c) => c.prompt.trim()).join(', ')}` : data.scene.trim();
  const aspect = (IMAGE_ASPECT_RATIOS as readonly string[]).includes(data.aspect) ? (data.aspect as ImageAspectRatio) : undefined;
  return { prompt: joinNaiPrompt(scene.replace(/\|/g, '/'), segments), aspectRatio: aspect, cast };
}

// ── Теги внешности из анкеты ─────────────────────────────────────────────────

const APPEARANCE_SYSTEM = `You write NovelAI / Danbooru appearance tags for one character, so every image draws them the same way.
Start with girl / boy / other (no number). Then, if the character is a well-known existing character, their Danbooru character tag and series tag. Then: hair length, hairstyle, hair color, eye color, skin tone, body type and build, apparent age (e.g. mature male, mature female, teenage), distinctive features (scars, freckles, glasses, tattoos, piercings, facial hair, moles), and their usual outfit item by item with colors.
English Danbooru tags, lowercase, comma-separated, spaces instead of underscores. No names, no art style, no quality tags, no sentences. Output ONE line only.`;

export async function generateAppearanceTags(project: Project, state: RuntimeState | null, person: Person): Promise<string> {
  const c = person.char?.card;
  const d = person.dossier;
  const parts = [
    `Name: ${person.name}`,
    c?.appearance?.trim() && `Appearance: ${c.appearance.trim()}`,
    c?.personality?.trim() && `Description: ${c.personality.trim().slice(0, 1500)}`,
    d?.appearance?.trim() && `Appearance noted in the story: ${d.appearance.trim()}`,
    d?.outfit?.trim() && `Usually wears: ${d.outfit.trim()}`,
    !c && !d && describePerson(person) && `Known: ${describePerson(person)}`,
    project.lore.worldDescription.trim() && `World: ${project.lore.worldDescription.trim().slice(0, 400)}`,
  ].filter(Boolean);
  void state;
  const raw = await runCompletion({
    system: APPEARANCE_SYSTEM,
    messages: [{ role: 'user', content: parts.join('\n') }],
    model: project.aiConfig.summarizerModel || undefined,
    temperature: 0.4,
  });
  return raw
    .replace(/^```[a-z]*\n?|```$/gi, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)[0]
    ?.replace(/^["'\s]+|["'\s]+$/g, '') ?? '';
}
