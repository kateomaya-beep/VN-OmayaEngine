import type { Project, RuntimeState, LlmMessage, MemoryBookEntry, MemoryState } from '../shared/types';
import { runCompletionWith } from './providers';
import { getPresetSettings } from './presetSettings';
import { SUMMARIZER_PROMPT, ARCS_ADDENDUM } from './directorPrompt';
import {
  addArcStages,
  buildTimeline,
  chapterKeys,
  chaptersOf,
  coverage,
  dropArcStagesOf,
  liveTurns,
  parseArcs,
  parseChapterHeader,
  parseTranscript,
  makeChapter,
  retireSupersededLegacy,
  splitSections,
  trackedBrief,
  type ParsedArc,
} from './chapters';
import { condenseAssistantTurn, lastFixedContextTokens } from './promptBuilder';
// Свёртке служебная сводка мира не нужна: в РП она едет хвостом каждого ответа, и
// без этого саммарайзер пересказывал бы JSON вместо сцены.
import { stripStateBlock } from './rpResponse';
import { estimateTokens, uid } from '../shared/utils';
import { pushToast, updateToast } from '../shared/toast';
import { useLang } from '../shared/i18n';
import { logEvent } from '../shared/logStore';

// Двуязычные тексты тостов саммари (язык — из глобального переключателя UI).
function tt(ru: string, en: string): string {
  return useLang.getState().lang === 'en' ? en : ru;
}

// Память без деления на главы (см. CR v2 §E). Саммаризация триггерится по
// счётчику сообщений (memoryConfig.summaryEveryN), не по сюжетному событию.

// Ниже этого порога ответ саммарайзера считаем неудачей (пустой/обрезанный):
// историю в таком случае НЕ трогаем.
const MIN_EPISODE_CHARS = 40;
// Максимальный вход одной свёртки. Больше этого за раз не сворачиваем — остаток
// подождёт следующей (см. maybeCompress), чтобы ни один ход не пропал мимо памяти.
const MAX_TRANSCRIPT_CHARS = 40000;
// В архив кладём ВЕСЬ свёрнутый период целиком: из него восстанавливают период
// дословно и пересобирают свёртку. Обрезка здесь означала бы, что «восстановить»
// вернёт не всё. Размер ограничен тем же потолком свёртки.
const RAW_ARCHIVE_CHARS = MAX_TRANSCRIPT_CHARS;

// Запасная доля бюджета под живую историю — на первый ход, пока запрос ещё ни разу
// не собирался и реальный размер системной части неизвестен.
const LIVE_HISTORY_SHARE = 0.45;
// Какую часть СВОБОДНОГО места (бюджет минус системная часть) отдаём дословной
// истории. Остаток — запас на рост системной части между свёртками (журнал
// эпизодов и снапшот прибавляют после каждой свёртки).
const FREE_SPACE_SHARE = 0.85;

// Сколько токенов может занимать ещё не свёрнутая история. Считаем по РЕАЛЬНОМУ
// размеру системной части прошлого запроса, а не по грубой доле бюджета.
export function liveHistoryAllowance(budget: number, fixedOverride?: number): number {
  const fixed = fixedOverride ?? lastFixedContextTokens();
  if (!fixed) return Math.max(1500, Math.round(budget * LIVE_HISTORY_SHARE));
  return Math.max(1500, Math.round((budget - fixed) * FREE_SPACE_SHARE));
}

// Насколько ниже лимита опускаем живую историю при свёртке (запас, чтобы не
// сворачивать каждые пару ходов).
const HYSTERESIS = 0.6;

// Пауза после неудачной свёртки. Повторять надо (иначе кусок истории так и не
// попадёт в память), но не каждый ход: при сломанном саммарайзере это два лишних
// запроса КАЖДЫЙ ход. Живёт только в памяти вкладки — после перезагрузки пробуем
// снова сразу. Ход игрока при этом не страдает: история остаётся целой.
const FAIL_BACKOFF_TURNS = 3;
let lastFailedTurn = -1e9;
/** Ход последней неудачной свёртки (для индикатора здоровья памяти); null — не было. */
export function lastFoldFailureTurn(): number | null {
  return lastFailedTurn > 0 ? lastFailedTurn : null;
}

// Сколько последних сообщений истории влезает в `budgetTokens`. Ограничено сверху
// «живым окном» из пресета, снизу — двумя ходами. Возвращает границу так, чтобы
// окно начиналось с реплики игрока (историю, открытую ходом ИИ, часть шлюзов не
// принимает).
function keepWithinTokens(
  project: Project,
  state: RuntimeState,
  budgetTokens: number,
  maxMessages: number
): number {
  let keep = 0;
  let used = 0;
  for (let i = state.history.length - 1; i >= 0 && keep < maxMessages; i--) {
    const m = state.history[i];
    const text =
      m.role === 'assistant' ? condenseAssistantTurn(m.content, project, state) ?? stripStateBlock(m.content) : m.content;
    const t = estimateTokens(text);
    if (keep >= 4 && used + t > budgetTokens) break;
    used += t;
    keep++;
  }
  keep = Math.min(maxMessages, Math.max(4, keep));
  // Висящий ответ ИИ в начале окна отправляем в свёртку вместе со старым куском.
  if (keep < state.history.length && state.history[state.history.length - keep]?.role === 'assistant') keep--;
  return Math.max(2, keep);
}

