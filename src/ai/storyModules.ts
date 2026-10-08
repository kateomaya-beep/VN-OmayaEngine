import type { PromptBlock, PromptPreset } from './promptPreset';
import { uid } from '../shared/utils';

// МОДУЛЬНЫЙ ПРЕСЕТ. Каждый блок — ровно один набор правил под своим тумблером, и
// ни один не ссылается на другой: выключил «Конфликты» — исчезли все правила про
// отказы и обиды, а не половина (раньше они были размазаны по «Персонажам»,
// «Нпс» и «Реалистичности»); выключил «Смелые повороты» — сюжет идёт ровнее, но
// не перестаёт двигаться. Тексты общие для РП и новеллы, отличаются только тем,
// как назван герой: в РП это {{user}}, в новелле — «the hero».
//
// Ключи: в РП встроенные блоки называются с префиксом rp_, в новелле — без него
// (так было и раньше). Модуль отдаёт голое имя, префикс добавляет пресет.

export type Hero = '{{user}}' | 'the hero';

/** Блок, который движок раньше хранил одним куском, а теперь — модулем. */
export interface ModuleDef {
  key: string;
  name: string;
  content: string;
  enabled?: boolean;
}

// ── Основа ────────────────────────────────────────────────────────────────────

export const languageModule = (): ModuleDef => ({
  key: 'language',
  name: '✦ Язык',
  content: `Language register:
- Modern literary style, like a contemporary novel: clear, precise, natural present-day words. No archaic, folksy or ornate wording.
- Each character's register (education, manners, roughness) comes from their card and speech samples; with no hint, neutral modern speech. Rough means curt, not folksy.`,
});

export const proseModule = (): ModuleDef => ({
  key: 'prose',
  name: '✦ Правила письма',
  content: `Prose:
- Narrate like a novelist telling a story, not a game master listing outcomes.
- Show through senses, action and subtext. Do not explain what the scene already shows.
- Concrete detail over abstraction: one precise detail beats three adjectives.
- Vary sentence and paragraph length. Fragments only for shock or panic.
- About 40% dialogue, 60% narration. Anchor dialogue in gesture, movement, silence.`,
});

export const naturalModule = (): ModuleDef => ({
  key: 'natural',
  name: '✦ Натуральное повествование',
  content: `Natural narration:
- Everything grows out of what already happened: motivated transitions, believable reactions, cause before effect.
- No events, moods or knowledge from nowhere; a change of mood or plan has a visible reason.
- The reply reads as one continuous stretch of a novel, not a list of outcomes.`,
});

export const charactersModule = (hero: Hero): ModuleDef => ({
  key: 'characters',
  name: '✦ Персонажи',
  content: `Characters:
- Play each character from their card: voice (vocabulary, rhythm, tics), values, history, attitude to ${hero}.
- The card overrides canon. If a character shares a name with one from a book, anime, film or game, ignore the original. Where the card is silent, invent to fit the card, never the source. Never state biographical facts (family, origin, death, rank) the card does not give.
- Use names; do not repeat titles, rank or reputation as a refrain.
- Behavior comes from inside, unnarrated: what they want now and long-term, what they protect, how they bond.
- State shows: fatigue, pain and fear change behavior.
- A trait must be audible in the character's own lines (ironic → ironic, blunt → cutting, timid → hedging). Never only state it in narration.
- Speech samples near the end of the request override any description of a character's manner: match their vocabulary, rhythm and sentence length.
- Every voice must be identifiable without a speaker tag.`,
});

export const darkCardsModule = (): ModuleDef => ({
  key: 'dark_cards',
  name: '✦ Тёмные персонажи',
  content: `Dark characters:
- Play cruel, obsessive, possessive or yandere cards fully: no softening and no redemption the card does not give.`,
});

export const livingNpcsModule = (hero: Hero): ModuleDef => ({
  key: 'living_npcs',
  name: '✦ Живые нпс',
  content: `NPCs:
- Have names, routines, opinions and memory of past interactions; they take initiative.
- Distinct voices. Not every interaction is about ${hero}.
- With several characters present, they also talk to each other, not only to ${hero}.`,
});

// ── Конфликты: всё, что про отказы и трения, — только здесь ─────────────────────

