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
const CHAPTER_HEADER = `Header lines, then a blank line, then the points:
TITLE: 3–7 words, in the transcript's language
KEYS: 4–10 central names, places, objects — spelled exactly as in the transcript; never translate or transliterate
DATES: in-story dates covered, or "none"
GIST: one sentence`;

const ARCS_SECTION = `=== CHARACTER ARCS ===
One line per TRACKED character whose attitude or inner self lastingly shifted in this stretch (not a passing mood):
- Name | STAGE: stage name | CHANGE: what changed in them | CAUSE: the event | NOW: who they are now, one sentence
No shift → none
Names exactly as in the tracked list.`;

// БРИФ СОБЫТИЯ. Глава — не пересказ сцены, а то, что истории понадобится потом:
// пара пунктов фактов. Обстановка, диалоги и эмоции без последствий — мимо.
const CHAPTER_POINTS = (n: number) => `Then 2–${n} bullet points, one line each, ~60 words total. An event brief, not a retelling.
Only facts the story will need later: plot turns and consequences, the hero's decisions, relationship shifts (and the moment that caused them), revealed facts and secrets (incl. anyone's past, family, origin), items, money, injuries, places, time jumps.
Skip atmosphere, dialogue, routine and anything already known. Names in every point. No vague points ("they talked").`;

export const SUMMARIZER_PROMPT = (n: number) => `You are the memory engine of an interactive story. Input: the current STORY STATE snapshot (if any) and the NEW turns since it. Output exactly three sections with these markers, in order:

=== EPISODE ===
One chapter covering the new turns — plus "EARLIER TURNS OF THIS CHAPTER" if present, as one chapter.
${CHAPTER_HEADER}

${CHAPTER_POINTS(n)}

${ARCS_SECTION}

=== STORY STATE ===
The updated snapshot: previous snapshot merged with the new turns. Telegraphic lines, facts only:
## CHARACTERS
- Name: status | who they are (one clause) | now: where, doing what, wants
## RELATIONSHIPS
- A & B: current dynamic | last shift and its cause | unspoken
## RESOLVED (never replay)
- arc: outcome
## OPEN THREADS
- hook: who, what is at stake
## ITEMS & PLACES
- item/place: state, owner
## WORLD
- rules still relevant
## NOW
Date/time | place | scene | tensions

RULES: keep STORY STATE under ~4000 characters; compress the oldest material first (one line per resolved arc, minor characters to name + clause), never RELATIONSHIPS or NOW. Keep facts from the previous snapshot unless superseded; move finished threads to RESOLVED. Proper names exactly as in the transcript. Points, arcs and snapshot in English; only TITLE and KEYS follow the story language. Nothing outside the three sections.`;

// Добавка к ПОЛЬЗОВАТЕЛЬСКОМУ промпту свёртки: свой формат эпизода автор
// выбрал сам и его не трогаем, но ленту эволюции просим отдельной секцией в
// конце — без неё лента у таких игр не пополнялась бы никогда.
export const ARCS_ADDENDUM = `\n\nAlso output, at the very end:\n\n${ARCS_SECTION}`;

// СБОРКА ГЛАВЫ ИЗ СТЕНОГРАММЫ — для восстановления памяти из архива и для
// «заполнить меморибук с нуля». Снапшот здесь не нужен: он описывает «сейчас», а
// глава — конкретный период прошлого.
export const CHAPTER_PROMPT = (n: number) => `You are the memory engine of an interactive story. Input: a verbatim
stretch of the story, the previous chapter's title and the tracked characters. Output exactly two sections:

=== EPISODE ===
One chapter covering only this stretch.
${CHAPTER_HEADER}

${CHAPTER_POINTS(n)}

${ARCS_SECTION}

Proper names exactly as in the transcript. Points and arcs in English; only TITLE and KEYS follow the story language. Nothing outside the two sections.`;

// Короткий ремайндер формата в самый конец (глубина 0) — модели на длинном
// контексте забывают отдавать чистый JSON.
export const FORMAT_REMINDER =
  'Reply with exactly one valid JSON object per the schema; no markdown, nothing outside it.';
