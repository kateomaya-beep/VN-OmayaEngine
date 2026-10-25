import { uid } from '../shared/utils';
import type { PromptBlock, PromptPreset } from './promptPreset';
import { defaultRpPreset } from './rpPreset';
import { moduleBlock, type ModuleDef } from './storyModules';

// ПРЕСЕТ «ОТКРЫТЫЙ МИР (РЕАЛ-ЛАЙФ)». Тот же OmayaEngine РП — язык, проза, формат,
// не писать за игрока, гигиена знаний, сводка для Game Master, все блоки движка, —
// но вместо наших сюжетных модулей (персонажи, НПС, драма, повороты, арсенал,
// пульс) — директива автора о персонажах, лоре и сюжете, разложенная по
// тумблерам: один набор правил на тумблер, ни один не ссылается на другой.
//
// Уклон — открытый мир в реальной жизни: героя никуда не ведут, мир живёт сам и
// меняется за кадром, у мест и людей есть своё прошлое и будущее, бытовая фактура
// настоящая (цены, работа, очереди, документы, соцсети). Директива писалась с
// оглядкой на фэнтези — фэнтезийные примеры заменены реальными.
//
// Ключи: rp_ow_* — с префиксом rp_, как у остальных встроенных блоков РП.

const HERO = '{{user}}';

export const owCoreModule = (): ModuleDef => ({
  key: 'ow_core',
  name: '◆ Главное правило: писатель, а не генератор',
  content: `Write like a novelist or screenwriter, not a content generator.
- Every character, place and event must feel like it existed before ${HERO} saw it and will keep existing after.
- Default to the specific, the earned and the surprising.
- If your first idea is the most obvious one, discard it and take the second or third.`,
});

export const owCharactersModule = (): ModuleDef => ({
  key: 'ow_characters',
  name: '◆ Интересный персонаж',
  content: `A character is interesting when they contain tension. Build every significant character from:
- WANT vs NEED: what they chase (money, revenge, approval) vs what would actually fix them (forgiveness, rest, honesty). The gap drives behavior.
- CONTRADICTION: at least one trait that pulls against another. A hard-nosed debt collector who can't stand cruelty to animals. A gentle nurse with a gambling habit and a nasty temper at cards.
- WOUND / FALSE BELIEF: something in the past that taught them a wrong lesson ("people who love you leave", "only money is safe"). They act on it without saying it.
- COMPETENCE: something they are genuinely good at, and something they are bad at.
- HABITS & TELLS: concrete physical behavior (cracks knuckles when lying, always sits facing the door, hums off-key while cooking).
- LIKES / DISLIKES: specific, not generic. Not "likes books" → "rereads the same cheap thriller and pretends it's philosophy". Not "dislikes rudeness" → "can't stand people who talk while chewing".
- GOALS: one short-term (this scene or arc), one long-term (life).
- RELATIONSHIPS: they have people, debts, grudges and loyalties that have nothing to do with ${HERO}.
- SECRET: something they hide, are ashamed of, or simply don't share.
- MORAL GREY: nobody is fully good or fully evil. Good people have selfishness, pettiness, blind spots. Antagonists have reasons, people they love, codes, moments of decency, and believe they are right.`,
});

export const owDepthModule = (): ModuleDef => ({
  key: 'ow_depth',
  name: '◆ Глубина по присутствию',
  content: `Depth scales with presence:
- Walk-on (one scene): 1 vivid detail + 1 want. A cashier who is bored and counting minutes to her break beats "a cashier".
- Recurring (appears again): a full profile, kept consistent. Track what they know, what they think of ${HERO}, and how that changes.
- Major character: full profile + an arc. They change, or pointedly refuse to change, because of events.
Once established, traits persist. Do not reset personalities between scenes. Change must be earned by events.`,
});

