import { create } from 'zustand';
import type { Project, RuntimeState, Beat, Choice, SaveSlot } from '../../shared/types';
import { initialRuntimeState } from '../../shared/factory';
import { runTurn } from '../../ai/gameEngine';
import { expandMacros } from '../../ai/macros';
import { getProject, putSave, getSave, saveProject } from '../../storage/db';
import { playMusic, playSfx, toggleMute } from './audio';
import { parseSlash, SLASH_HELP } from './slashCommands';

// currentMusicAssetId — это id ассета; для проигрывания нужен его blobKey.
function trackBlobKey(project: Project, assetId: string | null): string | null {
  if (!assetId) return null;
  return project.assets.find((a) => a.id === assetId)?.blobKey || null;
}

interface PlayerStore {
  project: Project | null;
  state: RuntimeState | null;
  // Beat playback
  queue: Beat[];
  visibleBeats: Beat[]; // beats revealed so far this turn
  phase: 'beats' | 'choices'; // beats still playing vs. choices revealed
  choices: Choice[];
  cg: string | null; // active cutscene CG assetId
  chapterTitle: string | null;
  // Status
  loading: boolean;
  thinking: boolean;
  error: string | null;
  statFlash: { statId: string; delta: number }[];

  loadAndStart: (projectId: string, resume?: boolean, protagonistName?: string) => Promise<void>;
  advance: () => void; // reveal next beat
  choose: (choice: Choice) => Promise<void>;
  submitFreeInput: (text: string) => Promise<void>;
  continueStory: () => Promise<void>;
  regenerate: () => Promise<void>;
  clearError: () => void;
  save: (slot: number, title: string) => Promise<void>;
  loadSlot: (slot: number) => Promise<void>;
  dismissChapter: () => void;
  // Правка проекта прямо в игре — общий источник истины с конструктором.
  // Мутация применяется к живому проекту (влияет на манифест следующего хода)
  // и сохраняется в IndexedDB.
  patchProject: (mutator: (p: Project) => void) => Promise<void>;
}

const AUTOSAVE_SLOT = 0;

export const usePlayerStore = create<PlayerStore>((set, get) => ({
  project: null,
  state: null,
  queue: [],
  visibleBeats: [],
  phase: 'beats',
  choices: [],
  cg: null,
  chapterTitle: null,
  loading: true,
  thinking: false,
  error: null,
  statFlash: [],

  async loadAndStart(projectId, resume, protagonistName = '') {
    set({ loading: true, error: null });
    const project = await getProject(projectId);
    if (!project) {
      set({ loading: false, error: 'Проект не найден' });
      return;
    }

    if (resume) {
      const save = await getSave(projectId, AUTOSAVE_SLOT);
      if (save) {
        applyLoadedState(set, project, save.state);
        set({ loading: false });
        return;
      }
    }

    const state = initialRuntimeState(project, protagonistName);
    set({ project, state, loading: false, queue: [], visibleBeats: [], choices: [], cg: null });
    // Seed the opening turn (макросы в стартовой сцене раскрываются).
    const opening = expandMacros(project.lore.openingScene, { project, state });
    await runAndApply(set, get, project, state, `[НАЧАЛО ИГРЫ] ${opening}`.trim());
  },

  advance() {
    const { queue, visibleBeats, phase } = get();
    if (phase !== 'beats') return;
    if (queue.length === 0) {
      // Last beat already shown — reveal choices.
      set({ phase: 'choices' });
      return;
    }
    const [next, ...rest] = queue;
    set({ queue: rest, visibleBeats: [...visibleBeats, next] });
  },

  async choose(choice) {
    const { state, project } = get();
    if (!state || !project) return;
    // Deduct cost if any.
    if (choice.cost) {
      const cur = state.statValues[choice.cost.statId] ?? 0;
      if (cur < choice.cost.amount) {
        set({ error: 'Недостаточно ресурса для этого выбора.' });
        return;
      }
      state.statValues[choice.cost.statId] = cur - choice.cost.amount;
    }
    // Выбор кнопкой → ИИ разворачивает его в реплику/действие героя (Блок B.1).
    await runAndApply(set, get, project, state, `[ВЫБОР] ${choice.text}`);
  },

  async continueStory() {
    const { state, project } = get();
    if (!state || !project) return;
    // Игрок продвигает историю без реплики (Блок I.1) — мир движется сам.
    await runAndApply(set, get, project, state, '[ПРОДОЛЖИТЬ]');
  },

  async submitFreeInput(text) {
    const { state, project } = get();
    if (!state || !project || !text.trim()) return;

    // Слэш-команды (Блок B.3).
    const slash = parseSlash(text, project);
    switch (slash.kind) {
      case 'none':
        break;
      case 'regen':
        await get().regenerate();
        return;
      case 'mute':
        toggleMute();
        return;
      case 'help':
        set({ error: SLASH_HELP });
        return;
      case 'setBackground':
        usePlayerStore.setState((st) => ({
          state: st.state ? { ...st.state, currentBackgroundId: slash.assetId } : st.state,
        }));
        await get().save(0, `Автосейв · ход ${state.turnCount}`);
        return;
      case 'move':
        await runAndApply(set, get, project, state, slash.text);
        return;
    }

    // Обычный ввод — ДОСЛОВНАЯ реплика героя (Блок B.2): ИИ не пишет за протагониста.
    await runAndApply(set, get, project, state, `[ДОСЛОВНО] ${text.trim()}`);
  },

  async regenerate() {
    const { project } = get();
    const state = get().state;
    if (!project || !state) return;
    // Roll back the last exchange from history and replay the same player move.
    const hist = state.history;
    if (hist.length < 2) return;
    const lastMove = hist[hist.length - 2];
    const rolledBack: RuntimeState = { ...state, history: hist.slice(0, -2) };
    await runAndApply(set, get, project, rolledBack, lastMove.content);
  },

  clearError() {
    set({ error: null });
  },

  async save(slot, title) {
    const { project, state } = get();
    if (!project || !state) return;
    const save: SaveSlot = {
      slot,
      projectId: project.id,
      savedAt: Date.now(),
      title,
      state,
    };
    await putSave(save);
  },

  async loadSlot(slot) {
    const { project } = get();
    if (!project) return;
    const save = await getSave(project.id, slot);
    if (save) applyLoadedState(set, project, save.state);
  },

  dismissChapter() {
    set({ chapterTitle: null });
  },

  async patchProject(mutator) {
    const cur = get().project;
    if (!cur) return;
    const next: Project = JSON.parse(JSON.stringify(cur));
    mutator(next);
    set({ project: next });
    await saveProject(next);
  },
}));

