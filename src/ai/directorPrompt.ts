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

export const SUMMARIZER_PROMPT = (n: number) => `You are the memory engine of an interactive story. You receive the CURRENT
STORY STATE snapshot (if any) and the NEW turns played since it. Produce
EXACTLY two sections with these exact markers:

=== EPISODE ===
A chronological log entry covering ONLY the new turns: what happened, in
order. ${Math.max(6, n)}–${Math.max(10, n + 4)} numbered points, 150–400 words total.
Each point is one CONCRETE event with names, place and outcome — never a vague
summary like "they talked" or "tension grew". Across the points you MUST cover,
whenever they occur in this stretch:
 • plot events and their consequences (what changed in the situation);
 • DECISIONS the hero made and what they cost or gained;
 • RELATIONSHIP MOVEMENT — who grew closer or colder to whom, through what
   exact moment (a confession, a touch, a betrayal, a refusal), and where that
   relationship stands at the end of the stretch. Never skip this: relationship
   progress is the spine of the story;
 • what characters revealed about themselves, learned, or now suspect;
 • important items, places, money and injuries that appeared or changed hands;
 • time passed and any change of location.
Facts only, no analysis, no repetition of older events. This entry is appended
to a permanent chronological log and will never be rewritten — make it
self-contained and precise.

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
  room from the sections above them.
- Never lose facts from the previous snapshot unless newer events supersede
  them; move finished storylines into RESOLVED ARCS instead of deleting them.
- Facts only, no embellishment. Write BOTH sections in ENGLISH regardless of
  the story language. Output nothing outside the two marked sections.`;

// Короткий ремайндер формата в самый конец (глубина 0) — модели на длинном
// контексте забывают отдавать чистый JSON.
export const FORMAT_REMINDER =
  'Reminder: reply with EXACTLY one valid JSON object per the schema — no markdown, no text outside the JSON.';
