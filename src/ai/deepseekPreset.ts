import { uid } from '../shared/utils';
import {
  parsePresetJson,
  refreshBuiltins,
  type PromptBlock,
  type PromptPreset,
} from './promptPreset';
import { defaultRpPreset, RP_OUTDATED_SIGNATURES } from './rpPreset';

// ПРЕСЕТ ПОД DEEPSEEK.
//
// Базовый РП-пресет писался под Gemini и Claude, и на них он хорош. DeepSeek
// ломается иначе, и лечится тоже иначе — поэтому здесь не «ещё немного правил», а
// адресные блоки против трёх его фирменных привычек:
//
//  1. ЭХО. Ответ начинается с пересказа хода игрока своими словами: «Ты шагнул
//     к стойке. Трактирщик поднял голову…». Игрок только что это написал — ему
//     возвращают его же реплику, и полхода уходит впустую.
//  2. ЗАЕДАНИЕ ФРАЗ. Модель находит удачную формулировку («воздух загустел»,
//     «что-то неуловимо изменилось») и тащит её из хода в ход, пока она не
//     начинает резать глаз. Сама она этого не замечает: в её контексте каждая
//     отдельная фраза выглядит уместной.
//  3. ШАБЛОН СЦЕНЫ. Одинаковая композиция каждого хода: реакция → описание
//     обстановки → многозначительная пауза → вопрос игроку.
//
// Первое и третье лечатся прямым запретом. Второе прямым запретом НЕ лечится —
// модель не видит своей склонности со стороны, — поэтому здесь два разных
// инструмента сразу: разбор собственного прошлого ответа в думалке (см.
// DEEPSEEK_THINKING_PLAN) и механические штрафы за повтор в параметрах профиля.
// Ни один из них по отдельности не справляется.

export const DEEPSEEK_ANTI_ECHO = `Never open by restating, paraphrasing or mirroring {{user}}'s last move. Do not start with:
- a retelling of their action ("You stepped up to the bar…");
- their action seen from outside ("The stranger approached the counter…");
- a summary of their words ("So you wanted to know about…");
- their phrasing reworded.
The first sentence must contain something {{user}} did not know yet: a response, a line, a change in the scene. Begin at the effect, not the cause.`;

export const DEEPSEEK_ANTI_REPETITION = `Do not reuse your own phrasing.
- An image, metaphor or turn of phrase used once in this story is spent. Do not repeat it, even reworded.
- Especially atmosphere filler: thickening air, held breath, hanging silence, something shifting imperceptibly, a charged pause, a lingering look.
- Do not repeat sentence rhythms: if the last turn ended on a short dramatic fragment, this one must not.
- Repetition is not a motif. Assume any repeat is a habit.`;

export const DEEPSEEK_ANTI_TEMPLATE = `Vary the shape of the turn. Do not use the same composition two turns in a row (react → describe the room → meaningful pause → question to {{user}}).
Alternatives: open on dialogue with no lead-in; open mid-action; give the beat to characters not talking to {{user}}; end on someone leaving; end flat. A turn need not end with a question or an invitation.`;

// План размышления под DeepSeek. Первый пункт — тот самый «разбор прошлого
// ответа»: заставляет модель ПОСМОТРЕТЬ на собственный предыдущий ход и назвать
// его фразы вслух, прежде чем писать новый. Без этого запрет «не повторяйся»
// повисает в воздухе — модель искренне не считает, что повторяется.
export const DEEPSEEK_THINKING_PLAN = `1. LAST REPLY: 2–3 exact phrases or images I used, and its opening and ending. All banned this turn.
2. OPENING: the first thing {{user}} does not know yet. Never a retelling of their move.
3. SHAPE: how this turn is built differently from the last (opening, ending).
4. BAN LIST: any banned word or phrase about to appear → its replacement, or "clean".
5. SCENE: place, time, who is here, what each is doing and wearing; only what changes now.
6. SAID vs THOUGHT: what {{user}} said or did out loud vs only thought. Thoughts are not heard.
7. KNOWLEDGE: for each acting character, the fact they use and its source (witnessed / told in a scene / tags / common knowledge). No source → they don't know; adjust.
8. INITIATIVE: who acts on their own this turn, and what they want.
9. FRICTION: who does not simply go along with {{user}}, and why ("nobody" only if earned).
10. TURN: first beat, the shift, where it stops (at {{user}}'s move).
11. FORMAT: one quote style; 'single' inside speech; {{user}} = "you"; italics only for thoughts; no dash before speech; nothing written for {{user}}. "ok" or the fix.`;

