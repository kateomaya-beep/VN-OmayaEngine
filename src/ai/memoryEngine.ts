import type { Project, RuntimeState, LlmMessage } from '../shared/types';
import { runCompletionWith } from './providers';
import { getPresetSettings } from './presetSettings';
import { SUMMARIZER_PROMPT } from './directorPrompt';
import { condenseAssistantTurn, lastFixedContextTokens } from './promptBuilder';
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
// Сколько сырого текста периода хранить в архиве. Из него можно пересобрать
// свёртку вручную, поэтому запас нужен приличный.
const RAW_ARCHIVE_CHARS = 20000;

export function historyTokens(history: LlmMessage[]): number {
  return history.reduce((sum, m) => sum + estimateTokens(m.content), 0);
}

// Запасная доля бюджета под живую историю — на первый ход, пока запрос ещё ни разу
// не собирался и реальный размер системной части неизвестен.
const LIVE_HISTORY_SHARE = 0.45;
// Какую часть СВОБОДНОГО места (бюджет минус системная часть) отдаём дословной
// истории. Остаток — запас на рост системной части между свёртками (журнал
// эпизодов и снапшот прибавляют после каждой свёртки).
const FREE_SPACE_SHARE = 0.85;

// Сколько токенов может занимать ещё не свёрнутая история. Считаем по РЕАЛЬНОМУ
// размеру системной части прошлого запроса, а не по грубой доле бюджета.
export function liveHistoryAllowance(budget: number): number {
  const fixed = lastFixedContextTokens();
  if (!fixed) return Math.max(1500, Math.round(budget * LIVE_HISTORY_SHARE));
  return Math.max(1500, Math.round((budget - fixed) * FREE_SPACE_SHARE));
}

// Насколько ниже лимита опускаем живую историю при свёртке (запас, чтобы не
// сворачивать каждые пару ходов).
const HYSTERESIS = 0.6;

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
      m.role === 'assistant' ? condenseAssistantTurn(m.content, project, state) ?? m.content : m.content;
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
      m.role === 'assistant' ? condenseAssistantTurn(m.content, project, state) ?? m.content : m.content;
    return sum + estimateTokens(text);
  }, 0);
}

// Свёртке нужен явный потолок ответа: без него шлюзы режут по своему дефолту
// (512/1024 токена). Но и 3000 не хватало — двухсекционный ответ обрывался на
// «CURRENT SITUATION» в конце снапшота. Дефолт 8000, правится в настройках саммари.
const SUMMARY_MAX_TOKENS_FALLBACK = 8000;
const summaryTokens = (project: Project) =>
  Math.min(32000, Math.max(1000, project.memoryConfig.summaryMaxTokens ?? SUMMARY_MAX_TOKENS_FALLBACK));

async function summarize(project: Project, prompt: string, transcript: string): Promise<string> {
  return (
    await runCompletionWith(project.aiConfig.summaryConnection, 'summary', {
      system: prompt,
      messages: [{ role: 'user', content: transcript }],
      model: project.aiConfig.summarizerModel || undefined,
      temperature: 0.3,
      maxTokens: summaryTokens(project),
    })
  ).trim();
}

// Пересборка ТОЛЬКО живого снапшота — по всему, что есть: журнал эпизодов
// (хронология) + текущий снапшот. Журнал переписывать не нужно, он append-only;
// а снапшот, наоборот, полезно пересобрать, если он обрезался или устарел.
const STATE_REBUILD_PROMPT = `You rebuild the living STORY STATE snapshot of an interactive story
from its chronological episode log and the previous snapshot. Output ONLY the
snapshot body — no preamble, no episode list, no markers.

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
lose a fact from the previous snapshot unless the log supersedes it, and finish
every section (an unfinished snapshot is worse than a short one). Facts only,
in ENGLISH.`;

