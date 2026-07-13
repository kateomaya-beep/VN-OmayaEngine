import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { usePlayerStore } from './playerStore';
import { getSave } from '../../storage/db';
import { stopAllMusic } from './audio';
import { Stage, type ActiveSprite } from './components/Stage';
import { DialogueBox } from './components/DialogueBox';
import { StatsHUD } from './components/StatsHUD';
import { TokenCounter } from './components/TokenCounter';
import { ChoiceMenu } from './components/ChoiceMenu';
import { Console } from './components/Console';
import { Mixer } from './components/Mixer';
import { QuickActions } from './components/QuickActions';
import { EditPanel } from './components/EditPanel';
import { HistoryPanel } from './components/HistoryPanel';
import { SaveLoadPanel } from './components/Panels';
import { useT } from '../../shared/i18n';
import { TopBar } from '../../app/TopBar';
import { formatClock } from '../../ai/gameMaster';

type Setup = 'checking' | 'resume' | 'play';

export function PlayerPage() {
  const { projectId } = useParams();
  const nav = useNavigate();
  const t = useT();
  const s = usePlayerStore();
  const [panel, setPanel] = useState<null | 'saves' | 'edit' | 'history'>(null);
  const [mixerOpen, setMixerOpen] = useState(false);
  const [genOpen, setGenOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [setup, setSetup] = useState<Setup>('checking');

  useEffect(() => {
    if (!projectId) return;
    (async () => {
      const auto = await getSave(projectId, 0);
      if (auto) setSetup('resume');
      else {
        setSetup('play');
        s.loadAndStart(projectId, false); // имя героя берётся из карточки протагониста
      }
    })();
    return () => stopAllMusic();
  }, [projectId]);

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
              onClick={() => {
                setSetup('play');
                s.loadAndStart(projectId!, false);
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

  if (s.loading || !s.project || !s.state) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-ink text-gray-400">
        {t('player.loading')}
      </div>
    );
  }

  const moreBeatsQueued = s.queue.length > 0;
  const currentBeat = s.visibleBeats[s.visibleBeats.length - 1] || null;
  // Активный говорящий на сцене — только текущий dialogue-beat с characterId (Блок A.1).
  const active: ActiveSprite | null =
    currentBeat?.type === 'dialogue' && currentBeat.characterId
      ? { characterId: currentBeat.characterId, emotion: currentBeat.emotion }
      : null;
  const showChoices = s.phase === 'choices' && !s.thinking && s.choices.length > 0 && !s.cg;
  const canContinue = s.phase === 'choices' && !s.thinking && !s.cg;

  return (
    <div className="fixed inset-0 bg-black text-white overflow-hidden">
      <Stage project={s.project} backgroundId={s.state.currentBackgroundId} active={active} cg={s.cg} />

      {/* Постоянная верхняя панель (общая с главным экраном) + игровое бургер-меню.
          В самом поле сцены игровых иконок больше нет (см. Batch 3 §3). */}
      <TopBar
        variant="player"
        project={s.project}
        onPatchProject={s.patchProject}
        menuSlot={
          <div className="relative">
            <button
              className="bg-black/40 hover:bg-black/60 rounded-lg px-3 py-1.5 text-sm"
              title="Меню игры"
              onClick={() => setMenuOpen((v) => !v)}
            >
              ☰
            </button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setMenuOpen(false)} />
                <div
                  className="absolute right-0 mt-1 z-40 w-48 rounded-lg bg-panel border border-white/10 shadow-xl py-1 text-sm"
                  onClick={() => setMenuOpen(false)}
                >
                  {/* Отношения/память/история переехали в Game Master (🎮) на верхней панели. */}
                  <MenuItem icon="📜" label="История" onClick={() => setPanel('history')} />
                  <MenuItem icon="💾" label={t('player.saves')} onClick={() => setPanel('saves')} />
                  <MenuItem icon="🔊" label={t('player.mixer')} onClick={() => setMixerOpen((v) => !v)} />
                  <MenuItem icon="🎨" label="Генерация ассетов" onClick={() => setGenOpen((v) => !v)} />
                  <MenuItem icon="✎" label="Правка в игре" onClick={() => setPanel('edit')} />
                  <MenuItem icon="↻" label={t('player.regen')} onClick={() => s.regenerate()} />
                </div>
              </>
            )}
          </div>
        }
      />

      <StatsHUD project={s.project} state={s.state} flash={s.statFlash} />
      <div className="absolute bottom-2 left-2 z-10">
        <TokenCounter project={s.project} state={s.state} />
      </div>

      {/* Внутриигровые часы/дата (вынесены галочкой в Game Master → Календарь). */}
      {s.state.gm.showClockInGame && formatClock(s.state.gm.clock) && (
        <div className="absolute top-16 right-3 z-10 bg-black/55 backdrop-blur rounded-lg px-3 py-1.5 text-sm text-gray-100">
          🗓 {formatClock(s.state.gm.clock)}
        </div>
      )}

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

      {/* Thinking spinner + отмена генерации */}
      {s.thinking && (
        <div className="absolute inset-x-0 bottom-28 flex justify-center z-20">
          <div className="bg-black/70 rounded-full pl-4 pr-2 py-2 text-sm flex items-center gap-2">
            <span className="inline-block w-3 h-3 border-2 border-accent border-t-transparent rounded-full animate-spin" />
            {t('player.thinking')}
            <button
              className="ml-1 rounded-full bg-white/10 hover:bg-white/20 px-2.5 py-1 text-xs"
              onClick={() => s.cancel()}
              title="Отменить генерацию"
            >
              ✕ Отменить
            </button>
          </div>
        </div>
      )}

      {/* Error toast with retry */}
      {s.error && (
        <div className="absolute inset-x-0 bottom-28 flex justify-center z-30 px-4">
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

      {/* Нижний стек: реплика → выборы → консоль (консоль всегда видна) */}
      {!s.chapterTitle && (
        <div className="absolute inset-x-0 bottom-0 z-10">
          {!s.thinking && currentBeat && (
            <DialogueBox
              project={s.project}
              beat={currentBeat}
              hasMore={moreBeatsQueued}
              protagonistName={s.state.protagonistName}
              onAdvance={() => s.advance()}
            />
          )}
          {showChoices && (
            <div className="mt-2">
              <ChoiceMenu
                project={s.project}
                state={s.state}
                choices={s.choices}
                onChoose={(c) => s.choose(c)}
              />
            </div>
          )}
          <Console
            disabled={s.thinking}
            value={s.draft}
            onValueChange={(t) => s.setDraft(t)}
            canContinue={canContinue}
            onSubmit={(txt) => s.submitFreeInput(txt)}
            onContinue={() => s.continueStory()}
            authorNote={s.state.authorNote}
            onAuthorNoteChange={(text) =>
              usePlayerStore.setState((st) => ({
                state: st.state ? { ...st.state, authorNote: text } : st.state,
              }))
            }
          />
        </div>
      )}

      <EditPanel open={panel === 'edit'} onClose={() => setPanel(null)} />
      <HistoryPanel open={panel === 'history'} onClose={() => setPanel(null)} />
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
    </div>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
}: {
  icon: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 px-3 py-2 hover:bg-white/10 text-left"
    >
      <span className="w-5 text-center">{icon}</span>
      <span>{label}</span>
    </button>
  );
}