// Reveal a loaded state without replaying beats (show last turn fully).
function applyLoadedState(
  set: (partial: Partial<PlayerStore>) => void,
  project: Project,
  state: RuntimeState
) {
  const last = state.lastTurn;
  playMusic(trackBlobKey(project, state.currentMusicAssetId));
  set({
    project,
    state,
    queue: [],
    visibleBeats: last?.beats ?? [],
    phase: 'choices',
    choices: last?.choices ?? [],
    cg: last?.scene.cutsceneCgId ?? null,
    thinking: false,
    error: null,
    chapterTitle: null,
  });
}

// Core: run a turn against the LLM and apply its result to the store.
async function runAndApply(
  set: (partial: Partial<PlayerStore>) => void,
  get: () => PlayerStore,
  project: Project,
  baseState: RuntimeState,
  playerMove: string
) {
  set({ thinking: true, error: null, choices: [], statFlash: [] });
  try {
    const { turn, state } = await runTurn(project, baseState, playerMove);

    // Compute stat flashes vs. the pre-turn values.
    const flash: { statId: string; delta: number }[] = [];
    for (const s of project.stats) {
      const before = baseState.statValues[s.id] ?? s.initial;
      const after = state.statValues[s.id] ?? s.initial;
      if (after !== before) flash.push({ statId: s.id, delta: after - before });
    }

    // Scene fx: воспроизводим трек, подобранный движком под настроение.
    void playMusic(trackBlobKey(project, state.currentMusicAssetId));
    if (turn.scene.sfxId) void playSfx(trackBlobKey(project, turn.scene.sfxId));

    const [first, ...rest] = turn.beats;
    // Choices are stored now but the UI reveals them only once the beat queue empties.
    set({
      state,
      queue: rest,
      visibleBeats: first ? [first] : [],
      phase: turn.beats.length ? 'beats' : 'choices',
      choices: turn.choices,
      thinking: false,
      cg: turn.scene.cutsceneCgId,
      statFlash: flash,
      chapterTitle: turn.chapterEvent === 'chapter_end' ? `Глава ${baseState.memory.chapter}` : null,
    });

    // Autosave every turn.
    await get().save(AUTOSAVE_SLOT, `Автосейв · ход ${state.turnCount}`);
  } catch (e) {
    set({ thinking: false, error: (e as Error).message });
  }
}
