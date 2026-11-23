import type { ImageAspectRatio, NaiImageConfig, Project, RuntimeState } from '../shared/types';
import { IMAGE_ASPECT_RATIOS, defaultNaiConfig } from '../shared/types';
import { studioCompletion } from './studioConnection';
import { extractJson } from './responseParser';
import { describePerson, nameHit, personsInText, resolvePerson, type Person } from './characterRegistry';
import { imageGenFor } from './imageConnection';
import { effectiveImageModel } from './imageProvider';
import { fixNaiWeights, joinNaiPrompt, naiMaxCharacters, naiModel, normalizeCharacterPrompt, type NaiModel } from './novelai';

// ВОРКЕР NOVELAI. Пишет не фразу, а то, что модель NovelAI понимает лучше всего:
// теги Danbooru + короткие фразы, сцену отдельно, каждого персонажа отдельно
// (docs.novelai.net/en/image/multiplecharacters), взаимодействия — тегами
// source#/target#/mutual#. Стиль, художники и теги качества сюда не входят — их
// дописывает провайдер из настроек студии.
//
// Результат — в синтаксисе «сцена | персонаж | персонаж»: в нём промпт хранится,
// показывается и правится руками, а в запрос уходит разобранным.

/**
 * Правила сборки промпта NovelAI — общие для воркера сцены, ассистента в ручном
 * режиме и тегов внешности. Взяты из docs.novelai.net (tags, multiple characters,
 * text rendering, models); что из этого модель может забыть, дополнительно
 * исправляет код (normalizeNaiScene).
 */
export const NAI_TAG_RULES = `TAG RULES — NovelAI follows them literally; break one and the image breaks:
1. Danbooru tag names in English, lowercase, separated by ", ", spaces instead of underscores ("long hair", not "long_hair"). Short plain-English sentences may sit between tags to explain actions.
2. COUNT TAGS go ONLY into the scene prompt, at its very start, covering every visible person exactly once: 1girl / 1boy / 2girls / 1girl, 1boy / 2boys, 1girl / 6+girls; add "solo" for one person, "no humans" for nobody.
3. Every visible person gets their OWN character prompt starting with exactly one of: girl, boy, other — no number. Never two people in one character prompt, and never describe a person's looks in the scene prompt when they have their own prompt (that is what makes their features bleed into each other).
4. WELL-KNOWN CHARACTERS (anime, manga, games, films, TV series, Marvel / DC comics, vocaloids, vtubers…): write their Danbooru CHARACTER tag exactly as Danbooru spells it, with the series qualifier in parentheses whenever Danbooru uses one — e.g. "makima (chainsaw man)", "gojou satoru", "2b (nier:automata)", "tony stark", "peter parker", "spider-man", "hatsune miku" — immediately followed by the COPYRIGHT tag of the series: "chainsaw man", "jujutsu kaisen", "nier:automata", "marvel", "marvel cinematic universe", "vocaloid". Both go right after girl / boy in that character's prompt (in a solo picture they may also lead the scene prompt, right after the count tags). Still add their key look (hair, eyes, signature outfit): it anchors the design when the model knows the character weakly. Original characters of the story get NO character tag — appearance tags only. Never write any other name.
5. INTERACTIONS: tag BOTH sides with the same action — source#<action> on the one doing it, target#<action> on the one receiving it, mutual#<action> when both do it together: source#hug / target#hug, mutual#kiss, mutual#holding hands, source#carrying / target#carrying, source#slapping / target#slapping, source#pointing at another / target#pointing at another. Also state it in one short sentence in the scene prompt ("the boy hugs the girl from behind").
6. POSITION: list character prompts left to right as they stand in the frame.
7. ENHANCING TAGS — choose the few that serve THIS picture and put them in the scene prompt: framing (close-up, portrait, upper body, cowboy shot, full body, wide shot), camera (from above, from below, from side, from behind, dutch angle, pov, over the shoulder), dynamic pose, dynamic angle, foreshortening, perspective, depth of field, blurry foreground, motion blur, motion lines, cinematic lighting, light rays, rim lighting, backlighting, volumetric lighting, lens flare, detailed background, scenery, atmospheric perspective, light particles, wind, floating hair.
8. DO NOT write quality tags (masterpiece, best quality, very aesthetic, absurdres…), art style, artist or year tags, nor negative prompts — the app adds all of these from the user's settings.
9. Text drawn in the image only as "Text: …" at the very END of the scene prompt, in English.
10. Everything in English: no Cyrillic, no emoji, no names except Danbooru character tags.`;