// Сколько токенов займёт ещё не свёрнутая история В ТОМ ВИДЕ, в каком она уходит
// модели (ходы ассистента идут сжатой прозой, а не сырым JSON).
export function liveHistoryTokens(project: Project, state: RuntimeState): number {
  return state.history.reduce((sum, m) => {
    const text =
      m.role === 'assistant' ? condenseAssistantTurn(m.content, project, state) ?? stripStateBlock(m.content) : m.content;
    return sum + estimateTokens(text);
  }, 0);
}

// Свёртке нужен явный потолок ответа: без него шлюзы режут по своему дефолту
// (512/1024 токена). Но и 3000 не хватало — двухсекционный ответ обрывался на
// «CURRENT SITUATION» в конце снапшота. Дефолт 8000, правится в настройках саммари.
const SUMMARY_MAX_TOKENS_FALLBACK = 8000;
const summaryTokens = (project: Project) =>
  Math.min(32000, Math.max(1000, project.memoryConfig.summaryMaxTokens ?? SUMMARY_MAX_TOKENS_FALLBACK));

// Рамка для саммарайзера. ПРИЧИНА: основной ход проходит с полным пресетом (там
// есть jailbreak-блок и рейтинг проекта), а свёртка уходила «голым» системным
// промптом — и модель, спокойно писавшая сцену, отказывалась её пересказывать
// («PROHIBITED_CONTENT» у Gemini). Даём свёртке ту же рамку и просим протокольный,
// неэротичный пересказ: для памяти нужны факты, а не воспроизведение сцены.
function summarizerFraming(project: Project): string {
  const parts: string[] = [];
  const jb = project.aiConfig.jailbreakEnabled ? project.aiConfig.jailbreakPrompt?.trim() : '';
  if (jb) parts.push(jb);
  if (project.meta.contentRating !== 'sfw') {
    parts.push(
      'CONTEXT: this is an internal bookkeeping task for an adult interactive fiction engine. ' +
        'You are not writing or continuing the story — you are compiling a factual continuity record for ' +
        'the engine, so it does not contradict itself later. Report mature or explicit events CLINICALLY ' +
        'and BRIEFLY ("they slept together", "an argument turned violent"): no quotes, no sensory detail, ' +
        'no re-enactment. Never refuse and never return an empty answer — a missing record breaks the game.'
    );
  }
  return parts.join('\n\n');
}

export function isFilterError(e: unknown): boolean {
  return /фильтр безопасности|PROHIBITED_CONTENT|content[_ ]filter|SAFETY/i.test(
    e instanceof Error ? e.message : String(e)
  );
}

export async function summarize(project: Project, prompt: string, transcript: string): Promise<string> {
  const framing = summarizerFraming(project);
  return (
    await runCompletionWith(project.aiConfig.summaryConnection, 'summary', {
      system: framing ? `${framing}\n\n${prompt}` : prompt,
      messages: [{ role: 'user', content: transcript }],
      model: project.aiConfig.summarizerModel || undefined,
      temperature: 0.3,
      maxTokens: summaryTokens(project),
      // Свёртка — бухгалтерия, а не сочинительство: пересказать уже случившееся
      // фактами. Глубокое размышление здесь не улучшает результат, зато стоит
      // минут на стенограмме в десятки ходов. Не указав ступень, мы отдавали её на
      // усмотрение модели, а у «всегда думающих» (GLM-5.x, Kimi) дефолт — самый
      // тяжёлый режим: шлюз не дожидался ответа и отдавал 502. Свёртка при этом
      // падает молча, в фоне, — история продолжает расти и перестаёт влезать.
      // 'none' для тех, кто умеет выключать; остальным движок подменит на минимум.
      reasoningEffort: 'none',
    })
  ).trim();
}

