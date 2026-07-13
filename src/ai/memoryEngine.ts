import type { Project, RuntimeState, LlmMessage } from '../shared/types';
import { runCompletionWith } from './providers';
import { getPresetSettings } from './presetSettings';
import { SUMMARIZER_PROMPT } from './directorPrompt';
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

  const transcript = stale
    .map((m) => `${m.role === 'user' ? 'ИГРОК' : 'ИГРА'}: ${m.content}`)
    .join('\n\n');

  const toastId = pushToast('info', tt('Сжимаю память…', 'Summarizing memory…'));
  logEvent('info', 'memory', `Саммаризация: сворачиваю ${stale.length} сообщений`);
  try {
    const prompt = project.memoryConfig.summaryPrompt?.trim() || SUMMARIZER_PROMPT(12);
    const text = await summarize(project, prompt, transcript);
    updateToast(toastId, 'success', tt('Память обновлена', 'Memory updated'));
    logEvent('info', 'memory', 'Саммаризация выполнена');
    // Новая запись Хроники с диапазоном свёрнутых сообщений (для списка саммари).
    const fromMsg = state.memory.foldedMsgCount + 1;
    const toMsg = state.memory.foldedMsgCount + stale.length;
    const chronicle = text
      ? [...state.memory.chronicle, { id: uid('chr'), text, atTurn: state.turnCount, fromMsg, toMsg }]
      : state.memory.chronicle;
    // Сырой кусок сохраняем отдельно — не инжектится целиком, только через
    // векторный подсос релевантного (см. vectorEngine.ts).
    const rawArchive = [
      ...state.memory.rawArchive,
      { turn: state.turnCount, text: transcript.slice(0, 6000) },
    ];

    return {
      ...state,
      history: state.history.slice(state.history.length - keep),
      memory: await recompactChronicle(project, {
        ...state.memory,
        chronicle,
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

// Ре-саммаризация Хроники: когда записей > 15, сжимаем самые старые 10 в один акт
// (см. §10 исходного ТЗ — сохранено при переходе на модель «без глав»).
async function recompactChronicle(
  project: Project,
  memory: RuntimeState['memory']
): Promise<RuntimeState['memory']> {
  if (memory.chronicle.length <= 15) return memory;
  const toFold = memory.chronicle.slice(0, 10);
  const rest = memory.chronicle.slice(10);
  try {
    const transcript = toFold.map((c, i) => `[${i + 1}] ${c.text}`).join('\n');
    const text = await summarize(
      project,
      project.memoryConfig.summaryPrompt?.trim() || SUMMARIZER_PROMPT(15),
      transcript
    );
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
