import type { PromptBlock } from './promptPreset';
import { AUTHOR_PREFIX, GENRE_PREFIX, moduleKey } from './storyModules';

// ПЛАН РАЗМЫШЛЕНИЯ ИЗ ТУМБЛЕРОВ. Раньше план был одним зашитым текстом, и он жил
// своей жизнью: выключаешь в пресете «Реалистичность», а шаг «кто не идёт
// навстречу герою» в плане остаётся — и модель всё равно ищет, с кем поссориться.
// Теперь каждый шаг принадлежит своему блоку: блок включён — шаг есть, выключен —
// шага нет. Включённые жанры и авторы попадают в план по именам, и модель на
// каждом ходу сверяется именно с ними.
//
// Свой план автора (поле в панели) этим не трогается: он уходит как написан.

export interface PlanInput {
  mode: 'rp' | 'vn';
  profile?: string;
  blocks: PromptBlock[];
  /** Есть ли список стоп-слов: без него шаг про них проверял бы пустоту. */
  banWords: boolean;
  /** Короткая версия — для многословных «всегда думающих» (Kimi, GLM). */
  compact?: boolean;
}

export function composeThinkingPlan(inp: PlanInput): string {
  const rp = inp.mode === 'rp';
  const hero = rp ? '{{user}}' : 'the hero';
  const enabled = inp.blocks.filter((b) => b.enabled && b.builtinKey);
  const on = new Set(enabled.map((b) => moduleKey(b.builtinKey)));
  const genres = enabled.filter((b) => /(^|_)genre_/.test(b.builtinKey!) && !b.builtinKey!.endsWith('genre_rule')).map((b) => b.name.replace(GENRE_PREFIX, '').trim());
  const authors = enabled.filter((b) => /(^|_)author_/.test(b.builtinKey!)).map((b) => b.name.replace(AUTHOR_PREFIX, '').trim());
  const ds = rp && inp.profile === 'deepseek';
  const world = [
    on.has('lore') ? 'a piece of lore' : '',
    on.has('new_faces') ? 'a new face' : '',
    on.has('arsenal') ? 'an event or trope from the arsenal' : '',
  ].filter(Boolean);
  const genreLine =
    genres.length || authors.length
      ? `${genres.length ? `genre ${genres.join(', ')}` : ''}${genres.length && authors.length ? ' · ' : ''}${authors.length ? `voice of ${authors.join(', ')}` : ''}`
      : on.has('genre_rule')
        ? "the story's genre"
        : '';
  const steps: string[] = [];
  const add = (cond: unknown, line: string) => {
    if (cond) steps.push(line);
  };

  if (inp.compact) {
    add(true, 'SCENE: who is here now; what changes.');
    add(true, rp
      ? `SAID vs THOUGHT: what ${hero} said aloud vs only thought (thoughts are not heard).`
      : 'PUBLIC vs PRIVATE: what the hero made visible or audible; narration and thought beats are not heard.');
    add(on.has('info_hygiene'), 'KNOWLEDGE: anyone about to use a fact they could not know → fix.');
    add(on.has('realistic_conduct'), `FRICTION: who does not simply go along with ${hero}, and why.`);
    const story = [
      on.has('plot') ? 'what changes' : '',
      on.has('drama') ? 'the hook' : '',
      on.has('twists') ? 'the less obvious option' : '',
      on.has('pulse') ? 'the pulse roll' : '',
      world.length ? 'lore / new face / arsenal if it serves' : '',
    ].filter(Boolean);
    add(story.length, `STORY: ${story.join('; ')}.`);
    add(genreLine, `GENRE: fits ${genreLine}?`);
    add(true, rp
      ? `TURN: first beat (not a retelling of ${hero}'s move) → shift → stop at ${hero}'s move.`
      : 'TURN: first beat → shift → where it stops.');
    add(rp ? on.has('format') : on.has('json_contract'), rp
      ? `FORMAT: «» quotes, ${hero} = "you", nothing written for ${hero}.`
      : 'OUTPUT: one valid JSON object per the schema, nothing outside it.');
    return number(steps);
  }

  // Разбор собственного прошлого ответа — у DeepSeek свои блоки на это, и шаги
  // идут первыми: до них модель не считает, что повторяется.
  add(ds && on.has('ds_anti_repetition'), 'LAST REPLY: 2–3 exact phrases or images I used, and its opening and ending. All banned this turn.');
  add(ds && on.has('ds_anti_echo'), `OPENING: the first thing ${hero} does not know yet. Never a retelling of their move.`);
  add(ds && on.has('ds_anti_template'), 'SHAPE: how this turn is built differently from the last (opening, ending).');
  add(!ds && on.has('anti_slop'), 'LAST REPLY: 2–3 exact phrases or images I used and its opening and ending. All banned this turn.');
  add(!ds && on.has('anti_slop'), `ECHO: does my opening retell or mirror ${hero}'s move? If so, open where the world answers.`);
  add(inp.banWords, 'BAN LIST: any banned word or phrase about to appear → its replacement, or "clean".');
  add(true, 'SCENE: place, time, who is here, what each is doing and wearing; only what changes now.');
  add(on.has('characters'), 'WANTS: what each present character wants right now and what they hide.');
  add(true, rp
    ? `SAID vs THOUGHT: what ${hero} said or did out loud vs only thought. Thoughts are not heard.`
    : "PUBLIC vs PRIVATE: what the hero's move made visible or audible; narration and thought beats are not heard.");
  add(on.has('info_hygiene'), "KNOWLEDGE: for each acting character, the fact they use and its source (witnessed / told in a scene / tags / common knowledge). No source → they don't know; adjust.");
  add(on.has('living_npcs'), 'INITIATIVE: who acts on their own this turn, and what they want.');
  add(on.has('realistic_conduct'), `FRICTION: who does not simply go along with ${hero}, and why ("nobody" only if earned).`);
  add(on.has('plot'), 'CHANGE: what is different by the end of this reply (a fact, the situation, a stake, a relationship)?');
  add(on.has('drama'), "DRAMA: the scene's want → obstacle → turn; a setup to plant or pay off; the hook to end on.");
  add(on.has('twists'), 'TWIST: the obvious continuation → the stronger, less expected one the story has earned.');
  add(on.has('pulse'), 'PULSE: the STORY PULSE roll → what kind of event it means, grown from what came before.');
  add(world.length, `WORLD: which ${world.join(' / ')} serves this reply, or "none".`);
  add(genreLine, `GENRE: does the reply fit ${genreLine}; which of its techniques this time?`);
  add(true, rp
    ? `TURN: first beat (not a retelling of ${hero}'s move), the shift, where it stops (at ${hero}'s move).`
    : 'TURN: first beat, the shift, where it stops.');
  add(!rp && on.has('relationships'), 'STATE: stat or relationship changes, or "none".');
  add(!rp && on.has('rules'), 'CHOICE: the choices this turn, per the CHOICES rule.');
  add(rp ? on.has('format') : on.has('json_contract'), rp
    ? `FORMAT: one quote style; 'single' inside speech; ${hero} = "you"; italics only for thoughts; no dash before speech; nothing written for ${hero}. "ok" or the fix.`
    : `FORMAT: one JSON object per schema; every dialogue beat has the speaker's characterId; nothing outside the JSON. "ok" or the fix.`);
  return number(steps);
}

function number(steps: string[]): string {
  return steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
}

/** Сколько шагов в плане — для лимита слов в размышлении. */
export function planSteps(plan: string): number {
  return plan.split('\n').filter((l) => /^\s*\d+\./.test(l)).length || plan.split('\n').filter((l) => l.trim()).length;
}
