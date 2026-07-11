import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { usePlayerStore } from './playerStore';
import { getProject, getSave } from '../../storage/db';
import { stopAllMusic } from './audio';
import { Stage } from './components/Stage';
import { DialogueBox } from './components/DialogueBox';
import { StatsHUD } from './components/StatsHUD';
import { ChoiceMenu } from './components/ChoiceMenu';
import { Mixer } from './components/Mixer';
import { QuickActions } from './components/QuickActions';
import { EditPanel } from './components/EditPanel';
import { HistoryLog, SaveLoadPanel, MemoryPanel } from './components/Panels';
import { useT } from '../../shared/i18n';

type Setup = 'checking' | 'resume' | 'name' | 'play';

export function PlayerPage() {
  const { projectId } = useParams();
  const nav = useNavigate();
  const t = useT();
  const s = usePlayerStore();
  const [panel, setPanel] = useState<null | 'history' | 'saves' | 'memory' | 'edit'>(null);
  const [mixerOpen, setMixerOpen] = useState(false);
  const [genOpen, setGenOpen] = useState(false);
  const [setup, setSetup] = useState<Setup>('checking');
  const [name, setName] = useState('');

  useEffect(() => {
    if (!projectId) return;
    (async () => {
      const auto = await getSave(projectId, 0);
      if (auto) setSetup('resume');
      else {
        // Предзаполним имя протагониста именем persona-персонажа, если задан.
        const proj = await getProject(projectId);
        const prot = proj?.characters.find((c) => c.role === 'protagonist');
        setName(prot?.name || '');
        setSetup('name');
      }
    })();
    return () => stopAllMusic();
  }, [projectId]);

  if (setup === 'checking') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-ink text-gray-400">
        {t('player.loading')}
      </div>
    );
  }

  if (setup === 'resume') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-ink">
        <div className="card max-w-sm text-center">
          <h2 className="text-lg font-semibold mb-3">{t('player.resumeTitle')}</h2>
          <p className="text-sm text-gray-400 mb-4">{t('player.resumeFound')}</p>
          <div className="flex gap-2 justify-center">
            <button
              className="btn-primary"
              onClick={() => {
                setSetup('play');
                s.loadAndStart(projectId!, true);
              }}
            >
              {t('player.resume')}
            </button>
            <button
              className="btn-ghost"
              onClick={async () => {
                const proj = await getProject(projectId!);
                const prot = proj?.characters.find((c) => c.role === 'protagonist');
                setName(prot?.name || '');
                setSetup('name');
              }}
            >
              {t('player.restart')}
            </button>
          </div>
          <button className="text-xs text-gray-500 mt-4" onClick={() => nav('/library')}>
            {t('player.toLibrary')}
          </button>
        </div>
      </div>
    );
  }

  if (setup === 'name') {
    const start = () => {
      setSetup('play');
      s.loadAndStart(projectId!, false, name.trim());
    };
    return (
      <div className="min-h-screen flex items-center justify-center bg-ink">
        <div className="card max-w-sm w-full text-center">
          <h2 className="text-lg font-semibold mb-3">{t('player.nameTitle')}</h2>
          <input
            className="input mb-4 text-center"
            autoFocus
            placeholder={t('player.namePlaceholder')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && name.trim() && start()}
          />
          <div className="flex gap-2 justify-center">
            <button className="btn-primary" disabled={!name.trim()} onClick={start}>
              {t('player.start')}
            </button>
          </div>
          <button className="text-xs text-gray-500 mt-4" onClick={() => nav('/library')}>
            {t('player.toLibrary')}
          </button>
        </div>
      </div>
    );
  }

  if (s.loading || !s.project || !s.state) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-ink text-gray-400">
        {t('player.loading')}
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
        <CtrlBtn label={t('player.history')} onClick={() => setPanel('history')} />
        <CtrlBtn label={t('player.memory')} onClick={() => setPanel('memory')} />
        <CtrlBtn label={t('player.saves')} onClick={() => setPanel('saves')} />
        <CtrlBtn label={t('player.mixer')} onClick={() => setMixerOpen((v) => !v)} />
        <CtrlBtn label="🎨" title="Генерация ассетов" onClick={() => setGenOpen((v) => !v)} />
        <CtrlBtn label="✎" title="Правка в игре" onClick={() => setPanel('edit')} />
        <CtrlBtn label="↻" title={t('player.regen')} onClick={() => s.regenerate()} />
        <CtrlBtn label="✕" onClick={() => nav('/library')} />
      </div>

      <Mixer open={mixerOpen} onClose={() => setMixerOpen(false)} />
      <QuickActions open={genOpen} onClose={() => setGenOpen(false)} />

      {/* Chapter title card */}
      {s.chapterTitle && (
        <div
          className="absolute inset-0 z-30 bg-black/80 flex items-center justify-center cursor-pointer"
          onClick={() => s.dismissChapter()}
        >
          <div className="text-center">
            <div className="text-accent2 uppercase tracking-widest text-sm mb-2">
              {t('player.chapterDone')}
            </div>
            <div className="text-4xl font-bold">{s.chapterTitle}</div>
            <div className="text-gray-500 text-sm mt-4">{t('player.clickContinue')}</div>
          </div>
        </div>
      )}

      {/* Thinking spinner */}
      {s.thinking && (
        <div className="absolute inset-x-0 bottom-24 flex justify-center z-20">
          <div className="bg-black/70 rounded-full px-4 py-2 text-sm flex items-center gap-2">
            <span className="inline-block w-3 h-3 border-2 border-accent border-t-transparent rounded-full animate-spin" />
            {t('player.thinking')}
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
                {t('player.close')}
              </button>
              <button className="btn-primary !py-1 !px-3 text-xs" onClick={() => s.regenerate()}>
                {t('player.retry')}
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
              onFreeInput={(txt) => s.submitFreeInput(txt)}
            />
          ) : (
            <DialogueBox
              project={s.project}
              beat={currentBeat}
              hasMore={moreBeatsQueued}
              protagonistName={s.state.protagonistName}
              onAdvance={() => s.advance()}
            />
          )}
        </>
      )}

      <EditPanel open={panel === 'edit'} onClose={() => setPanel(null)} />

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