function makeDefaults(): PromptBlock[] {
  // Основа — полный РП-пресет: всё, что в нём есть про запрет писать за игрока,
  // характеры и информационную гигиену, для DeepSeek верно ровно так же. Меняем
  // не всё подряд, а прицельно — иначе потерялась бы половина уже отлаженного.
  const base = defaultRpPreset().blocks.map((b) => ({ ...b, id: uid('blk') }));

  const antiEcho: PromptBlock = {
    id: uid('blk'),
    name: '🚫 Анти-эхо (DeepSeek)',
    enabled: true,
    content: DEEPSEEK_ANTI_ECHO,
    builtinKey: 'ds_anti_echo',
  };
  const antiRep: PromptBlock = {
    id: uid('blk'),
    name: '🔁 Анти-повторы (DeepSeek)',
    enabled: true,
    content: DEEPSEEK_ANTI_REPETITION,
    builtinKey: 'ds_anti_repetition',
  };
  const antiTpl: PromptBlock = {
    id: uid('blk'),
    name: '🧱 Против шаблона сцены (DeepSeek)',
    enabled: true,
    content: DEEPSEEK_ANTI_TEMPLATE,
    builtinKey: 'ds_anti_template',
  };

  // Ставим сразу после «не писать за игрока»: это тоже запреты, и им место рядом
  // с главным запретом, а не в хвосте среди стилевых пожеланий.
  const at = base.findIndex((b) => b.builtinKey === 'rp_no_impersonation');
  const head = at === -1 ? base.length : at + 1;
  base.splice(head, 0, antiEcho, antiRep, antiTpl);
  return base;
}

export function defaultDeepseekPreset(): PromptPreset {
  return { id: 'omaya_deepseek', name: 'OmayaEngine DeepSeek', blocks: makeDefaults() };
}

export function defaultDeepseekBlockContent(builtinKey: string): string | null {
  return makeDefaults().find((b) => b.builtinKey === builtinKey)?.content ?? null;
}


// Прежние полные тексты блоков DeepSeek (до сжатия): нетронутые обновятся.
const DS_VERBOSE_V1 = [
  { key: 'ds_anti_echo', signature: "NEVER open your reply by restating, paraphrasing or \"reflecting back\" what {{user}} just did. They wrote it — they know it happened. Repeating it back is the single most wasteful thing you can do with the opening of a turn.\n\nConcretely, do NOT start with:\n- a retelling of their action (\"You stepped up to the bar…\"),\n- their action re-described from outside (\"The stranger approached the counter…\"),\n- a summary of their words (\"So you wanted to know about the road north…\"),\n- an echo of their phrasing in different words.\n\nSTART WHERE THE WORLD ANSWERS. The first sentence must contain something {{user}} did not already know: what someone does in response, what they say, what changes in the room. Their action is the cause — begin at the effect.", exact: true },
  { key: 'ds_anti_repetition', signature: "You have a strong pull toward reusing your own successful phrasings. Resist it deliberately — you cannot feel it from inside, so treat it as a rule rather than a matter of taste.\n\n- Any vivid image, metaphor or turn of phrase you have already used in this story is SPENT. Do not use it again, even slightly reworded. Find another way or drop the beat.\n- Watch especially for atmosphere filler: thickening air, held breath, hanging silence, something shifting imperceptibly, a charged pause, a look that lingers. If you have written it once, it is gone.\n- Do not reuse your own sentence rhythms either: if the last turn ended on a short dramatic fragment, this one must not.\n- Repeating a phrase does NOT make it a motif. A motif is deliberate and rare; repetition is a habit. Assume yours is the habit.", exact: true },
  { key: 'ds_anti_template', signature: "Vary the SHAPE of the turn, not just its words. Your default composition — react, describe the room, hold a meaningful pause, ask {{user}} a question — must not repeat two turns running.\n\nOther ways to build a turn, all legitimate: open on dialogue with no lead-in; open mid-action; give the beat to a character who is not talking to {{user}} at all; end on someone leaving; end flatly with no invitation. A turn does NOT have to end with a question or an offer to act — the scene can simply continue and leave the move to {{user}} without asking for it.", exact: true },
];

const DS_ORDER = makeDefaults().map((b) => b.builtinKey as string);

export function normalizeDeepseekPreset(raw: unknown): PromptPreset {
  const parsed =
    raw && typeof raw === 'object' && Array.isArray((raw as any).blocks) ? parsePresetJson(raw) : null;
  if (!parsed) return defaultDeepseekPreset();
  // Блоки здесь — копии РП-шных (те же builtinKey), поэтому и устаревают они по тем
  // же сигнатурам: правка общего блока должна доезжать и до этого пресета.
  const fresh = (pr: PromptPreset) =>
    refreshBuiltins(pr, makeDefaults(), [...RP_OUTDATED_SIGNATURES, ...DS_VERBOSE_V1]);
  const have = new Set(parsed.blocks.map((b) => b.builtinKey).filter(Boolean) as string[]);
  const missing = makeDefaults().filter((b) => b.builtinKey && !have.has(b.builtinKey));
  if (!missing.length) return fresh(parsed);
  const blocks = [...parsed.blocks];
  for (const block of missing) {
    const want = DS_ORDER.indexOf(block.builtinKey as string);
    let at = blocks.length;
    for (let i = 0; i < blocks.length; i++) {
      const idx = blocks[i].builtinKey ? DS_ORDER.indexOf(blocks[i].builtinKey as string) : -1;
      if (idx > want) {
        at = i;
        break;
      }
    }
    blocks.splice(at, 0, { ...block, id: uid('blk') });
  }
  return fresh({ ...parsed, blocks });
}