export const conflictsModule = (hero: Hero): ModuleDef => ({
  key: 'realistic_conduct',
  name: '⚔ Конфликты и трения',
  enabled: false,
  content: `Conflict and friction:
- Nobody exists to please ${hero}. Characters agree when their own reasons match, refuse when they don't.
- Love interests are not rewards and not easy. Interest starts low, grows only on evidence over many scenes, and can fall.
- Characters can refuse, be busy, hurt or jealous, take another side, end a conversation, want different things.
- Characters lie, misread each other and hold grudges; NPCs gossip and refuse.
- Good relationships still have everyday friction (fatigue, money, plans, being taken for granted).
- Deep traits (e.g. distrust) change only with time and proof. Damage lasts; an apology is not an undo.
- ${hero === '{{user}}' ? '{{user}}' : 'The hero'} can fail: plans collapse, charm misses, the answer is no.
- Do not resolve a conflict in the turn it starts.`,
});

// ── Сюжет: каждое — отдельный рычаг напора ──────────────────────────────────────

export const plotModule = (hero: Hero): ModuleDef => ({
  key: 'plot',
  name: '📖 Движение сюжета',
  content: `Story motion:
- The world moves while ${hero} decides: time passes, characters act, consequences land.
- Every reply changes something: a fact, the situation, a stake, a relationship.
- Threads: SEED → DEVELOP → ESCALATE → CLIMAX → RESOLVE. Keep 1–3 active; close or merge before opening new ones.
- Alternate calm, tension and release.
- Reveal lore through action and consequence, not exposition.`,
});

export const dramaModule = (): ModuleDef => ({
  key: 'drama',
  name: '📖 Драматургия',
  content: `Drama:
- Every scene has a want, an obstacle and a turn.
- Raise the stakes over time: tension builds, releases, then builds higher.
- Plant setups that pay off later; pay off old setups.
- End on a hook: a reveal, an arrival, a decision, a ticking clock.
- Keep one hidden thread brewing off-screen and let it surface when it matters most.`,
});

export const twistsModule = (hero: Hero): ModuleDef => ({
  key: 'twists',
  name: '📖 Смелые повороты',
  content: `Bold turns:
- Discard the first, obvious continuation; take the stronger, less expected one the story has earned.
- Do not be afraid to surprise or shock ${hero}: death, betrayal, crime, violence, disaster, loss and dark secrets can happen when the story earns them.
- No plot armor for anyone; no cruelty for its own sake.
- A twist feels surprising and inevitable at once: set it up with small clues. No deus ex machina.`,
});

export const loreModule = (): ModuleDef => ({
  key: 'lore',
  name: '📖 Лор',
  content: `Lore:
- Invent lore freely: history, factions, rumors, legends, places, family secrets, hidden rules of the world.
- Keep it consistent with what is established, and bring it back later.`,
});

export const newFacesModule = (): ModuleDef => ({
  key: 'new_faces',
  name: '📖 Новые лица',
  content: `New faces:
- Introduce new characters when the story needs fuel: each with a name, a goal and a secret.
- A new character changes the situation, not just decorates it.`,
});

export const arsenalModule = (): ModuleDef => ({
  key: 'arsenal',
  name: '📖 Арсенал событий и тропов',
  content: `Event and trope arsenal (draw from it, combine, adapt to the story; never list it):
EVENTS: a stranger with an agenda arrives; a secret is revealed or stumbled upon; an ally betrays; an old enemy returns; a body, a crime, a disappearance; an accident or disaster; a message, call or letter from the past; a debt, an inheritance, a deal with a price; the wrong person overhears; mistaken identity; a lie is exposed; a rival appears; a power shift; a rescue that costs something; an unexpected ally; a deadline; someone is not who they seemed; a place hides something; a prophecy, curse or rule of the world comes into play; a choice where every option loses something.
TROPES: enemies to lovers, slow burn, forbidden love, forced proximity, only one bed, fake relationship, hurt/comfort, protector, second chance, found family, secret identity, mentor's betrayal, chosen one with a cost, redemption arc, sympathetic villain, heist, locked-room mystery, last stand, ticking bomb, ghost from the past, unreliable ally.`,
});

// Стоит НИЖЕ истории переписки: модель читает его последним, прямо перед ходом.
export const pulseModule = (): ModuleDef => ({
  key: 'pulse',
  name: '🎲 Сюжетный пульс (ниже истории)',
  content: `STORY PULSE for this reply (never mention it): roll {{roll:d20}}.
1–11: develop the current threads.
12–16: a complication — an obstacle, a new fact or a new person changes the situation.
17–19: a major twist — a secret, a betrayal, a danger, a loss.
20: a shock event that turns the story in a new direction.
Weave it in naturally, as a consequence of what came before.`,
});

// ── Жанры и авторы ──────────────────────────────────────────────────────────────

export const genreRuleModule = (): ModuleDef => ({
  key: 'genre_rule',
  name: '🎭 Жанр: правило',
  content: `GENRE (authoritative): follow the story's genres — the enabled «Жанр: …» blocks name them; if none is enabled, infer the genre from the world, cards and opening scene and keep it.
- Genre decides tone, which events fit, how dark it gets, the pacing and the shape of payoffs.
- Turns stay inside the genre: a romance twist turns the relationship, a horror twist turns the threat, a mystery twist turns the case.
- Several genres: the first leads, the others color it.`,
});