export async function rebuildStoryState(
  project: Project,
  memory: RuntimeState['memory']
): Promise<string> {
  const log = memory.chronicle.map((c, i) => `[Period ${i + 1}${c.atTurn ? `, up to turn ${c.atTurn}` : ''}]\n${c.text}`).join('\n\n');
  if (!log.trim() && !memory.storyState?.trim()) throw new Error('Нечего пересобирать: нет ни журнала, ни снапшота');
  const input = [
    memory.storyState?.trim() ? `PREVIOUS SNAPSHOT:\n${memory.storyState.trim()}` : '',
    log.trim() ? `EPISODE LOG (oldest → newest):\n${log}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  const raw = await summarize(project, STATE_REBUILD_PROMPT, input);
  // Модель может по привычке обернуть ответ маркерами — снимаем.
  const { storyState } = splitSummarySections(raw);
  const text = (storyState || raw).trim();
  if (text.length < MIN_EPISODE_CHARS) throw new Error('Модель вернула пустой ответ — попробуйте ещё раз');
  logEvent('info', 'memory', `Снапшот состояния пересобран вручную (${text.length} симв.)`);
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
): Promise<{ raw: string; episode: string; storyState: string }> {
  const first = await summarize(project, prompt, input);
  const a = splitSummarySections(first);
  if (a.episode.trim().length >= MIN_EPISODE_CHARS) return { raw: first, ...a };

  logEvent('warn', 'memory', 'Свёртка вышла пустой — повторяю сразу же (короче вход, жёстче формат)');
  const second = await summarize(
    project,
    `${prompt}\n\nIMPORTANT: output BOTH marked sections and never return an empty answer. Facts only, no preamble.`,
    transcriptOnly
  );
  const b = splitSummarySections(second);
  return { raw: second, ...b };
}

// Summarize the oldest turns that fall outside the live window into a new
// chronicle entry, then drop them from verbatim history. Runs in background;
// on any error it leaves history intact (live window temporarily longer, счётчик
// не сбрасывается — попробуем на следующем ходу).
export async function maybeCompress(
  project: Project,
  state: RuntimeState,
  force = false
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
  if (dueBySize && !dueByCount && !force) {
    logEvent(
      'info',
      'memory',
      `Свёртка по объёму: живая история ~${liveTokens} ток. при лимите ~${allowance} ` +
        `(бюджет ${ps.contextBudget}). Сворачиваю, пока ходы не начали выпадать из контекста.`
    );
  }

  const stale = state.history.slice(0, state.history.length - keep);
  if (!stale.length) return state;

  // Транскрипт для саммарайзера — ПРОЗОЙ, а не сырым JSON хода. Сырые ответы несут
  // служебные поля (id, эмоции, наряды, statChanges) и раздували вход свёртки в 3–5
  // раз: на 30 ходах это десятки тысяч токенов, отсюда «ошибка автосаммари» на
  // рабочем API. Плюс жёсткий потолок по символам — режем самые старые.
  const MAX_TRANSCRIPT_CHARS = 60000;
  const lines = stale.map(
    (m) =>
      `${m.role === 'user' ? 'ИГРОК' : 'ИГРА'}: ${
        m.role === 'assistant' ? condenseAssistantTurn(m.content, project, state) ?? m.content : m.content
      }`
  );
  let transcript = lines.join('\n\n');
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    let start = 0;
    let len = transcript.length;
    while (start < lines.length - 1 && len > MAX_TRANSCRIPT_CHARS) {
      len -= lines[start].length + 2;
      start++;
    }
    transcript = lines.slice(start).join('\n\n');
    logEvent('warn', 'memory', `Транскрипт свёртки обрезан: пропущено ${start} самых старых сообщений`);
  }

  const toastId = pushToast('info', tt('Сжимаю память…', 'Summarizing memory…'));
  logEvent('info', 'memory', `Саммаризация: сворачиваю ${stale.length} сообщений`);
  try {
    const prompt = project.memoryConfig.summaryPrompt?.trim() || SUMMARIZER_PROMPT(project.memoryConfig.minorEventsLimit ?? 10);
    // ДВУХЧАСТНАЯ ПАМЯТЬ (Horae-стиль): на вход — прежний живой снапшот состояния +
    // новые ходы; на выходе — (1) хронологическая запись-эпизод, которая ДОБАВЛЯЕТСЯ
    // в журнал и больше никогда не переписывается, и (2) обновлённый снапшот,
    // ЗАМЕНЯЮЩИЙ прежний. Так прошлые события видны ИИ в хронологическом порядке и
    // не искажаются повторными пересборками, а «текущее состояние» всегда одно.
    const prevState = state.memory.storyState?.trim() || '';
    const input = prevState
      ? `CURRENT STORY STATE (snapshot to update):\n${prevState}\n\n=== NEW TURNS SINCE THAT SNAPSHOT ===\n${transcript}`
      : transcript;
    const { raw, episode, storyState } = await summarizeWithRetry(project, prompt, input, transcript);

    // КРИТИЧНО: историю режем ТОЛЬКО если свёртка реально получилась. Пустой,
    // обрезанный или мусорный ответ раньше проходил дальше по коду — запись в
    // журнал не добавлялась, а сообщения из истории всё равно удалялись. Кусок
    // сюжета исчезал бесследно: и в контексте его нет, и в журнале нет.
    // Теперь при неудаче состояние возвращается КАК ЕСТЬ: история цела, счётчик
    // не сброшен — движок повторит свёртку на следующем ходу.
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
      return state;
    }
    // Журнал эпизодов: append-only, хронологический (нужен и для пересборки снапшота).
    const fromMsg = state.memory.foldedMsgCount + 1;
    const toMsg = state.memory.foldedMsgCount + stale.length;
    const chronicle = episode
      ? [...state.memory.chronicle, { id: uid('chr'), text: episode, atTurn: state.turnCount, fromMsg, toMsg }]
      : state.memory.chronicle;

    updateToast(toastId, 'success', tt('Память обновлена', 'Memory updated'));
    logEvent(
      'info',
      'memory',
      `Саммаризация выполнена: эпизод ${episode.trim().length} симв., снапшот ${storyState.trim().length} симв. ` +
        `(ответ целиком ${raw.length} симв.)`
    );
    // Снапшот несёт отношения и «где мы сейчас». Пустая секция при непустом
    // эпизоде — почти всегда обрыв ответа по лимиту токенов: эпизод успел, а
    // состояние нет. Молча оставлять прежний снапшот нельзя — он устареет.
    // Снапшот НЕ ОБНОВИЛСЯ (обрыв ответа). Оставлять прежний нельзя: он объявляет
    // себя «положением дел сейчас» и тянет сюжет назад, к моменту старой свёртки —
    // отсюда «ход идёт сразу после старого саммари, хотя прошёл кусок истории» и
    // хождение сюжета по кругу. Пересобираем снапшот отдельным запросом по журналу.
    let freshState = storyState.trim();
    if (!freshState) {
      logEvent(
        'warn',
        'memory',
        'Секция STORY STATE пуста (обрыв ответа) — пересобираю снапшот отдельным запросом по журналу эпизодов'
      );
      try {
        freshState = await rebuildStoryState(project, { ...state.memory, chronicle });
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
    // Сырой кусок сохраняем отдельно — не инжектится целиком, только через
    // векторный подсос релевантного (см. vectorEngine.ts).
    const rawArchive = [
      ...state.memory.rawArchive,
      { turn: state.turnCount, text: transcript.slice(0, RAW_ARCHIVE_CHARS) },
    ];

    return {
      ...state,
      history: state.history.slice(state.history.length - keep),
      memory: await recompactChronicle(project, {
        ...state.memory,
        chronicle,
        // Снапшот заменяется новым (или пересобранным). Метку возраста ставим ТОЛЬКО
        // при успехе: устаревший снапшот так и останется помеченным старым ходом.
        storyState: freshState || state.memory.storyState,
        storyStateAtTurn: freshState ? state.turnCount : state.memory.storyStateAtTurn,
        foldedMsgCount: toMsg,
        rawArchive,
        messagesSinceSummary: 0,
      }),
    };
  } catch (e) {
    updateToast(
      toastId,
      'error',
      tt('Ошибка автосаммари: ', 'Auto-summary error: ') + (e as Error).message
    );
    logEvent('error', 'memory', 'Саммаризация не удалась: ' + (e as Error).message);
    return state; // graceful: keep verbatim history, retry next turn
  }
}

// Разбор архивного транскрипта обратно в сообщения. Архив пишется строками вида
// «ИГРОК: …» / «ИГРА: …» через пустую строку — значит, свёрнутый период можно
// вернуть в живую историю дословно, а не только пересказом. Это спасает даже то,
// что «утрачено»: текст периода лежит в архиве, даже если записи в журнале нет.
export function parseArchivedTranscript(text: string): LlmMessage[] {
  const parts = (text || '').split(/\n\n(?=(?:ИГРОК|ИГРА|PLAYER|GAME):\s)/);
  const out: LlmMessage[] = [];
  for (const part of parts) {
    const m = /^(ИГРОК|ИГРА|PLAYER|GAME):\s([\s\S]*)$/.exec(part.trim());
    if (!m) continue;
    const content = m[2].trim();
    if (!content) continue;
    out.push({ role: m[1] === 'ИГРОК' || m[1] === 'PLAYER' ? 'user' : 'assistant', content });
  }
  return out;
}

// Пересобрать свёртку из СЫРОГО архива периода (мастерская саммари). Нужна в двух
// случаях: свёртка получилась куцей/кривой, и её хочется переделать; либо запись
// вообще не появилась (старый баг терял период целиком). Текущий снапшот состояния
// при этом НЕ трогаем: пересборка старого куска не должна откатывать «где мы сейчас».
export async function resummarizeArchived(
  project: Project,
  memory: RuntimeState['memory'],
  archiveIndex: number
): Promise<RuntimeState['memory']> {
  const chunk = memory.rawArchive[archiveIndex];
  if (!chunk?.text?.trim()) throw new Error('В архиве нет текста этого периода');
  const prompt =
    project.memoryConfig.summaryPrompt?.trim() || SUMMARIZER_PROMPT(project.memoryConfig.minorEventsLimit ?? 10);
  const raw = await summarize(project, prompt, chunk.text);
  const { episode } = splitSummarySections(raw);
  const text = episode.trim();
  if (text.length < MIN_EPISODE_CHARS) throw new Error('Модель вернула пустой ответ — попробуйте ещё раз');

  const chronicle = [...memory.chronicle];
  const at = chronicle.findIndex((c) => c.atTurn === chunk.turn);
  if (at >= 0) {
    chronicle[at] = { ...chronicle[at], text };
  } else {
    // Записи за этот период нет — вставляем на её хронологическое место.
    const entry = { id: uid('chr'), text, atTurn: chunk.turn, fromMsg: 0, toMsg: 0 };
    const pos = chronicle.findIndex((c) => c.atTurn > chunk.turn);
    chronicle.splice(pos < 0 ? chronicle.length : pos, 0, entry);
  }
  logEvent('info', 'memory', `Свёртка периода (ход ${chunk.turn}) пересобрана вручную`);
  return { ...memory, chronicle };
}

// Режет ответ саммарайзера на секции === EPISODE === / === STORY STATE ===.
// Нет маркеров (кастомный промпт юзера) → весь текст считается эпизодом, снапшот
// не трогаем — хронология не страдает в любом случае.
export function splitSummarySections(raw: string): { episode: string; storyState: string } {
  const text = (raw || '').trim();
  const epMatch = text.match(/===\s*EPISODE\s*===([\s\S]*?)(?====\s*STORY STATE\s*===|$)/i);
  const stMatch = text.match(/===\s*STORY STATE\s*===([\s\S]*)$/i);
  const episode = (epMatch?.[1] || '').trim();
  const storyState = (stMatch?.[1] || '').trim();
  if (!episode && !storyState) return { episode: text, storyState: '' };
  return { episode, storyState };
}

// Ре-саммаризация журнала: когда эпизодов > 15, сжимаем самые старые 10 в один
// «акт» — ХРОНОЛОГИЧЕСКИ, простым конденс-промптом (не полным саммарайзером,
// который вернул бы двухсекционный формат).
const CONDENSE_PROMPT = `You receive numbered chronological episode notes from an interactive story.
Condense them into ONE compact chronological digest: keep every plot-relevant
event and its order, drop repetition and trivia. 8-14 numbered points, facts
only, in ENGLISH. Output only the digest.`;

async function recompactChronicle(
  project: Project,
  memory: RuntimeState['memory']
): Promise<RuntimeState['memory']> {
  if (memory.chronicle.length <= 15) return memory;
  const toFold = memory.chronicle.slice(0, 10);
  const rest = memory.chronicle.slice(10);
  try {
    const transcript = toFold.map((c, i) => `[${i + 1}] ${c.text}`).join('\n');
    const text = await summarize(project, CONDENSE_PROMPT, transcript);
    // Пустой ответ = сжатия не было. Раньше 10 самых старых эпизодов при этом
    // просто выбрасывались — журнал терял начало истории молча.
    if (!text) {
      logEvent('warn', 'memory', 'Уплотнение журнала вернуло пустой ответ — журнал оставлен как есть');
      return memory;
    }
    const folded = {
      id: uid('chr'),
      text,
      atTurn: toFold[toFold.length - 1].atTurn,
      fromMsg: toFold[0].fromMsg,
      toMsg: toFold[toFold.length - 1].toMsg,
    };
    return { ...memory, chronicle: [folded, ...rest] };
  } catch {
    return memory; // не критично — попробуем на следующем триггере
  }
}
