import type { Project, RuntimeState, LlmMessage } from '../shared/types';
import { runCompletion } from './providers';
import { SUMMARIZER_PROMPT } from './directorPrompt';
import { estimateTokens } from '../shared/utils';

// Three-layer memory management (see ТЗ §10).

export function historyTokens(history: LlmMessage[]): number {
  return history.reduce((sum, m) => sum + estimateTokens(m.content), 0);
}

// Summarize the oldest turns that fall outside the live window into the current
// chapter summary, then drop them from verbatim history. Runs in background;
// on any error it leaves history intact (live window temporarily longer).
export async function maybeCompress(project: Project, state: RuntimeState): Promise<RuntimeState> {
  const K = Math.max(2, project.aiConfig.liveWindow);
  const keep = K * 2; // user+assistant per turn
  const overBudget = historyTokens(state.history) > project.aiConfig.contextBudget;
  if (!overBudget || state.history.length <= keep) return state;

  const stale = state.history.slice(0, state.history.length - keep);
  if (!stale.length) return state;

  try {
    const transcript = stale
      .map((m) => `${m.role === 'user' ? 'ИГРОК' : 'ИГРА'}: ${m.content}`)
      .join('\n\n');
    const prior = state.memory.currentChapterSummary
      ? `Предыдущий конспект главы:\n${state.memory.currentChapterSummary}\n\nНовые ходы для добавления:\n`
      : '';
    const text = await runCompletion(project.aiConfig, {
      system: SUMMARIZER_PROMPT(12),
      messages: [{ role: 'user', content: prior + transcript }],
      model: project.aiConfig.summarizerModel || project.aiConfig.model,
      temperature: 0.3,
    });
    return {
      ...state,
      history: state.history.slice(state.history.length - keep),
      memory: { ...state.memory, currentChapterSummary: text.trim() },
    };
  } catch {
    return state; // graceful: keep verbatim history
  }
}

// Close current chapter: fold its summary into the chronicle and reset layer 2.
export async function closeChapter(project: Project, state: RuntimeState): Promise<RuntimeState> {
  const K = Math.max(2, project.aiConfig.liveWindow);
  const keep = K * 2;
  let chapterSummary = state.memory.currentChapterSummary;

  // Summarize any remaining verbatim turns so nothing is lost at the boundary.
  const tail = state.history.slice(-keep);
  try {
    if (tail.length) {
      const transcript = tail
        .map((m) => `${m.role === 'user' ? 'ИГРОК' : 'ИГРА'}: ${m.content}`)
        .join('\n\n');
      const prior = chapterSummary ? `Начало главы:\n${chapterSummary}\n\nОкончание главы:\n` : '';
      chapterSummary = (
        await runCompletion(project.aiConfig, {
          system: SUMMARIZER_PROMPT(15),
          messages: [{ role: 'user', content: prior + transcript }],
          model: project.aiConfig.summarizerModel || project.aiConfig.model,
          temperature: 0.3,
        })
      ).trim();
    }
  } catch {
    // fall back to whatever summary we have
  }

  const chronicle = [...state.memory.chronicle];
  if (chapterSummary) chronicle.push(chapterSummary);

  return {
    ...state,
    memory: {
      ...state.memory,
      chronicle,
      currentChapterSummary: '',
      chapter: state.memory.chapter + 1,
    },
  };
}
