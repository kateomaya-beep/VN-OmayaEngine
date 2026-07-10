import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { usePlayerStore } from './playerStore';
import { getSave } from '../../storage/db';
import { stopAllMusic } from './audio';
import { Stage } from './components/Stage';
import { DialogueBox } from './components/DialogueBox';
import { StatsHUD } from './components/StatsHUD';
import { ChoiceMenu } from './components/ChoiceMenu';
import { HistoryLog, SaveLoadPanel, MemoryPanel } from './components/Panels';

export function PlayerPage() {
  const { projectId } = useParams();
  const nav = useNavigate();
  const s = usePlayerStore();
  const [panel, setPanel] = useState<null | 'history' | 'saves' | 'memory'>(null);
  const [resumePrompt, setResumePrompt] = useState<boolean | null>(null);

  // Ask to resume if an autosave exists.
  useEffect(() => {
    if (!projectId) return;
    (async () => {
      const auto = await getSave(projectId, 0);
      if (auto) setResumePrompt(true);
      else {
        setResumePrompt(false);
        s.loadAndStart(projectId, false);
      }
    })();
    return () => stopAllMusic();
  }, [projectId]);

  if (resumePrompt === true) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-ink">
        <div className="card max-w-sm text-center">
          <h2 className="text-lg font-semibold mb-3">Продолжить игру?</h2>
          <p className="text-sm text-gray-400 mb-4">Найден автосейв этого проекта.</p>
          <div className="flex gap-2 justify-center">
            <button
              className="btn-primary"
              onClick={() => {
                setResumePrompt(false);
                s.loadAndStart(projectId!, true);
              }}
            >
              Продолжить
            </button>
            <button
              className="btn-ghost"
              onClick={() => {
                setResumePrompt(false);
                s.loadAndStart(projectId!, false);
              }}
            >
              Начать заново
            </button>
          </div>
          <button className="text-xs text-gray-500 mt-4" onClick={() => nav('/library')}>
            ← в библиотеку
          </button>
        </div>
      </div>
    );
  }

  if (s.loading || !s.project || !s.state) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-ink text-gray-400">
        Загрузка…
      </div>
    );
  }

  const moreBeatsQueued = s.queue.length > 0;
  const currentBeat = s.visibleBeats[s.visibleBeats.length - 1] || null;
  const activeSpeakerId =
    currentBeat?.type === 'dialogue' ? currentBeat.characterId : undefined;
  const showChoices = s.phase === 'choices' && !s.thinking && s.choices.length > 0 && !s.cg;

  return (
    <div className="fixed inset-0 bg-black text-white overflow-hidden">
      <Stage
        project={s.project}
        backgroundId={s.state.currentBackgroundId}
        onScreen={s.cg ? [] : s.state.onScreen}
        cg={s.cg}
        activeSpeakerId={activeSpeakerId}
      />

      <StatsHUD project={s.project} state={s.state} flash={s.statFlash} />

      {/* Top-right controls */}
      <div className="absolute top-3 right-3 flex gap-1 z-20">
        <CtrlBtn label="История" onClick={() => setPanel('history')} />
        <CtrlBtn label="Память" onClick={() => setPanel('memory')} />
        <CtrlBtn label="Сейвы" onClick={() => setPanel('saves')} />
        <CtrlBtn label="↻" title="Перегенерировать ход" onClick={() => s.regenerate()} />
        <CtrlBtn label="✕" onClick={() => nav('/library')} />
      </div>

      {/* Chapter title card */}
      {s.chapterTitle && (
        <div
          className="absolute inset-0 z-30 bg-black/80 flex items-center justify-center cursor-pointer"
          onClick={() => s.dismissChapter()}
        >
          <div className="text-center">
            <div className="text-accent2 uppercase tracking-widest text-sm mb-2">Глава завершена</div>
            <div className="text-4xl font-bold">{s.chapterTitle}</div>
            <div className="text-gray-500 text-sm mt-4">нажмите, чтобы продолжить</div>
          </div>
        </div>
      )}

      {/* Thinking spinner */}
      {s.thinking && (
        <div className="absolute inset-x-0 bottom-24 flex justify-center z-20">
          <div className="bg-black/70 rounded-full px-4 py-2 text-sm flex items-center gap-2">
            <span className="inline-block w-3 h-3 border-2 border-accent border-t-transparent rounded-full animate-spin" />
            ИИ пишет сцену…
          </div>
        </div>
      )}

      {/* Error toast with retry */}
      {s.error && (
        <div className="absolute inset-x-0 bottom-24 flex justify-center z-30 px-4">
          <div className="bg-red-900/90 border border-red-500/50 rounded-xl px-4 py-3 text-sm max-w-md">
            <div className="mb-2">⚠️ {s.error}</div>
            <div className="flex gap-2 justify-end">
              <button className="btn-ghost !py-1 !px-3 text-xs" onClick={() => s.clearError()}>
                Закрыть
              </button>
              <button className="btn-primary !py-1 !px-3 text-xs" onClick={() => s.regenerate()}>
                Повторить
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Dialogue or choices */}
      {!s.thinking && !s.chapterTitle && (
        <>
          {showChoices ? (
            <ChoiceMenu
              project={s.project}
              state={s.state}
              choices={s.choices}
              onChoose={(c) => s.choose(c)}
              onFreeInput={(t) => s.submitFreeInput(t)}
            />
          ) : (
            <DialogueBox
              project={s.project}
              beat={currentBeat}
              hasMore={moreBeatsQueued}
              onAdvance={() => s.advance()}
            />
          )}
        </>
      )}

      <HistoryLog
        open={panel === 'history'}
        onClose={() => setPanel(null)}
        project={s.project}
        state={s.state}
      />
      <SaveLoadPanel
        open={panel === 'saves'}
        onClose={() => setPanel(null)}
        project={s.project}
        onSave={(slot) => s.save(slot, `Ручной сейв · ход ${s.state!.turnCount}`)}
        onLoad={(slot) => {
          s.loadSlot(slot);
          setPanel(null);
        }}
      />
      <MemoryPanel
        open={panel === 'memory'}
        onClose={() => setPanel(null)}
        state={s.state}
        onEditChapterSummary={(text) =>
          usePlayerStore.setState((st) => ({
            state: st.state
              ? { ...st.state, memory: { ...st.state.memory, currentChapterSummary: text } }
              : st.state,
          }))
        }
        onEditChronicle={(idx, text) =>
          usePlayerStore.setState((st) => {
            if (!st.state) return {};
            const chronicle = [...st.state.memory.chronicle];
            chronicle[idx] = text;
            return { state: { ...st.state, memory: { ...st.state.memory, chronicle } } };
          })
        }
      />
    </div>
  );
}

function CtrlBtn({
  label,
  onClick,
  title,
}: {
  label: string;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="bg-black/60 hover:bg-black/80 backdrop-blur rounded-lg px-3 py-1.5 text-xs"
    >
      {label}
    </button>
  );
}