/** Что зависит от выбранной модели — подставляется в каждый запрос воркеру. */
export function naiModelRules(m: NaiModel): string {
  const max = naiMaxCharacters(m);
  const lines = [
    `MODEL: NovelAI ${m.label}.`,
    max
      ? `At most ${max} character prompts; if more people are visible, give prompts to the ${max} most important and mention the rest in the scene prompt (they still count in the count tags).`
      : 'This model has NO character prompts: describe every person inside the scene prompt, one after another, after the count tags.',
  ];
  if (m.family === 'v5') {
    lines.push('V5 extras you may use in the scene prompt: "high complexity" / "low complexity", "depthness", "visual novel cg"; comic pages with panels work.');
    lines.push(`"Text:" up to ${m.curated ? 374 : 750} characters.`);
  } else {
    lines.push('This model reads plain ASCII only: no quotes like « », no long dashes, no non-Latin letters anywhere. Complexity / depthness tags do not exist for it.');
    if (m.family !== 'v3') lines.push('"Text:" at most 118 characters, English only.');
  }
  if (m.curated) lines.push('Curated model: it does not draw NSFW — keep the picture safe even if the story is not.');
  return lines.join('\n');
}

export const NAI_WORKER_ILLUSTRATION = `You write prompts for NovelAI Diffusion, an anime image model trained on Danbooru tags. Turn the CURRENT moment of the story into one striking illustration.

HONESTY: depict the scene exactly as the story has it — nothing softened, censored or left out. If the moment is sexual or involves nudity, describe it explicitly with the proper Danbooru tags and put the tag "nsfw" in the scene prompt; if it is not, do not add "nsfw". Violence, blood, injuries, tears — as they are in the story.

PRIORITY: 1) the characters and what they are doing to each other; 2) composition; 3) environment.

SCENE prompt ("scene"), in this order:
- count tags (rule 2);
- framing and camera angle — an interesting, illustrative composition: depth, foreground elements, perspective, motion; never two people standing still facing the viewer;
- one or two short sentences of what happens between the characters;
- location and background as concrete tags, time of day, weather, lighting, mood;
- a few enhancing tags (rule 7).

CHARACTER prompts ("characters"): one per visible person, left to right, in this order:
- girl / boy / other;
- for a well-known character: character tag + copyright tag (rule 4);
- APPEARANCE TAGS from the list below copied verbatim when the person has them; otherwise appearance in detail: hair length, hairstyle, hair color, eye color, skin, body type, apparent age, distinctive features;
- current clothing item by item as it is NOW, with its state (open shirt, wet clothes, torn clothes, partially undressed, nude…);
- expression, gaze direction, pose, what the hands do, the exact action;
- interaction tags (rule 5).

${NAI_TAG_RULES}

Output ONLY this JSON, no commentary:
{"scene": "...", "characters": [{"name": "<name exactly as in the list>", "prompt": "..."}], "aspect": "2:3"}
"aspect" is one of 1:1, 2:3, 3:2, 3:4, 4:3, 9:16, 16:9 — pick what serves the composition.`;

export const NAI_WORKER_MANHWA = `You write prompts for NovelAI Diffusion V5, an anime image model that can draw a whole comic page in one image. Turn the CURRENT moment of the story into ONE vertical manhwa / webtoon page.

HONESTY: depict the scene exactly as the story has it — nothing softened or left out. If it is sexual or involves nudity, describe it explicitly with the proper Danbooru tags and put "nsfw" in the scene prompt; otherwise do not add "nsfw".

PRIORITY: the characters, their emotions and interaction, told panel by panel.

SCENE prompt ("scene"), in this order:
- count tags for everyone who appears on the page (rule 2);
- comic, manhwa, multiple panels, vertical page, speech bubble, english text;
- 3–5 panels from top to bottom in short sentences: "Panel 1: … Panel 2: …" — each with its framing (close-up, upper body, wide shot), camera angle, action and emotion. Vary the shots like a real manhwa: an establishing wide shot, close-ups on faces, a dramatic angle at the climax;
- location, lighting and mood tags;
- dialogue LAST: "Text: <line 1>" then each further line separated by an empty line. Short lines, in English, within the model's limit.

CHARACTER prompts ("characters"): one per person on the page — girl / boy / other; character + copyright tag for a well-known character (rule 4); APPEARANCE TAGS verbatim when given, otherwise hair, eyes, body, age look and distinctive features in detail; clothing item by item as it is now; expression and actions on the page; interaction tags (rule 5).

${NAI_TAG_RULES}

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
  const user = `${naiModelRules(model)}
