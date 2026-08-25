import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { usePlayerStore } from './playerStore';
import { isDefaultSpriteDisplay, normalizeNarrativeMode } from '../../shared/types';
import { LaunchScreen } from './components/LaunchScreen';
import { stopAllMusic } from './audio';
import { Stage, type ActiveSprite } from './components/Stage';
import { DialogueBox } from './components/DialogueBox';
import { RpChat } from './components/RpChat';
import { StatsHUD } from './components/StatsHUD';
import { ChoiceMenu } from './components/ChoiceMenu';
import { Console } from './components/Console';
import { Mixer } from './components/Mixer';
import { QuickActions } from './components/QuickActions';
import { CgStudio } from './components/CgStudio';
import { PhoneFloatingIcon, PhoneWindow } from './components/Phone';
import { EditPanel } from './components/EditPanel';
import { HistoryPanel } from './components/HistoryPanel';
import { AuthorNotesPanel } from './components/AuthorNotesPanel';
import { SaveLoadPanel } from './components/Panels';
import { WorkshopPanel } from './components/WorkshopPanel';
import { WardrobePanel } from './components/WardrobePanel';
import { themeVars, ensureFontLink, loadGlobalTheme } from './playerTheme';
import { useT } from '../../shared/i18n';
import { useGlobalNotes } from '../../shared/globalNotes';
import { TopBar } from '../../app/TopBar';

type Setup = 'launch' | 'play';