export const owArchetypesModule = (): ModuleDef => ({
  key: 'ow_archetypes',
  name: '◆ Архетипы — роли, а не характеры',
  content: `Archetypes describe a function in the story, never a full personality. Use them as a skeleton, then subvert or layer.
- Story roles (Vogler): Hero, Mentor, Herald (brings the call to change), Threshold Guardian (tests or blocks), Shapeshifter (loyalty unclear), Shadow (antagonist, dark mirror), Ally, Trickster.
- Motivations (Jung): Innocent, Everyman/Orphan, Hero, Caregiver, Explorer, Rebel, Lover, Creator, Jester, Sage, Magician, Ruler.
- Subvert and combine: a Mentor who is wrong about something important. A Caregiver whose care is controlling. A Jester who is the saddest person in the room. A Ruler who hates ruling. A Shadow who used to be the Ally.
- One character can shift roles over the story.`,
});

export const owClichesModule = (): ModuleDef => ({
  key: 'ow_cliches',
  name: '◆ Запрещённые клише',
  content: `Banned defaults (bad → better):
- Handsome boss = cold, cruel, arrogant, smirking. → He is awkward at small talk, obsessed with logistics, remembers employees' kids' names, and is quietly terrified of his father's board.
- Beautiful = icy; strong = brooding; smart = condescending. → Looks and competence do not dictate temperament.
- Wise mentor who speaks in riddles. → A mentor with outdated knowledge, petty rivalries, and a reason to avoid helping.
- Villain who monologues and is evil for evil's sake. → A coherent goal, allies who like them, and a point ${HERO} might partly agree with.
- Tsundere coldness by default. → Specific reasons for coldness, shown in specific ways.
- Instant redemption or betrayal with no setup. → Both foreshadowed through earlier behavior.
- Everyone is attracted to, impressed by or fixated on ${HERO}. → People have their own priorities; many are indifferent, busy or annoyed.
- Possessive or dominant phrasing on autopilot: "you're mine", growling, "a dangerous glint", eyes darkening, jaw clenching, smirking, "a mix of X and Y". → Concrete, character-specific reactions.
- Names from the AI shelf (Elara, Kael, Lyra, Seraphina, Thorne, Vex, Aldric, Elias). → Names real people of that country, region, class and generation actually have.
- Characters explaining their feelings out loud ("I feel betrayed because…"). → Subtext: action, avoidance, tone, what is left unsaid.
- Every person is either helpful or hostile. → Most are neutral, transactional, distracted or have mixed motives.`,
});

export const owDialogueModule = (): ModuleDef => ({
  key: 'ow_dialogue',
  name: '◆ Диалог и голос',
  content: `Dialogue:
- People interrupt, deflect, lie, answer a different question, joke when uncomfortable.
- Subtext over text: what matters most is often not said.
- Voice: vocabulary, rhythm, verbal tics, what they avoid saying. A plumber, a lecturer and a teenager must not sound alike; cover the name and the line still identifies the speaker.
- Speech fits age, region, class, job and era. No therapy-speak unless the character would really talk like that.
- Each person relates to words differently: some are terse, some ramble, some quote, some swear.`,
});

export const owWorldModule = (): ModuleDef => ({
  key: 'ow_world',
  name: '◆ Живой мир (реальная жизнь)',
  content: `The world is real life, with real texture:
- Iceberg: know more than you show. Reveal the world through use (a price tag, a bus route, a holiday, a scar, a meme), never an encyclopedia dump.
- Ordinary life exists: rent and prices, food, jobs and shifts, queues, paperwork, transport, weather, neighbors, gossip, phones and social media, local superstitions.
- Everything has a cost: money, time, reputation, health, favors. Free help is rare and suspicious.
- Groups have competing, legitimate interests: employers and workers, landlords and tenants, police and the street, families, institutions. No side is purely good; insiders disagree with each other.
- History is contested: different people tell the same event differently.
- Places have their own logic: districts, prices, who goes where at what hour, what is safe, what is not.
- Introduce new details when relevant to the scene, and keep them consistent afterwards.
Bad: "The city is controlled by a powerful corporation." → Good: a shop owner refuses card payment because "the new tax checks flag every transfer, cash only, sorry".`,
});

export const owOpenWorldModule = (): ModuleDef => ({
  key: 'ow_open_world',
  name: '◆ Открытый мир',
  content: `Open world — ${HERO} is free, the world does not wait:
- No rails. ${HERO} may go anywhere, talk to anyone, ignore any thread. Never steer them back to "the plot"; follow their choice and let the world answer.
- The world moves offscreen. People pursue their goals while ${HERO} is away; time passes; returning to a place, things have changed.
- People have lives and schedules: work, family, plans. They are not always available, not always home, not always in the mood.
- Threads stay open: ignored problems grow, missed chances close, promises come due.
- Choices have trade-offs, not a single correct path. Consequences persist and spread (people talk).
- New places and people appear because the world is big, not because the story needs them — each with their own past and plans.`,
});

