import type { PromptLength } from '../shared/types';

// Промпты, которые движок использует НАПРЯМУЮ.
//
// Здесь раньше жил «Слой 1» — вшитое ядро режиссёра (CORE_PROMPT) и «Слой 2» —
// тумблеры длины/темпа/тона/стиля. Всё это заменила редактируемая пресет-система
// (promptPreset.ts): именно её блоки реально уходят в запрос. Старые константы
// продолжали лежать рядом, никем не вызываемые, и путали — однажды правка «ядра»
// была сделана здесь и, разумеется, ни на что не повлияла. Удалены.
//
// Осталось ровно то, что вызывается: промпт саммарайзера и ремайндер формата.

// Шапка главы и секция эволюции — общие для свёртки и для сборки глав из архива.
// Имена — в написании стенограммы: по ним движок будит главу, когда о человеке
// снова заходит речь, а английская транслитерация («Levi») в русской игре не
// совпала бы с текстом никогда.
const CHAPTER_HEADER = `Start the section with these four header lines, then a blank line, then the points:
TITLE: a short evocative chapter title (3–7 words) in the SAME language as the story transcript
KEYS: 4–10 comma-separated names, places and objects that are central to this stretch, spelled EXACTLY as in the transcript (same language and script) — never translate or transliterate them
DATES: the in-story date(s) this stretch covers if they are known, otherwise "none"
GIST: one sentence — what this stretch of story is about`;

const ARCS_SECTION = `=== CHARACTER ARCS ===
For each TRACKED CHARACTER listed in the input whose inner self or attitude
genuinely SHIFTED in this stretch (not a mood of one scene — something that will
stay), one line:
- Name | STAGE: short name of the stage they are in now | CHANGE: what changed in them (traits, attitude to the hero, what they fear or want now) | CAUSE: the concrete event that did it | NOW: who they are now, 1–2 sentences
Nobody shifted → write the single word: none
Use names exactly as in the tracked list.`;

export const SUMMARIZER_PROMPT = (n: number) => `You are the memory engine of an interactive story. You receive the CURRENT
STORY STATE snapshot (if any) and the NEW turns played since it. Produce
EXACTLY three sections with these exact markers, in this order:

=== EPISODE ===
One CHAPTER of the story covering ONLY the new turns.
${CHAPTER_HEADER}

Then ${Math.max(6, n)}–${Math.max(10, n + 4)} numbered points, 150–400 words total: what happened, in
order. Each point is one CONCRETE event with names, place and outcome — never a
vague summary like "they talked" or "tension grew". Across the points you MUST
cover, whenever they occur in this stretch:
 • plot events and their consequences (what changed in the situation);
 • DECISIONS the hero made and what they cost or gained;
 • RELATIONSHIP MOVEMENT — who grew closer or colder to whom, through what
   exact moment (a confession, a touch, a betrayal, a refusal), and where that
   relationship stands at the end of the stretch. Never skip this: relationship
   progress is the spine of the story;
 • what characters revealed about themselves, learned, or now suspect — and
   facts about their past, family and origins that came up;
 • important items, places, money and injuries that appeared or changed hands;
 • time passed and any change of location.
Facts only, no analysis, no repetition of older events. This chapter is stored
permanently and is NEVER rewritten or compressed later — make it self-contained
and precise.

${ARCS_SECTION}

=== STORY STATE ===
The UPDATED living snapshot, merging the previous snapshot with the new
turns. Keep it complete but compact:

## MAIN CHARACTERS
- [Name]: [status/condition] | [1-2 sentence bio] | Now: [where, doing what,
  goals, emotional state]

## SECONDARY CHARACTERS
- [Name]: [role] | [current status/last known location]

## RELATIONSHIPS & DYNAMICS
Cover EVERY pair that matters, the hero included — this section is what keeps
romance and rivalry consistent, so never shorten it to one line.
- [A] & [B]: [type and current dynamic] | shift this period: [e.g. "distrust →
  cautious sympathy", "unchanged"] | what caused it: [the concrete moment] |
  unsaid between them: [what neither has admitted yet]

## RESOLVED ARCS (completed storylines — the story must NOT replay these)
- [Arc/event]: [how it resolved]

## ACTIVE PLOT HOOKS & UNRESOLVED THREADS
- [Hook: what, who, why it matters]

## IMPORTANT ITEMS & LOCATIONS
- [Item/place]: [significance, current state/owner]

## WORLD STATE & CONTEXT
[Rules and background needed to understand the story]

## CURRENT SITUATION
Time/Date: … | Location: … | Active scene: … | Immediate tensions: … |
Narrative momentum: …

RULES:
- SIZE: keep the whole STORY STATE section under ~8000 characters. It is rebuilt
  every time and rides in EVERY later request, so it must not grow without end.
  When it approaches that size, do not drop the newest material — COMPRESS the
  oldest: merge RESOLVED ARCS into one line each, trim WORLD STATE to the rules
  that still matter, shorten SECONDARY CHARACTERS to name + one clause. Never
  compress RELATIONSHIPS & DYNAMICS or CURRENT SITUATION to save room — take the
  room from the sections above them. Nothing is lost by this: every chapter is
  kept in full elsewhere.
- Never lose facts from the previous snapshot unless newer events supersede
  them; move finished storylines into RESOLVED ARCS instead of deleting them.
- Keep proper names exactly as spelled in the transcript. Facts only, no
  embellishment. Write the points, arcs and snapshot in ENGLISH regardless of the
  story language (only TITLE and KEYS follow the story language). Output nothing
  outside the three marked sections.`;

// Добавка к ПОЛЬЗОВАТЕЛЬСКОМУ промпту свёртки: свой формат эпизода автор
// выбрал сам и его не трогаем, но ленту эволюции просим отдельной секцией в
// конце — без неё лента у таких игр не пополнялась бы никогда.
export const ARCS_ADDENDUM = `

ADDITIONALLY, at the very end of your answer, output this extra section:

${ARCS_SECTION}`;

// СБОРКА ГЛАВЫ ИЗ СТЕНОГРАММЫ — для восстановления памяти из архива и для
// «заполнить меморибук с нуля». Снапшот здесь не нужен: он описывает «сейчас», а
// глава — конкретный период прошлого.
export const CHAPTER_PROMPT = `You are the memory engine of an interactive story. You receive a verbatim
stretch of the story (player moves and story text) and, for continuity, the
title of the previous chapter and the tracked characters. Produce EXACTLY two
sections with these exact markers:

=== EPISODE ===
One CHAPTER of the story covering ONLY this stretch.
${CHAPTER_HEADER}

Then 8–16 numbered points, 150–500 words total, in order. Each point is one
CONCRETE event with names, place and outcome. Cover plot events and their
consequences, the hero's decisions, RELATIONSHIP MOVEMENT (through which exact
moment, where it stands at the end), what characters revealed about themselves —
including facts about their past, family and origins — important items, places,
money, injuries, time passed and changes of location. Facts only, no analysis.
The chapter is stored permanently and never rewritten — make it self-contained.

${ARCS_SECTION}

RULES: keep proper names exactly as spelled in the transcript. Write the points
and arcs in ENGLISH regardless of the story language (only TITLE and KEYS follow
the story language). Output nothing outside the two marked sections.`;

// Короткий ремайндер формата в самый конец (глубина 0) — модели на длинном
// контексте забывают отдавать чистый JSON.
export const FORMAT_REMINDER =
  'Reminder: reply with EXACTLY one valid JSON object per the schema — no markdown, no text outside the JSON.';