export function PlayerPage() {
  const { projectId } = useParams();
  const nav = useNavigate();
  const t = useT();
  const s = usePlayerStore();
  // Универсальные заметки (все проекты) — для индикатора на иконке заметок.
  const globalNotes = useGlobalNotes((g) => g.notes);
  const [panel, setPanel] = useState<null | 'saves' | 'edit' | 'history'>(null);
  const [mixerOpen, setMixerOpen] = useState(false);
  const [genOpen, setGenOpen] = useState(false);
  const [cgStudioOpen, setCgStudioOpen] = useState(false);
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [workshopOpen, setWorkshopOpen] = useState(false);
  const [wardrobeOpen, setWardrobeOpen] = useState(false);
  // Экран запуска (Batch 5.2): Продолжить / Загрузить / Новая история.
  const [setup, setSetup] = useState<Setup>('launch');
  // Оформление плеера (мини-мастерская) — ПЕР-ПРОЕКТНОЕ: тема живёт в project.playerTheme.
  // Если у проекта её нет — берём прежнюю глобальную (back-compat), иначе дефолт.
  const theme = s.project?.playerTheme ?? loadGlobalTheme();

  useEffect(() => {
    return () => stopAllMusic();
  }, [projectId]);

  // Подгружаем шрифт темы при входе в плеер / смене ссылки.
  useEffect(() => {
    ensureFontLink(theme.fontUrl);
  }, [theme.fontUrl]);

  if (setup === 'launch') {
    if (!projectId) return null;
    return <LaunchScreen projectId={projectId} onStarted={() => setSetup('play')} />;
  }

  if (s.loading || !s.project || !s.state) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-ink text-gray-400">
        {t('player.loading')}
      </div>
    );
  }

  // Режим повествования решает, чем занят экран: сценой со спрайтами или лентой
  // переписки. Всё вокруг (верхняя панель, панели, сейвы, Game Master) — общее.
  const rp = normalizeNarrativeMode(s.project.mode) === 'rp';
  const notesPresent =
    s.state.authorNotes.some((n) => n.text.trim()) || globalNotes.some((n) => n.text.trim());

  const moreBeatsQueued = s.queue.length > 0;
  const currentBeat = s.visibleBeats[s.visibleBeats.length - 1] || null;
  // Динамический фон: фон текущего бита (движок протянул его вперёд), иначе — фон хода.
  const bgId = (currentBeat && 'bg' in currentBeat ? currentBeat.bg : undefined) ?? s.state.currentBackgroundId;
  // Активный говорящий на сцене — только текущий dialogue-beat с characterId (Блок A.1).
  // На нарративе/мыслях спрайта нет (плавно гаснет кроссфейдом).
  const active: ActiveSprite | null =
    currentBeat?.type === 'dialogue' && currentBeat.characterId
      ? { characterId: currentBeat.characterId, emotion: currentBeat.emotion, outfit: currentBeat.outfit }
      : null;
  const showChoices = s.phase === 'choices' && !s.thinking && s.choices.length > 0 && !s.cg;
  const canContinue = s.phase === 'choices' && !s.thinking && !s.cg;

  return (
    <div className="fixed inset-0 bg-black text-white overflow-hidden" style={themeVars(theme)}>
      {!rp && <Stage project={s.project} backgroundId={bgId} active={active} cg={s.cg} />}

      {/* Постоянная верхняя панель (общая с главным экраном) + игровое бургер-меню.
          В самом поле сцены игровых иконок больше нет (см. Batch 3 §3). */}
      <TopBar
        variant="player"
        project={s.project}
        onPatchProject={s.patchProject}
        right={
          <div className="relative">
            <button
              className="w-[34px] h-[34px] rounded-[10px] flex items-center justify-center text-[#e5deF7] transition-colors bg-white/[0.04] border border-[rgba(180,150,255,0.22)] hover:bg-[rgba(160,110,255,0.16)] hover:border-[rgba(190,150,255,0.55)] hover:shadow-[0_0_12px_rgba(170,120,255,0.35)]"
              title="Меню игры"
              onClick={() => setMenuOpen((v) => !v)}
            >
              ☰
            </button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setMenuOpen(false)} />
                <div
                  className="absolute right-0 mt-1.5 z-40 w-52 rounded-[14px] py-1.5 text-sm bg-[rgba(16,13,24,0.92)] border border-[rgba(180,150,255,0.2)] shadow-[0_20px_60px_rgba(0,0,0,0.6)] backdrop-blur-xl"
                  onClick={() => setMenuOpen(false)}
                >
                  {/* Отношения/память/история переехали в Game Master (🎮) на верхней панели. */}
                  <MenuItem icon="📜" label="История" onClick={() => setPanel('history')} />
                  <MenuItem icon="💾" label={t('player.saves')} onClick={() => setPanel('saves')} />
                  {!rp && <MenuItem icon="🔊" label={t('player.mixer')} onClick={() => setMixerOpen((v) => !v)} />}
                  {/* Спрайты, фоны, музыка и телефон живут в сцене — в текстовом
                      режиме их попросту некуда показать. */}
                  {!rp && <MenuItem icon="👗" label="Гардероб" onClick={() => setWardrobeOpen(true)} />}
                  <MenuItem icon="🎨" label="Оформление" onClick={() => setWorkshopOpen(true)} />
                  {!rp && <MenuItem icon="🎬" label="CG-студия" onClick={() => setCgStudioOpen(true)} />}
                  {!rp && <MenuItem icon="📱" label="Телефон" onClick={() => setPhoneOpen(true)} />}
                  {!rp && <MenuItem icon="🖼" label="Генерация фонов" onClick={() => setGenOpen((v) => !v)} />}
                  <MenuItem icon="✎" label="Правка в игре" onClick={() => setPanel('edit')} />
                  {/* В РП перегенерация не выбрасывает прошлый ответ, а добавляет
                      вариант — прошлый остаётся, между ними можно ходить стрелками. */}
                  <MenuItem
                    icon="↻"
                    label={rp ? 'Ещё вариант ответа' : t('player.regen')}
                    onClick={() => (rp ? s.addSwipe() : s.regenerate())}
                  />
                </div>
              </>
            )}
          </div>
        }
      />

      {/* HUD: календарь/локация + статы — единая стеклянная плашка (StatsHUD).
          В ленте переписки она перекрывала бы текст, а часы и статы и так видны в
          Game Master на верхней панели. */}
      {!rp && <StatsHUD project={s.project} state={s.state} flash={s.statFlash} />}

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

      {/* Thinking spinner + отмена генерации. В ленте переписки он свой — прямо
          под последним сообщением, где его и ждут. */}
      {s.thinking && !rp && (
        <div className="absolute inset-x-0 bottom-28 flex justify-center z-20">
          <div className="bg-black/70 rounded-full pl-4 pr-2 py-2 text-sm flex items-center gap-2">
            <span className="inline-block w-3 h-3 border-2 border-[var(--pl-accent)] border-t-transparent rounded-full animate-spin" />
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

      {rp && <RpChat hasNotes={notesPresent} onOpenNotes={() => setNotesOpen(true)} />}

      {/* Нижний стек: реплика → выборы → консоль (консоль всегда видна) */}
      {!rp && !s.chapterTitle && (
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
            hasNotes={notesPresent}
            onOpenNotes={() => setNotesOpen(true)}
          />
        </div>
      )}

      <EditPanel open={panel === 'edit'} onClose={() => setPanel(null)} />
      <HistoryPanel open={panel === 'history'} onClose={() => setPanel(null)} />
      <AuthorNotesPanel open={notesOpen} onClose={() => setNotesOpen(false)} />
      <SaveLoadPanel open={panel === 'saves'} onClose={() => setPanel(null)} />
      <CgStudio open={cgStudioOpen} onClose={() => setCgStudioOpen(false)} />
      {!rp && <PhoneFloatingIcon onOpen={() => setPhoneOpen(true)} />}
      <PhoneWindow open={phoneOpen} onClose={() => setPhoneOpen(false)} />
      <WardrobePanel open={wardrobeOpen} onClose={() => setWardrobeOpen(false)} />
      <WorkshopPanel
        open={workshopOpen}
        onClose={() => setWorkshopOpen(false)}
        theme={theme}
        onChange={(patch) =>
          s.patchProject((p) => {
            p.playerTheme = { ...(p.playerTheme ?? theme), ...patch };
          })
        }
        project={s.project}
        onPatchCharacter={(characterId, display) =>
          s.patchProject((p) => {
            const c = p.characters.find((x) => x.id === characterId);
            if (!c) return;
            // «Как у всех» не храним — иначе в каждом проекте копились бы
            // пустые записи, ничего не меняющие.
            c.spriteDisplay = isDefaultSpriteDisplay(display) ? undefined : display;
          })
        }
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
      className="w-full flex items-center gap-3 px-3 py-2 hover:bg-[rgba(160,110,255,0.16)] text-left"
    >
      <span className="w-5 text-center">{icon}</span>
      <span>{label}</span>
    </button>
  );
}