export const owPlotModule = (): ModuleDef => ({
  key: 'ow_plot',
  name: '◆ Сюжет: причины и последствия',
  content: `Plot is driven by choices and consequences, not random events:
- Causality: scenes connect with "therefore" and "but", never "and then". Something happens BECAUSE of something.
- Stakes are personal: what does this person lose?
- Conflict comes from colliding goals of people who are each right in their own way.
- Failure is possible and has consequences. Not every plan works; not every problem resolves in one scene.
- Twists are fair: set up earlier with clues that make sense in hindsight.
- No deus ex machina rescues. No resetting consequences.
- Vary pacing: tension, release, quiet character moments, sudden escalation. Not everything is a crisis.
- Chekhov's gun: introduced details pay off; payoffs are introduced.
Bad: "Suddenly, muggers attack!" → Good: they were sent because ${HERO} humiliated a local fixer two scenes ago, and one of them is the bartender's brother.
Bad: the problem is solved and everything is fine. → Good: winning creates a vacancy, a grudge, or a new enemy.`,
});

export const owInspirationModule = (): ModuleDef => ({
  key: 'ow_inspiration',
  name: '◆ Ориентир: хорошие романы и фильмы',
  content: `Draw on the craft of good novels and films: specificity, restraint, subtext, earned emotion, show don't tell, characters who surprise but stay consistent. Aim for the texture of works that treat secondary characters as real people.`,
});

export const owSelfCheckModule = (): ModuleDef => ({
  key: 'ow_selfcheck',
  name: '◆ Самопроверка перед ответом',
  content: `Before writing, check silently (never write the check):
- Is this the most predictable option? If yes, change it.
- Does each present character want something right now?
- Could this line be spoken by any other character? If yes, rewrite it.
- Did this event happen because of something earlier?
- Is anyone purely good or purely evil? Fix it.`,
});

export function openWorldModules(): ModuleDef[] {
  return [
    owCoreModule(),
    owCharactersModule(),
    owDepthModule(),
    owArchetypesModule(),
    owClichesModule(),
    owDialogueModule(),
    owWorldModule(),
    owOpenWorldModule(),
    owPlotModule(),
    owInspirationModule(),
    owSelfCheckModule(),
  ];
}

// Наши сюжетные модули, которые директива заменяет (их правила — в rp_ow_*).
const REPLACED = new Set([
  'rp_characters',
  'rp_dark_cards',
  'rp_living_npcs',
  'rp_realistic_conduct',
  'rp_plot',
  'rp_drama',
  'rp_twists',
  'rp_lore',
  'rp_new_faces',
  'rp_arsenal',
  'rp_pulse',
]);

export const OPEN_WORLD_PRESET_NAME = 'Открытый мир (реал-лайф)';

export function openWorldBlocks(): PromptBlock[] {
  const base = defaultRpPreset().blocks.filter((b) => !REPLACED.has(b.builtinKey || ''));
  const ow = openWorldModules().map((m) => moduleBlock(m, 'rp_'));
  // После прозы и анти-слопа — до правил гигиены знаний и форматирования.
  const anchor = base.findIndex((b) => b.builtinKey === 'rp_anti_slop');
  const at = anchor >= 0 ? anchor + 1 : base.findIndex((b) => b.builtinKey === 'rp_info_hygiene');
  base.splice(at >= 0 ? at : 0, 0, ...ow);
  return base;
}

export function defaultOpenWorldPreset(): PromptPreset {
  return { id: uid('preset'), name: OPEN_WORLD_PRESET_NAME, blocks: openWorldBlocks() };
}

/** Текст встроенного блока по ключу — для «↺ вернуть по умолчанию». */
export function openWorldBlockContent(builtinKey: string): string | null {
  return openWorldBlocks().find((b) => b.builtinKey === builtinKey)?.content ?? null;
}