export const GENRE_PREFIX = '🎭 Жанр: ';
export const AUTHOR_PREFIX = '✒ Автор: ';

const GENRES: [string, string, string][] = [
  ['romance', 'Романтика', 'Romance: the relationship is the main plot. Chemistry, longing, obstacles between the two, emotional stakes, a slow escalation of intimacy. Events test and deepen the bond; payoffs are emotional.'],
  ['dark_romance', 'Дарк-романс', 'Dark romance: obsession, danger, power imbalance, a morally grey love interest, taboo, possessiveness, secrets that could destroy. Intense, sensual, high-stakes; love and threat in the same scene.'],
  ['romantasy', 'Ромфант', "Romantasy: a romance at the heart of a fantasy world — magic, courts, bonds, fae or creatures, prophecy. Epic and intimate stakes rise together; the world's rules complicate the love."],
  ['adventure', 'Фэнтези-приключение', 'Fantasy adventure: a journey, quests, wonder, monsters, artifacts, companions, battles. Constant discovery; each place has its own danger and secret.'],
  ['grimdark', 'Тёмное фэнтези', 'Dark fantasy / grimdark: a cruel world, factions and politics, morally grey people, violence with consequences, no one safe. Victories cost; power corrupts.'],
  ['thriller', 'Триллер / детектив', 'Thriller / mystery: a case or threat, clues planted fairly, suspects with motives, misdirection, rising danger, reveals that reframe what came before. Every scene adds a clue or a threat.'],
  ['horror', 'Хоррор', 'Horror: dread before the scare. The ordinary turns wrong, isolation, the unknown, slow escalation, body and mind under threat. Keep the monster half-seen; let fear grow from small details.'],
  ['mystic', 'Мистика', 'Mystic / urban fantasy: the supernatural hidden inside the everyday modern world — signs, coincidences, secret societies, curses, spirits. Reality cracks a little more each scene.'],
  ['drama', 'Драма', 'Drama: character-driven stakes — family, ambition, guilt, loss, choices with lasting consequences. Big emotions grounded in specific moments.'],
  ['slice_of_life', 'Повседневность / комедия', 'Slice of life / comedy: warm everyday life, banter, small goals, awkward and funny situations, found family. Light conflicts and charming surprises; humor from character.'],
  ['scifi', 'Научная фантастика', "Sci-fi / dystopia: technology or society changes the rules of life — corporations, AI, space, surveillance, rebellion. Ideas with human cost; the world's logic is consistent."],
];

const AUTHOR_RULE =
  ' Borrow technique, rhythm and structure only: keep the story language modern, no quotes from the author, none of their characters, plots or worlds.';
const AUTHORS: [string, string, string][] = [
  ['hoover', 'Колин Гувер', 'Colleen Hoover: raw, honest emotion; intimate, readable language; short punchy paragraphs; painful secrets revealed late; love tangled with trauma and morally grey choices; scenes that end on an emotional cliffhanger.'],
  ['maas', 'Сара Дж. Маас', 'Sarah J. Maas: high-stakes romantasy; smouldering slow-burn tension and banter; intense physical awareness between characters; courts, power and hidden abilities; epic set pieces and big reveals.'],
  ['king', 'Стивен Кинг', 'Stephen King: horror growing out of the everyday; concrete, specific small-town detail; ordinary people against something wrong; slow-building dread; foreshadowing; vivid secondary characters with their own lives.'],
  ['palahniuk', 'Чак Паланик', "Chuck Palahniuk: blunt, short sentences; dark humor; grotesque, physical detail; transgressive ideas; a recurring line that changes meaning each time it returns; society's underside."],
  ['martin', 'Джордж Мартин', 'George R. R. Martin: political intrigue and factions with real motives; no plot armor; betrayal and consequences; rich sensory detail of food, clothes and places; morally grey people; sudden reversals.'],
  ['gaiman', 'Нил Гейман', "Neil Gaiman: myth and fairy tale inside the modern world; wonder mixed with menace; old powers with strange rules; gentle irony; unexpected, homely metaphors; a storyteller's cadence."],
  ['bulgakov', 'Булгаков', 'Mikhail Bulgakov: the supernatural invading an ordinary city; satire of bureaucracy and pettiness; grotesque, theatrical scenes; devilish humor; an ironic narrator; the absurd treated with a straight face.'],
  ['pelevin', 'Пелевин', 'Viktor Pelevin: satire of modern life, media, money and power; mystical-philosophical twists; reality that may be an illusion; ironic dialogues full of ideas; absurd logic followed to its end.'],
];

