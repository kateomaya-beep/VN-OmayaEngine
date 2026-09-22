import { create } from 'zustand';
import { usePlayerStore } from './playerStore';
import { applyUnitResult, planUnits, summarizeUnit, type ChapterScope } from '../../ai/chapterJobs';
import { pushToast, updateToast } from '../../shared/toast';
import { logEvent } from '../../shared/logStore';
import { uid } from '../../shared/utils';
import type { MemoryBookEntry } from '../../shared/types';

// ФОНОВАЯ СБОРКА ГЛАВ. Главы собираются по одной, и каждая сразу ложится в
// сохранение: остановили, закрыли вкладку, упала сеть — готовое не пропадает, а
// повторный запуск продолжит с того места, где остановились (уже описанные
// периоды пропускаются). Играть во время сборки можно.

interface JobState {
  running: boolean;
  done: number;
  total: number;
  failed: number;
  label: string;
  jobId?: string;
  stop: boolean;
}

export const useChapterJob = create<JobState>(() => ({
  running: false,
  done: 0,
  total: 0,
  failed: 0,
  label: '',
  stop: false,
}));

export function stopChapterJob(): void {
  if (useChapterJob.getState().running) useChapterJob.setState({ stop: true });
}

// Отменённые сборки (откат правки ассистента): глава, которая досчитывается в
// момент отмены, уже не должна лечь в память — её тут же убрали бы откатом.
const cancelled = new Set<string>();
export function cancelChapterJob(jobId: string): void {
  cancelled.add(jobId);
  if (useChapterJob.getState().jobId === jobId) stopChapterJob();
}

/** Сколько глав собрала бы сборка — для подписи кнопок. */
export function countUnits(scope: ChapterScope): number {
  const { project, state } = usePlayerStore.getState();
  if (!project || !state) return 0;
  try {
    return planUnits(project, state, scope).length;
  } catch {
    return 0;
  }
}

const SCOPE_LABEL: Record<ChapterScope['kind'], string> = {
  archive: 'Восстанавливаю главы из архива',
  fill: 'Заполняю меморибук',
  range: 'Собираю главы по ходам',
  chunk: 'Пересобираю главу',
};

export async function runChapterJob(
  scope: ChapterScope,
  opts: { source?: MemoryBookEntry['source']; jobId?: string } = {}
): Promise<{ created: number; failed: number; jobId: string }> {
  const jobId = opts.jobId || uid('job');
  if (useChapterJob.getState().running) {
    pushToast('info', 'Сборка глав уже идёт — дождитесь её или остановите.');
    return { created: 0, failed: 0, jobId };
  }
  const start = usePlayerStore.getState();
  if (!start.project || !start.state) return { created: 0, failed: 0, jobId };
  const projectId = start.project.id;
  const playthrough = start.playthroughId;
  const units = planUnits(start.project, start.state, scope);
  if (!units.length) {
    pushToast('info', 'Нечего собирать: весь этот кусок истории уже описан главами.');
    return { created: 0, failed: 0, jobId };
  }

  const label = SCOPE_LABEL[scope.kind];
  useChapterJob.setState({ running: true, done: 0, total: units.length, failed: 0, label, jobId, stop: false });
  const toastId = pushToast('info', `${label}: 0 из ${units.length}…`);
  logEvent('info', 'memory', `${label}: ${units.length} глав(ы) к сборке`);
  let created = 0;
  let failed = 0;
  try {
    for (let i = 0; i < units.length; i++) {
      if (useChapterJob.getState().stop) break;
      const st = usePlayerStore.getState();
      // Игрок вышел из игры или открыл другую партию — писать в неё нельзя.
      if (!st.project || !st.state || st.project.id !== projectId || st.playthroughId !== playthrough) {
        logEvent('warn', 'memory', 'Сборка глав остановлена: открыта другая игра');
        break;
      }
      const unit = units[i];
      try {
        const r = await summarizeUnit(st.project, st.state, unit, { source: opts.source ?? 'auto', jobId });
        const cur = usePlayerStore.getState();
        if (cancelled.has(jobId)) break;
        if (!cur.project || !cur.state || cur.project.id !== projectId || cur.playthroughId !== playthrough) break;
        const project = cur.project;
        cur.patchMemory((m) => {
          Object.assign(m, applyUnitResult(project, m, unit, r));
        });
        created++;
      } catch (e) {
        failed++;
        logEvent('error', 'memory', `Глава ходов ${unit.fromTurn}–${unit.toTurn} не собралась: ${(e as Error).message}`);
      }
      useChapterJob.setState({ done: i + 1, failed });
      updateToast(toastId, 'info', `${label}: ${i + 1} из ${units.length}${failed ? ` (не вышло: ${failed})` : ''}…`);
    }
    const stopped = useChapterJob.getState().stop;
    updateToast(
      toastId,
      failed && !created ? 'error' : 'success',
      `${stopped ? 'Остановлено' : 'Готово'}: собрано глав ${created}` +
        (failed ? `, не вышло ${failed} — запустите ещё раз, готовые пропустятся` : '')
    );
  } finally {
    useChapterJob.setState({ running: false, stop: false });
  }
  return { created, failed, jobId };
}