// АВАРИЙНАЯ СВЁРТКА БЕЗ ИИ. Если модель отказывается пересказывать содержимое
// (фильтр безопасности), память раньше вставала намертво: свёртки нет → история
// растёт → ходы перестают влезать в запрос. Тогда эпизод собирает сам движок:
// берём начало каждого хода дословно. Это хуже настоящего пересказа, но событие
// остаётся в памяти и в журнале, а дословный текст лежит в архиве периода —
// свёртку можно переделать кнопкой, когда будет подходящая модель.
export function mechanicalDigest(transcript: string): string {
  const lines = transcript
    .split(/\n\n+/)
    .map((l) => l.replace(/^(ИГРОК|ИГРА|PLAYER|GAME):\s*/, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const points: string[] = [];
  for (const l of lines) {
    const head = l.slice(0, 220);
    if (head.length >= 20) points.push(`- ${head}${l.length > 220 ? '…' : ''}`);
    if (points.length >= 25) break;
  }
  if (!points.length) return '';
  return (
    'ЧЕРНОВАЯ ЗАПИСЬ (модель отказалась пересказывать этот период по фильтру безопасности; ' +
    'это начало каждого хода дословно, а не пересказ — период можно пересобрать в Game Master → Саммари):\n' +
    points.join('\n')
  );
}

// Пересборка ТОЛЬКО живого снапшота — по всему, что есть: журнал эпизодов
// (хронология) + текущий снапшот. Журнал переписывать не нужно, он append-only;
// а снапшот, наоборот, полезно пересобрать, если он обрезался или устарел.
const STATE_REBUILD_PROMPT = `You rebuild the living STORY STATE snapshot of an interactive story
from its chronological chapters and the previous snapshot. Output ONLY the
snapshot body — no preamble, no chapter list, no markers.

Keep this exact section layout and fill every one of them:

## MAIN CHARACTERS
- [Name]: [status/condition] | [1-2 sentence bio] | Now: [where, doing what, goals, emotional state]

## SECONDARY CHARACTERS
- [Name]: [role] | [current status/last known location]

## RELATIONSHIPS & DYNAMICS
Every pair that matters, the hero included.
- [A] & [B]: [type and current dynamic] | how it got there: [the concrete moments] | unsaid between them: [what neither has admitted]

## RESOLVED ARCS (completed storylines — the story must NOT replay these)
- [Arc/event]: [how it resolved]

## ACTIVE PLOT HOOKS & UNRESOLVED THREADS
- [Hook: what, who, why it matters]

## IMPORTANT ITEMS & LOCATIONS
- [Item/place]: [significance, current state/owner]

## WORLD STATE & CONTEXT
[Rules and background needed to understand the story]

## CURRENT SITUATION
Time/Date: … | Location: … | Active scene: … | Immediate tensions: … | Narrative momentum: …

RULES: be thorough — this snapshot is the model's only authoritative picture of
where things stand, so completeness beats brevity. Never drop a section, never
lose a fact from the previous snapshot unless the chapters supersede it, and finish
every section (an unfinished snapshot is worse than a short one). Facts only,
in ENGLISH.`;

// Вход пересборки: главы по порядку. Все целиком не всегда влезают во вход
// саммарайзера — тогда свежие идут полностью, а старшие строкой сути: для
// «положения дел сейчас» важнее последние события, а старшие уже учтены в
// прежнем снапшоте.
const REBUILD_INPUT_CHARS = 60000;
function chaptersForRebuild(memory: MemoryState): string {
  const list = chaptersOf(memory).filter((c) => c.mode !== 'off');
  const full = list.map((c, i) => `[Chapter ${i + 1} «${c.title}»${c.toTurn ? `, up to turn ${c.toTurn}` : ''}]\n${c.text}`);
  let total = full.reduce((n, t) => n + t.length, 0);
  for (let i = 0; i < full.length - 1 && total > REBUILD_INPUT_CHARS; i++) {
    const short = `[Chapter ${i + 1} «${list[i].title}»] ${list[i].gist || list[i].text.slice(0, 200)}`;
    total -= full[i].length - short.length;
    full[i] = short;
  }
  return full.join('\n\n');
}

export async function rebuildStoryState(
  project: Project,
  memory: RuntimeState['memory']
): Promise<string> {
  const log = chaptersForRebuild(memory);
  if (!log.trim() && !memory.storyState?.trim()) throw new Error('Нечего пересобирать: нет ни глав, ни снапшота');
  const input = [
    memory.storyState?.trim() ? `PREVIOUS SNAPSHOT:\n${memory.storyState.trim()}` : '',
    log.trim() ? `CHAPTERS (oldest → newest):\n${log}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  const raw = await summarize(project, STATE_REBUILD_PROMPT, input);
  // Модель может по привычке обернуть ответ маркерами — снимаем.
  const { storyState } = splitSummarySections(raw);
  const text = (storyState || raw).trim();
  if (text.length < MIN_EPISODE_CHARS) throw new Error('Модель вернула пустой ответ — попробуйте ещё раз');
  logEvent('info', 'memory', `Снапшот состояния пересобран (${text.length} симв.)`);
  return text;
}

// Свёртка с НЕМЕДЛЕННЫМ повтором. Первая попытка — как есть; если ответ пустой
// или обрезанный, пробуем ещё раз тем же ходом: с нажимом на формат и без
// прежнего снапшота на входе (частая причина пустоты — слишком длинный вход).
// Ждать следующего хода ради второй попытки незачем — история и так не режется,
// но чем раньше свёртка получится, тем меньше растёт живое окно.
async function summarizeWithRetry(
  project: Project,
  prompt: string,
  input: string,
  transcriptOnly: string
): Promise<{ raw: string; episode: string; storyState: string; arcs: string }> {
  let filtered = false;
  try {
    const first = await summarize(project, prompt, input);
    const a = splitSummarySections(first);
    if (a.episode.trim().length >= MIN_EPISODE_CHARS) return { raw: first, ...a };
    logEvent('warn', 'memory', 'Свёртка вышла пустой — повторяю сразу же (короче вход, жёстче формат)');
  } catch (e) {
    if (!isFilterError(e)) throw e;
    filtered = true;
    logEvent(
      'warn',
      'memory',
      'Модель отказалась пересказывать период по фильтру безопасности — повторяю в протокольном режиме'
    );
  }

  // Вторая попытка. При отказе по фильтру давим на «это учётная запись, а не сцена»:
  // модели, которые не пересказывают эротику, обычно соглашаются на сухой протокол.
  const strict = filtered
    ? `${prompt}\n\nSTRICT MODE: output a neutral, clinical continuity record only. Name events in the ` +
      `plainest possible words, one short line each. No dialogue, no quotes, no bodies, no sensations, ` +
      `no adjectives. This is a database record for a game engine, not prose. Never refuse.`
    : `${prompt}\n\nIMPORTANT: output ALL the marked sections and never return an empty answer. Facts only, no preamble.`;
  try {
    const second = await summarize(project, strict, transcriptOnly);
    const b = splitSummarySections(second);
    if (b.episode.trim().length >= MIN_EPISODE_CHARS || !filtered) return { raw: second, ...b };
  } catch (e) {
    if (!isFilterError(e)) throw e;
  }

  // Модель не согласилась и в протокольном режиме. Память останавливать нельзя:
  // собираем эпизод механически, без ИИ. Снапшот при этом не трогаем — пусть
  // останется прежний (он честно помечен устаревшим), чем затереть его черновиком.
  const digest = mechanicalDigest(transcriptOnly);
  if (digest) {
    logEvent(
      'error',
      'memory',
      'Модель отказалась пересказывать период даже в протокольном режиме — записала ЧЕРНОВУЮ свёртку ' +
        '(начало каждого хода дословно). Дословный текст цел в архиве периода: выберите другую модель ' +
        'для свёртки (Game Master → Саммари) и нажмите «пересобрать».'
    );
    pushToast(
      'error',
      tt(
        'Модель не пересказывает этот период (фильтр). Записала черновую свёртку — история цела, пересоберите её другой моделью.',
        'The model refuses to summarize this period (safety filter). A draft record was written — history is intact; rebuild it with another model.'
      )
    );
    return { raw: digest, episode: digest, storyState: '', arcs: '' };
  }
  return { raw: '', episode: '', storyState: '', arcs: '' };
}

// НАЛОЖЕНИЕ ФОНОВОЙ СВЁРТКИ на текущее состояние. Пока свёртка шла, игрок мог
// сделать ещё ход, поправить запись меморибука, а сборка глав — дописать главу.
// Подставить память свёртки целиком нельзя: всё это пропало бы. Поэтому берём из
// результата только НОВОЕ — записи, куски архива и этапы эволюции, которых до
// свёртки не было, — и накладываем на текущую память. История режется ровно на
// свёрнутое: свёртка удаляет сообщения только с начала, новые ходы — в конце.
export function mergeFoldedMemory(cur: MemoryState, before: MemoryState, result: MemoryState): MemoryState {
  const beforeIds = new Set(before.memorybook.map((e) => e.id));
  const curIds = new Set(cur.memorybook.map((e) => e.id));
  const added = result.memorybook
    .filter((e) => !beforeIds.has(e.id) && !curIds.has(e.id))
    // Этот же период за время свёртки могла описать сборка глав — второй главы не пишем.
    .filter(
      (e) =>
        !(e.kind === 'chapter' && typeof e.fromMsg === 'number' && typeof e.toMsg === 'number' &&
          coverage(cur, e.fromMsg, e.toMsg) >= 0.9)
    );
  const addedIds = new Set(added.map((e) => e.id));
  // Главы, которые свёртка ПЕРЕПИСАЛА (дописанная открытая глава): тот же id,
  // другое содержимое. Берём версию свёртки, режим — как выставлен сейчас.
  const beforeById = new Map(before.memorybook.map((e) => [e.id, e] as const));
  const rewritten = new Map(
    result.memorybook
      .filter((e) => beforeById.has(e.id) && JSON.stringify(e) !== JSON.stringify(beforeById.get(e.id)))
      .map((e) => [e.id, e] as const)
  );
  for (const id of rewritten.keys()) addedIds.add(id);
  const beforeStages = new Set((before.arcs || []).flatMap((a) => a.stages.map((x) => x.id)));
  const resultStages = new Set((result.arcs || []).flatMap((a) => a.stages.map((x) => x.id)));
  // Этапы, которые свёртка убрала (они были у переписанной главы), убираем и тут.
  const arcs = (cur.arcs || []).map((a) => ({
    ...a,
    stages: a.stages.filter((x) => !(beforeStages.has(x.id) && !resultStages.has(x.id))),
  }));
  for (const ra of result.arcs || []) {
    for (const st of ra.stages) {
      if (beforeStages.has(st.id)) continue;
      if (st.chapterId && !addedIds.has(st.chapterId)) continue;
      let t = arcs.find((a) => (ra.charId && a.charId === ra.charId) || a.name.toLowerCase() === ra.name.toLowerCase());
      if (!t) {
        t = { name: ra.name, charId: ra.charId, stages: [] };
        arcs.push(t);
      }
      if (!t.stages.some((x) => x.id === st.id)) t.stages.push(st);
      t.stages.sort((a, b) => a.turn - b.turn);
    }
  }
  const snapshotChanged = result.storyState !== before.storyState;
  return retireSupersededLegacy({
    ...cur,
    memorybook: [
      ...cur.memorybook.map((e) => {
        const r = rewritten.get(e.id);
        return r ? { ...r, mode: e.mode } : e;
      }),
      ...added,
    ],
    rawArchive: [...cur.rawArchive, ...result.rawArchive.slice(before.rawArchive.length)],
    arcs,
    storyState: snapshotChanged ? result.storyState : cur.storyState,
    storyStateAtTurn: snapshotChanged ? result.storyStateAtTurn : cur.storyStateAtTurn,
    foldedMsgCount: cur.foldedMsgCount + (result.foldedMsgCount - before.foldedMsgCount),
  });
}

export function applyFold(
  cur: RuntimeState,
  folded: number,
  result: MemoryState,
  before: MemoryState,
  addedSince: number
): RuntimeState {
  const memory = mergeFoldedMemory(cur.memory, before, result);
  return {
    ...cur,
    history: folded > 0 ? cur.history.slice(folded) : cur.history,
    memory: { ...memory, messagesSinceSummary: result.messagesSinceSummary + Math.max(0, addedSince) },
  };
}

// Сколько заходов свёртки подряд разрешено за один запуск. Один заход ограничен
// объёмом входа саммарайзера (MAX_TRANSCRIPT_CHARS), и на длинных ходах в него
// влезает 5-6 сообщений — этого хватает, чтобы едва уйти под лимит, но не хватает,
// чтобы дойти до цели гистерезиса. Через несколько ходов лимит снова перебит, и
// свёртка идёт заново: в логах это выглядит как «саммари каждые шесть сообщений».
// Свёртка теперь фоновая, поэтому несколько заходов подряд игрока не задерживают —
// зато после них наступает долгая тишина вместо вечного «сворачиваю по чуть-чуть».
const MAX_FOLD_PASSES = 6;

// РАЗМЕР ГЛАВЫ. Свёртки идут по бюджету, а не по сюжету: на длинных ходах заход
// бывает в 2–4 сообщения (вход саммарайзера ограничен), и когда каждая свёртка
// писала свою главу, меморибук засыпало главами-огрызками. Теперь глава копится:
// последняя глава, не набравшая размера, остаётся «открытой», и следующая свёртка
// дописывает её — по ДОСЛОВНОМУ тексту её сообщений и новых, одним пересказом (не
// пересказ пересказа). Набрала размер — закрыта навсегда. Потолок — полтора
// размера, чтобы глава не разрасталась, если свёртка пришла большая.
const chapterSize = (project: Project) => Math.max(4, project.memoryConfig.chapterSize ?? 12);
const chapterPoints = (project: Project) => Math.max(3, project.memoryConfig.chapterMaxPoints ?? 7);
// Сколько дословного текста главы (прежняя часть + новые ходы) влезает в один
// запрос. Больше — открытую главу закрываем как есть и начинаем новую.
const MAX_CHAPTER_CHARS = 60000;

/** Открытая глава: последняя, собранная свёрткой, вплотную к несвёрнутому и ещё не набравшая размер. */
export function openChapter(project: Project, memory: MemoryState): MemoryBookEntry | null {
  const last = chaptersOf(memory)
    .filter((c) => c.mode !== 'off' && c.source !== 'legacy')
    .pop();
  if (!last || last.source !== 'auto' || typeof last.fromMsg !== 'number' || last.toMsg !== memory.foldedMsgCount) return null;
  return last.toMsg - last.fromMsg + 1 < chapterSize(project) ? last : null;
}

export async function maybeCompress(
  project: Project,
  state: RuntimeState,
  force = false,
  pass = 0
): Promise<RuntimeState> {
  const ps = getPresetSettings();
  const K = Math.max(2, ps.liveWindow);
  const everyN = Math.max(4, project.memoryConfig.summaryEveryN) * 2;
  const dueByCount = state.memory.messagesSinceSummary >= everyN;

  // ТРИГГЕР ПО ОБЪЁМУ — главный (фикс «глобальной шизофрении»).
  // Раньше свёртка шла ТОЛЬКО по счётчику ходов, а бюджет контекста при сборке
  // запроса резал живую историю до минимума. Между этими двумя числами возникала
  // СЛЕПАЯ ЗОНА: ходы уже не влезали в контекст, но ещё не были свёрнуты в память —
  // то есть исчезали для модели полностью. На дефолтах это 24 хода из 30: игра
  // «забывала» имена, введённые 6 ходов назад, и заново отправляла героя туда, где
  // он уже был. Теперь память сворачивается ровно тогда, когда живая история
  // перестаёт помещаться в отведённую ей долю бюджета — то есть до того, как
  // хоть один ход выпадет из контекста.
  const allowance = liveHistoryAllowance(ps.contextBudget || 80000);
  const liveTokens = liveHistoryTokens(project, state);

  // ГИСТЕРЕЗИС. Свернуть надо, когда живая история переросла лимит, но оставить
  // после свёртки ровно лимит нельзя — тогда следующие 2-3 хода снова его перебьют
  // и свёртка пойдёт почти каждый ход. Поэтому режем с запасом: оставляем столько
  // последних сообщений, сколько влезает в 60% лимита (но не больше «живого окна»
  // из пресета и не меньше двух ходов).
  const target = Math.round(allowance * HYSTERESIS);
  const keep = keepWithinTokens(project, state, target, K * 2);
  // Не сворачиваем по объёму ради пары сообщений.
  const dueBySize = liveTokens > allowance && state.history.length >= keep + 4;

  if ((!force && !dueByCount && !dueBySize) || state.history.length <= keep) return state;
  if (state.turnCount - lastFailedTurn < FAIL_BACKOFF_TURNS) {
    logEvent('info', 'memory', `Свёртка недавно не удалась — жду ещё ход-другой перед повтором (история цела)`);
    return state;
  }
  if (dueBySize && !dueByCount && !force) {
    logEvent(
      'info',
      'memory',
      `Свёртка по объёму: живая история ~${liveTokens} ток. при лимите ~${allowance} ` +
        `(бюджет ${ps.contextBudget}). Сворачиваю, пока ходы не начали выпадать из контекста.`
    );
  }

  let stale = state.history.slice(0, state.history.length - keep);
  if (!stale.length) return state;

  // ПОТОЛОК ВХОДА САММАРАЙЗЕРА. Раньше транскрипт просто обрезался с начала, если
  // выходил длиннее лимита, — а из истории удалялись ВСЕ сворачиваемые сообщения.
  // Самые старые ходы при этом исчезали, не попав ни в свёртку, ни в архив. Теперь
  // за раз сворачиваем ровно столько, сколько влезает в лимит; остальное остаётся в
  // живой истории и уйдёт в память следующей свёрткой.
  const staleAll = stale.length;
  // Меряем ТО, ЧТО РЕАЛЬНО УЙДЁТ В СВЁРТКУ. Ходы ассистента идут саммарайзеру
  // сжатой прозой (condenseAssistantTurn), а лимит считался по сырому JSON хода —
  // а он вместе с id, эмоциями, нарядами и statChanges в 3-5 раз длиннее прозы.
  // Из-за этого в «40000 символов» влезало 5-6 сообщений вместо двух десятков:
  // свёртка едва уходила под лимит и через несколько ходов запускалась снова
  // («саммари каждые шесть сообщений»).
  const asText = (m: LlmMessage): string =>
    m.role === 'assistant' ? condenseAssistantTurn(m.content, project, state) ?? stripStateBlock(m.content) : m.content;
  const staleText = stale.map(asText);

  // Открытая глава и её дословный текст — свёртка допишет её, а не начнёт новую.
  let open = openChapter(project, state.memory);
  let openTranscript = '';
  if (open) {
    const own = buildTimeline(state).filter((m) => m.abs >= open!.fromMsg! && m.abs <= open!.toMsg!);
    openTranscript = own.map((m) => `${m.role === 'user' ? 'ИГРОК' : 'ИГРА'}: ${m.text}`).join('\n\n');
    // Текста главы нет (архив вернули в историю) или он уже велик — закрываем её.
    if (!own.length || openTranscript.length > MAX_CHAPTER_CHARS * 0.7) {
      open = null;
      openTranscript = '';
    }
  }
  const openCount = open ? open.toMsg! - open.fromMsg! + 1 : 0;
  // Сколько новых сообщений взять в этот заход: столько, чтобы глава вышла размером
  // от одного до полутора размеров, и не больше потолка входа саммарайзера.
  const msgCap = Math.max(2, Math.ceil(chapterSize(project) * 1.5) - openCount);
  const charCap = Math.min(MAX_TRANSCRIPT_CHARS, MAX_CHAPTER_CHARS - openTranscript.length);
  let chars = 0;
  let fits = 0;
  for (const text of staleText) {
    chars += text.length + 2;
    if (chars > charCap && fits >= 4) break;
    if (fits >= msgCap) break;
    fits++;
  }
  // Заход заканчиваем ответом ИИ: иначе живая история началась бы с его ответа
  // без реплики игрока, а часть шлюзов такую историю не принимает.
  if (fits < stale.length && fits > 2 && stale[fits - 1].role === 'user') fits--;
  if (fits < stale.length) {
    stale = stale.slice(0, fits);
    logEvent(
      'info',
      'memory',
      `Период великоват для одной свёртки: сворачиваю ${fits} из ${staleAll} сообщений, ` +
        `остальные останутся в живой истории и попадут в память следующей свёрткой`
    );
  }

  // Транскрипт для саммарайзера — ПРОЗОЙ, а не сырым JSON хода. Сырые ответы несут
  // служебные поля (id, эмоции, наряды, statChanges) и раздували вход свёртки в 3–5
  // раз: на 30 ходах это десятки тысяч токенов, отсюда «ошибка автосаммари» на
  // рабочем API.
  const lines = stale.map((m, i) => `${m.role === 'user' ? 'ИГРОК' : 'ИГРА'}: ${staleText[i]}`);
  // ПЕРЕПИСКА ТЕЛЕФОНА — ЧАСТЬ ТОЙ ЖЕ ИСТОРИИ. Раньше она в свёртку не попадала
  // вовсе: в контекст уходили только последние 14 строк, а всё, что старше,
  // исчезало навсегда — при том что сцены аккуратно сворачивались в эпизоды. Один
  // сюжет жил по двум разным правилам хранения. Теперь сообщения, отправленные на
  // сворачиваемых ходах, идут в тот же транскрипт, вперемешку со сценами.
  const foldedTurns = new Set<number>();
  for (const m of stale) {
    const t = (m as { turn?: number }).turn;
    if (typeof t === 'number') foldedTurns.add(t);
  }
  const firstTurn = Math.max(0, state.turnCount - Math.ceil(stale.length / 2));
  const phoneLines: string[] = [];
  for (const chat of state.phone?.chats || []) {
    const who = (id?: string) => chat.participantIds.find((p) => p === id) || id || 'кто-то';
    for (const m of chat.messages) {
      // Берём сообщения того же периода, что и сворачиваемые ходы.
      if (typeof m.turn === 'number' ? m.turn > firstTurn : true) continue;
      const body = m.text?.trim() || (m.attachedAssetId || m.photoPrompt ? '[фото]' : '');
      if (!body) continue;
      const when = m.storyDate ? `[${m.storyDate}${m.storyTime ? ` ${m.storyTime}` : ''}] ` : '';
      const label = chat.kind === 'group' ? `в группе «${chat.title || 'без названия'}»` : 'в переписке';
      phoneLines.push(
        `ТЕЛЕФОН ${when}${label}: ${m.from === 'protagonist' ? 'герой' : who(m.senderId)}: ${body.slice(0, 200)}`
      );
    }
  }
  if (phoneLines.length) {
    logEvent('info', 'memory', `В свёртку включено ${phoneLines.length} сообщений телефона за этот период`);
  }
  const transcript = [lines.join('\n\n'), phoneLines.length ? phoneLines.join('\n') : '']
    .filter(Boolean)
    .join('\n\n');

  const toastId = pushToast('info', tt('Сжимаю память…', 'Summarizing memory…'));
  logEvent('info', 'memory', `Саммаризация: сворачиваю ${stale.length} сообщений`);
  try {
    const custom = project.memoryConfig.summaryPrompt?.trim();
    // Этапы эволюции из открытой главы пересоберутся вместе с ней — в «текущий
    // этап» для саммарайзера их не отдаём, иначе он засчитал бы их дважды.
    const baseMemory: MemoryState = open
      ? { ...state.memory, arcs: dropArcStagesOf(state.memory.arcs, new Set([open.id])) }
      : state.memory;
    const tracked = trackedBrief(project, baseMemory);
    // Свой промпт свёртки автор выбрал сам — формат эпизода не трогаем, но ленту
    // эволюции просим отдельной секцией в конце.
    const prompt = custom
      ? custom + (tracked ? ARCS_ADDENDUM : '')
      : SUMMARIZER_PROMPT(chapterPoints(project));
    // ТРЁХЧАСТНАЯ ПАМЯТЬ: на вход — прежний снапшот + новые ходы (+ кого
    // отслеживать и чем кончилась прошлая глава); на выходе — (1) ГЛАВА, которая
    // ложится в меморибук и больше никогда не переписывается и не пережимается,
    // (2) сдвиги отслеживаемых персонажей и (3) обновлённый снапшот, ЗАМЕНЯЮЩИЙ прежний.
    const prevChapter = chaptersOf(state.memory)
      .filter((c) => c.mode !== 'off' && c.id !== open?.id)
      .pop();
    const context = [
      tracked,
      prevChapter ? `PREVIOUS CHAPTER: «${prevChapter.title}» — ${prevChapter.gist || ''}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    const prevState = state.memory.storyState?.trim() || '';
    const turnsBlock = `=== NEW TURNS${prevState ? ' SINCE THAT SNAPSHOT' : ''} ===\n${transcript}`;
    // Начало открытой главы — дословно. В снапшоте оно уже учтено, поэтому идёт
    // отдельной секцией: только для главы. Пометка продублирована словами прямо во
    // входе — на случай своего промпта свёртки, который про неё не знает.
    const earlierBlock = open
      ? `=== EARLIER TURNS OF THIS CHAPTER (already reflected in the snapshot; write ONE chapter covering these AND the new turns) ===\n${openTranscript}`
      : '';
    const input = [
      context,
      prevState ? `CURRENT STORY STATE (snapshot to update):\n${prevState}` : '',
      earlierBlock,
      turnsBlock,
    ]
      .filter(Boolean)
      .join('\n\n');
    const retryInput = [context, earlierBlock, turnsBlock].filter(Boolean).join('\n\n');
    const { raw, episode, storyState, arcs: arcsText } = await summarizeWithRetry(project, prompt, input, retryInput);

    // КРИТИЧНО: историю режем ТОЛЬКО если свёртка реально получилась. Пустой,
    // обрезанный или мусорный ответ раньше проходил дальше по коду — запись не
    // добавлялась, а сообщения из истории всё равно удалялись. Кусок сюжета
    // исчезал бесследно. Теперь при неудаче состояние возвращается КАК ЕСТЬ.
    if (episode.trim().length < MIN_EPISODE_CHARS) {
      updateToast(
        toastId,
        'error',
        tt(
          'Свёртка не удалась (две попытки) — история ЦЕЛА, ни одно сообщение не скрыто. Повторю на следующем ходу.',
          'Summarization failed (two attempts) — history is INTACT, nothing hidden. Will retry next turn.'
        )
      );
      logEvent(
        'error',
        'memory',
        `Саммарайзер вернул непригодный ответ (${raw.length} симв., эпизод ${episode.trim().length} симв.) — история НЕ обрезана`,
        raw.slice(0, 500)
      );
      lastFailedTurn = state.turnCount;
      return state;
    }

    // ГЛАВА. Номера сообщений абсолютные: по ним видно, какой кусок истории она
    // описывает, и вторая глава о том же не появится.
    const fromMsg = state.memory.foldedMsgCount + 1;
    const toMsg = state.memory.foldedMsgCount + stale.length;
    const lt = liveTurns(state);
    const fromTurn = lt[0];
    const toTurn = lt[stale.length - 1];
    const header = parseChapterHeader(episode);
    // Этот период уже описан главой (её собрали из живой истории раньше свёртки) —
    // вторую не пишем; снапшот и архив при этом обновляются как обычно.
    const alreadyCovered = coverage(state.memory, fromMsg, toMsg) >= 0.9;
    let chapter: MemoryBookEntry | null = alreadyCovered
      ? null
      : makeChapter(project, state, {
          header,
          transcript: open ? `${openTranscript}\n\n${transcript}` : transcript,
          fromMsg: open ? open.fromMsg : fromMsg,
          toMsg,
          fromTurn: open ? open.fromTurn ?? fromTurn : fromTurn,
          toTurn,
          // Глава из нескольких кусков архива к одному куску не привязана — её
          // находят по диапазону сообщений.
          archiveTurn: open ? undefined : state.turnCount,
          source: 'auto',
          fallbackTitle: raw.startsWith('ЧЕРНОВАЯ ЗАПИСЬ')
            ? 'Черновая глава (пересоберите)'
            : open?.title,
        });
    if (chapter && open) {
      // Та же глава, дописанная: id прежний (на него ссылаются этапы и правки),
      // ключи — объединение (вдруг их добавляли руками), режим — как выставлен.
      chapter = { ...chapter, id: open.id, mode: open.mode, keys: [...new Set([...open.keys, ...chapter.keys])].slice(0, 16) };
    }
    if (alreadyCovered) logEvent('info', 'memory', `Период ходов ${fromTurn}–${toTurn} уже описан главой — новую не пишу`);
    const parsedArcs: ParsedArc[] = chapter ? parseArcs(arcsText) : [];
    const arcs = chapter
      ? addArcStages(baseMemory.arcs, project, baseMemory, parsedArcs, {
          turn: toTurn,
          dates: header.dates,
          chapterId: chapter.id,
          source: 'auto',
        })
      : state.memory.arcs;

    updateToast(toastId, 'success', tt('Память обновлена', 'Memory updated'));
    logEvent(
      'info',
      'memory',
      `Саммаризация выполнена: ${chapter ? `${open ? 'дописана' : 'начата'} глава «${chapter.title}» (ходы ${chapter.fromTurn}–${toTurn}, сообщений ${chapter.toMsg! - chapter.fromMsg! + 1} из ~${chapterSize(project)}, ключи: ${chapter.keys.join(', ') || '—'})` : 'без новой главы'}, ` +
        `снапшот ${storyState.trim().length} симв., сдвигов персонажей: ${parsedArcs.length} (ответ целиком ${raw.length} симв.)`
    );
    // Снапшот НЕ ОБНОВИЛСЯ (обрыв ответа). Оставлять прежний нельзя: он объявляет
    // себя «положением дел сейчас» и тянет сюжет назад, к моменту старой свёртки.
    // Пересобираем снапшот отдельным запросом по главам.
    const withChapter: MemoryState = {
      ...state.memory,
      memorybook: !chapter
        ? state.memory.memorybook
        : open
          ? state.memory.memorybook.map((e) => (e.id === open!.id ? chapter! : e))
          : [...state.memory.memorybook, chapter],
    };
    let freshState = storyState.trim();
    if (!freshState) {
      logEvent(
        'warn',
        'memory',
        'Секция STORY STATE пуста (обрыв ответа или свой промпт свёртки) — пересобираю снапшот отдельным запросом по главам'
      );
      try {
        freshState = await rebuildStoryState(project, withChapter);
      } catch (e) {
        logEvent(
          'error',
          'memory',
          'Пересборка снапшота не удалась: ' + (e as Error).message + '. Прежний снапшот помечен устаревшим.'
        );
        pushToast(
          'error',
          tt(
            'Снапшот состояния не обновился — он помечен устаревшим. Пересоберите его в Game Master → Саммари.',
            'The state snapshot did not update — it is marked stale. Rebuild it in Game Master → Summary.'
          )
        );
      }
    }
    // Сырой кусок — целиком и с номерами: из него пересобирают главу и ищут по
    // прошлому, а номера держат счёт, даже если в архиве появятся дыры.
    const rawArchive = [
      ...state.memory.rawArchive,
      { turn: state.turnCount, text: transcript.slice(0, RAW_ARCHIVE_CHARS), fromMsg, toMsg, fromTurn, toTurn },
    ];

    const next: RuntimeState = {
      ...state,
      // Удаляем РОВНО то, что ушло в свёртку. Считать от `keep` нельзя: когда период
      // не влез в один заход, свёрнута только его часть — остальное обязано остаться
      // в живой истории, иначе оно исчезнет мимо и контекста, и архива.
      history: state.history.slice(stale.length),
      // Главы НЕ пережимаются. Раньше здесь журнал уплотнялся: старые эпизоды
      // сжимались в сводку, потом сводка со следующими — ещё раз, и начало истории
      // таяло до дюжины строк. Теперь рост памяти держит бюджет при сборке запроса:
      // старые главы уходят в оглавление, а целиком подтягиваются по ключам.
      memory: retireSupersededLegacy({
        ...withChapter,
        arcs,
        storyState: freshState || state.memory.storyState,
        storyStateAtTurn: freshState ? state.turnCount : state.memory.storyStateAtTurn,
        foldedMsgCount: toMsg,
        rawArchive,
        messagesSinceSummary: 0,
      }),
    };
    // Не дошли до цели за один заход (вход саммарайзера ограничен) — доворачиваем
    // сразу, а не через несколько ходов.
    const stillOver = liveHistoryTokens(project, next) > target;
    if (stillOver && pass + 1 < MAX_FOLD_PASSES && next.history.length > keep + 4) {
      logEvent(
        'info',
        'memory',
        `Заход ${pass + 1}: живая история ~${liveHistoryTokens(project, next)} ток. при цели ~${target} — доворачиваю сразу, ` +
          `чтобы не возвращаться к свёртке каждые несколько ходов`
      );
      return maybeCompress(project, next, true, pass + 1);
    }
    return next;
  } catch (e) {
    updateToast(
      toastId,
      'error',
      tt('Ошибка автосаммари: ', 'Auto-summary error: ') + (e as Error).message
    );
    logEvent('error', 'memory', 'Саммаризация не удалась: ' + (e as Error).message);
    lastFailedTurn = state.turnCount;
    return state; // graceful: keep verbatim history, retry a couple of turns later
  }
}

// Разбор архивного транскрипта обратно в сообщения (см. parseTranscript).
export const parseArchivedTranscript = parseTranscript;

// Режет ответ саммарайзера на секции. Нет маркеров (свой промпт автора) → весь
// текст считается эпизодом, а секция эволюции, если модель её дописала, отрезается.
export function splitSummarySections(raw: string): { episode: string; storyState: string; arcs: string } {
  const text = (raw || '').trim();
  const sec = splitSections(text);
  const arcs = sec['CHARACTER ARCS'] || '';
  const episode = (sec['EPISODE'] || '').trim();
  const storyState = (sec['STORY STATE'] || '').trim();
  if (!episode && !storyState) {
    const at = text.search(/===\s*CHARACTER ARCS\s*===/i);
    return { episode: (at >= 0 ? text.slice(0, at) : text).trim(), storyState: '', arcs };
  }
  return { episode, storyState, arcs };
}