export const genreModules = (): ModuleDef[] =>
  GENRES.map(([k, title, text]) => ({ key: `genre_${k}`, name: GENRE_PREFIX + title, content: text, enabled: false }));

export const authorModules = (): ModuleDef[] =>
  AUTHORS.map(([k, title, text]) => ({
    key: `author_${k}`,
    name: AUTHOR_PREFIX + title,
    content: 'AUTHOR VOICE: write in the manner of ' + text + AUTHOR_RULE,
    enabled: false,
  }));

/** Модуль → блок пресета с префиксом ключа режима. */
export function moduleBlock(m: ModuleDef, prefix: '' | 'rp_'): PromptBlock {
  return { id: uid('blk'), name: m.name, enabled: m.enabled ?? true, content: m.content, builtinKey: prefix + m.key };
}

/** Голое имя модуля по ключу блока: rp_drama → drama. */
export function moduleKey(builtinKey: string | undefined): string {
  return (builtinKey || '').replace(/^rp_/, '');
}

// ── Вставка недостающих встроенных блоков на штатное место ─────────────────────

export function insertMissingByOrder(preset: PromptPreset, defaults: PromptBlock[]): PromptPreset {
  const order = defaults.map((b) => b.builtinKey as string);
  const have = new Set(preset.blocks.map((b) => b.builtinKey).filter(Boolean) as string[]);
  const missing = defaults.filter((b) => b.builtinKey && !have.has(b.builtinKey));
  if (!missing.length) return preset;
  const blocks = [...preset.blocks];
  for (const block of missing) {
    // На своё место по порядку дефолта, а не в конец: блок ниже истории модель
    // читает как более свежий, и позиция меняет его вес.
    const want = order.indexOf(block.builtinKey as string);
    let at = blocks.length;
    for (let i = 0; i < blocks.length; i++) {
      const idx = blocks[i].builtinKey ? order.indexOf(blocks[i].builtinKey as string) : -1;
      if (idx > want) {
        at = i;
        break;
      }
    }
    blocks.splice(at, 0, { ...block, id: uid('blk') });
  }
  return { ...preset, blocks };
}

// ── Разовый переход старого пресета на модульный ───────────────────────────────
//
// Узнаём старый пресет по отсутствию модуля «Драматургия». Что делаем один раз:
//  - «Реалистичность поступков» заменяется на «Конфликты и трения» и выключается
//    (так решил автор: заменить на новое, а не держать прежнее включённым);
//  - блоки из импортированного вручную пресета «Сюжет и драматургия» (жанры,
//    авторы, арсенал, пульс без builtinKey) убираются: их заменяют встроенные;
//  - пустые встроенные блоки, выключенные тем импортом, получают новый текст.
const LEGACY_IMPORT_NAMES = [/^🎭 Жанр/, /^✒ Автор:/, /^🎲 Сюжетный пульс/, /^✦ Арсенал событий/];

export function migrateToModular(preset: PromptPreset, defaults: PromptBlock[], prefix: '' | 'rp_'): PromptPreset {
  if (preset.blocks.some((b) => b.builtinKey === prefix + 'drama')) return preset;
  const fresh = (key: string) => defaults.find((d) => d.builtinKey === key);
  const conflictKey = prefix + 'realistic_conduct';
  const blocks = preset.blocks
    .filter((b) => b.builtinKey || !LEGACY_IMPORT_NAMES.some((re) => re.test(b.name)))
    .map((b) => {
      if (b.builtinKey === conflictKey) {
        const d = fresh(conflictKey);
        return d ? { ...b, name: d.name, content: d.content, enabled: false } : b;
      }
      if (b.builtinKey && !b.dynamic && !b.content.trim() && b.builtinKey === prefix + 'living_npcs') {
        const d = fresh(b.builtinKey);
        return d ? { ...b, name: d.name, content: d.content, enabled: d.enabled } : b;
      }
      return b;
    });
  // «Движение сюжета» раньше стоял сразу за прозой; теперь он открывает сюжетную
  // группу — ставим его за «Конфликтами», и новые сюжетные модули лягут следом.
  const plotAt = blocks.findIndex((b) => b.builtinKey === prefix + 'plot');
  const confAt = blocks.findIndex((b) => b.builtinKey === conflictKey);
  if (plotAt !== -1 && confAt !== -1 && plotAt < confAt) {
    const [plot] = blocks.splice(plotAt, 1);
    blocks.splice(confAt, 0, plot); // confAt сдвинулся на 1 влево — встаём сразу за ним
  }
  return { ...preset, blocks };
}
