import type { Project, RuntimeState, LlmMessage } from '../shared/types';
import { runCompletionWith } from './providers';
import { getPresetSettings } from './presetSettings';
import { SUMMARIZER_PROMPT } from './directorPrompt';
import { condenseAssistantTurn } from './promptBuilder';
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

async function summarize(project: Project, prompt: string, transcript: string): Promise<string> {
  return (
    await runCompletionWith(project.aiConfig.summaryConnection, 'summary', {
      system: prompt,
      messages: [{ role: 'user', content: transcript }],
      model: project.aiConfig.summarizerModel || undefined,
      temperature: 0.3,
    })
  ).trim();
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
  const K = Math.max(2, getPresetSettings().liveWindow);
  const keep = K * 2; // user+assistant per turn
  const everyN = Math.max(4, project.memoryConfig.summaryEveryN) * 2;
  // Триггер ТОЛЬКО по счётчику ходов (summaryEveryN) или принудительно. Раньше был
  // ещё overBudget по «сырой» истории (полный JSON каждого хода) — он превышал бюджет
  // почти всегда и запускал саммари КАЖДЫЙ ход, при этом не мог опустить контекст
  // (живое окно само крупнее бюджета). В контекст ИИ история теперь идёт сжатой
  // прозой, так что этот замер был некорректен. Оставляем чистый счётчик.
  const dueByCount = state.memory.messagesSinceSummary >= everyN;
  if ((!force && !dueByCount) || state.history.length <= keep) return state;

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
    const raw = await summarize(project, prompt, input);
    const { episode, storyState } = splitSummarySections(raw);

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
          'Свёртка не удалась (пустой ответ) — история сохранена, повторю на следующем ходу',
          'Summarization failed (empty answer) — history kept, will retry next turn'
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
    updateToast(toastId, 'success', tt('Память обновлена', 'Memory updated'));
    logEvent('info', 'memory', `Саммаризация выполнена (эпизод: ${episode ? 'да' : 'нет'}, снапшот: ${storyState ? 'да' : 'нет'})`);
    // Журнал эпизодов: append-only, хронологический.
    const fromMsg = state.memory.foldedMsgCount + 1;
    const toMsg = state.memory.foldedMsgCount + stale.length;
    const chronicle = episode
      ? [...state.memory.chronicle, { id: uid('chr'), text: episode, atTurn: state.turnCount, fromMsg, toMsg }]
      : state.memory.chronicle;
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
        // Снапшот заменяется новым; при сбое секции — остаётся прежний.
        storyState: storyState || state.memory.storyState,
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
    if (!text) return { ...memory, chronicle: rest };
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