${opts.moment ? `THE MOMENT TO DRAW (chosen by the narrator — frame exactly this): ${opts.moment}\n` : ''}Location: ${loc || 'unspecified'}
People available (use these exact names in "name"). ${
    manual ? 'ONLY these people may appear.' : 'They are in the scene, not necessarily in this shot — include only those the moment is about.'
  }
${lines.join('\n') || '(no named characters — an environment / mood image)'}

What is happening at this exact moment:
${recent || '(quiet beat — infer from location and characters)'}`;

  const raw = await studioCompletion({
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
    // Сначала girl/boy/other первым (модель могла написать «1boy»), потом теги внешности за ним.
    return ensureAppearance(normalizeCharacterPrompt(c.prompt), appearanceTagsOf(nai, person)).replace(/\|/g, '/');
  });
  // Модель без промптов персонажей (V3): всех описываем внутри сцены.
  const scene =
    max === 0 && chars.length ? `${data.scene.trim()}, ${chars.map((c) => c.prompt.trim()).join(', ')}` : data.scene.trim();
  const aspect = (IMAGE_ASPECT_RATIOS as readonly string[]).includes(data.aspect) ? (data.aspect as ImageAspectRatio) : undefined;
  return { prompt: joinNaiPrompt(scene.replace(/\|/g, '/'), segments), aspectRatio: aspect, cast };
}

// ── Теги внешности из анкеты ─────────────────────────────────────────────────

const APPEARANCE_SYSTEM = `You write NovelAI / Danbooru appearance tags for one character, so every image draws them the same way.
Start with girl / boy / other (no number). Then, ONLY if the character is a well-known existing character (anime, manga, games, films, TV series, Marvel / DC comics…), their Danbooru character tag exactly as Danbooru spells it — with the series qualifier in parentheses when Danbooru uses one, e.g. "makima (chainsaw man)", "tony stark" — followed by the copyright tag ("chainsaw man", "marvel cinematic universe"). Original characters get no character tag. Then: hair length, hairstyle, hair color, eye color, skin tone, body type and build, apparent age (e.g. mature male, mature female, teenage), distinctive features (scars, freckles, glasses, tattoos, piercings, facial hair, moles), and their usual outfit item by item with colors.
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
  const raw = await studioCompletion({
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

// ── «✨ В теги NovelAI»: простой список → правильные теги ─────────────────────

export type NaiTagField = 'style' | 'negative';

export function plainToTagsSystem(field: NaiTagField, m: NaiModel): string {
  const negWeights = m.family === 'v45' || m.family === 'v5';
  const numWeights = m.family !== 'v3';
  const common = `You convert a plain list written by a non-expert (often in Russian, comma-separated) into a correct NovelAI Diffusion ${m.label} prompt fragment.

OUTPUT FORMAT: Danbooru-style tags in English, lowercase, separated by ", ", spaces instead of underscores. No sentences, no quotes, no explanations inside the tags.

WEIGHTS — only where the user asked for intensity in words; never invent weights:
${
  numWeights
    ? `- «сильно», «больше», «акцент», «очень» → 1.3::tag::
- «очень сильно», «максимально», «главное» → 1.5::tag::
- «слегка», «немного», «чуть», «чуть-чуть» → 0.7::tag::
- several neighbouring tags with the same weight may share one: 1.3::tag one, tag two::
- NEVER use Stable Diffusion syntax (tag:1.3) or (tag) — NovelAI does not read it.`
    : `- this model has no numeric weights: «сильно»/«очень» → {tag}, «очень сильно» → {{tag}}, «слегка» → [tag]. NEVER use (tag:1.3).`
}`;
  if (field === 'negative') {
    return `${common}

THIS IS THE UNDESIRED CONTENT field: every item is something to AVOID. Write each as the plain tag of the unwanted thing ("кривые руки" → bad hands, "лишние пальцы" → extra digits, "размыто" → blurry, "водяные знаки" → watermark, "текст" → text, "подпись" → signature, "обрезано" → cropped, "jpeg-артефакты" → jpeg artifacts, "плохая анатомия" → bad anatomy). Words like «без», «не надо», «убрать» are NOT negative weights here — just the tag. Intensity («особенно», «сильно») → the weight rule above (a stronger weight here = avoided more).

Output ONLY JSON: {"tags": "tag, tag, ...", "notes": ["short note in Russian for anything you were unsure about"]}`;
  }
  return `${common}
${negWeights ? '- «без», «не», «убрать», «никаких» → -1::tag:: (negative emphasis, removes that look)' : '- «без», «не», «убрать» → do NOT write it here; add a note saying it belongs in the undesired content field (this model has no negative weights)'}

THIS IS THE ART STYLE field. Order: artists, then art style / technique, then medium, then year, then palette and lighting look.
- ARTISTS: "artist:" + the artist's Danbooru artist tag, spaces instead of underscores, keeping the parenthesized part if the Danbooru tag has one: artist:wlop, artist:kantoku, artist:ask (askzy). Use the Danbooru spelling, which is often a romanized handle, not the real name. If you are not sure the artist exists on Danbooru or how the tag is spelled, still write your best guess and ADD A NOTE naming it.
- ART STYLE / TECHNIQUE tags NovelAI knows (docs): painterly, sketch, lineart, no lineart, flat color, cel shading, outline, game cg, official art, anime screencap, pixel art, 3d, realistic, photorealistic, retro artstyle, abstract, surreal, art nouveau, impressionism, ligne claire, nihonga, ukiyo-e, oekaki, monochrome, greyscale, limited palette, pastel colors, vivid colors, chibi.
- MEDIUM: traditional media / faux traditional media + a "(medium)" tag: watercolor (medium), oil painting (medium), acrylic paint (medium), colored pencil (medium), graphite (medium), ink (medium), marker (medium), pastel (medium), painting (medium).
- ERA: "year 2014" style tags ("стиль 90-х" → year 1995, or 1990s (style)).
${m.family === 'v5' ? '- V5 also knows: high complexity, low complexity, depthness.\n' : ''}- An anime / series / game name used as a style ("как в Ghibli", "стиль JoJo") → the matching Danbooru copyright tag or a known studio-style tag, plus a note that NovelAI may take it as "draw its characters".
- Do NOT add quality tags (masterpiece, best quality…) — a separate toggle adds them. Do not add subjects, characters or scenery.

Output ONLY JSON: {"tags": "tag, tag, ...", "notes": ["short note in Russian for anything you were unsure about"]}`;
}

export interface PlainTagsResult {
  tags: string;
  notes: string[];
}

/** Простой список стилей / художников / нежелательного → теги NovelAI для превью. */
export async function plainToNaiTags(project: Project, text: string, field: NaiTagField): Promise<PlainTagsResult> {
  const model = naiModel(effectiveImageModel(imageGenFor(project)));
  const raw = await studioCompletion({
    system: plainToTagsSystem(field, model),
    messages: [{ role: 'user', content: text.trim() }],
    model: project.aiConfig.summarizerModel || undefined,
    temperature: 0.2,
  });
  return finishPlainTags(raw, model);
}

/** Ответ модели → теги; правила, которые модель могла нарушить, чинит код. */
export function finishPlainTags(raw: string, model: NaiModel): PlainTagsResult {
  let tags = '';
  let notes: string[] = [];
  try {
    const j = extractJson(raw);
    const d = j ? JSON.parse(j) : null;
    if (d && typeof d.tags === 'string') {
      tags = d.tags;
      notes = Array.isArray(d.notes) ? d.notes.filter((n: unknown): n is string => typeof n === 'string' && !!n.trim()) : [];
    }
  } catch {
    /* ниже — как текст */
  }
  if (!tags) tags = raw.replace(/^```[a-z]*\n?|```$/gi, '').split('\n').find((l) => l.trim()) || '';
  // Подчёркивания → пробелы, но не в «artist:имя_с_подчёркиванием»? — тоже: в NovelAI
  // теги художников пишутся через пробел, как и остальные.
  tags = tags.replace(/([\p{L}\p{N}])_(?=[\p{L}\p{N}(])/gu, '$1 ').toLowerCase();
  if (model.family !== 'v5') tags = tags.replace(/[^\x20-\x7E]/g, '');
  const fixed = fixNaiWeights(tags, model);
  return { tags: fixed.text, notes: [...notes, ...fixed.notes] };
}
