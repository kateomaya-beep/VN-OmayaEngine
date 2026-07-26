import { create } from 'zustand';
import type { Project, RuntimeState, Beat, Choice, SaveSlot, GameMasterState, MemoryState, AuthorNote, PhoneState } from '../../shared/types';
import { initialPhoneState } from '../../shared/types';
import { initialRuntimeState } from '../../shared/factory';
import { runTurn, pickTrackForMood } from '../../ai/gameEngine';
import { generatePhoneReply } from '../../ai/phoneChat';
import { expandMacros } from '../../ai/macros';
import { getProject, putSave, saveProject, deleteSave } from '../../storage/db';
import {
  listPlaythroughs,
  activePlaythrough,
  deleteAllPlaythroughs,
  LEGACY_PLAYTHROUGH,
  type PlaythroughInfo,
} from '../../storage/playthroughs';
import { playMusic, playSfx, toggleMute } from './audio';
import { parseSlash, SLASH_HELP } from './slashCommands';
import { logEvent } from '../../shared/logStore';
import { uid } from '../../shared/utils';

// currentMusicAssetId — это id ассета; для проигрывания нужен его blobKey.
function trackBlobKey(project: Project, assetId: string | null): string | null {
  if (!assetId) return null;
  return project.assets.find((a) => a.id === assetId)?.blobKey || null;
}

// Транзиентное «что сейчас играет» — для мид-турн смены музыки (Batch 6 §1). Не сейв:
// при загрузке пересевается из состояния. Позволяет переключать трек по мере
// показа битов с новым настроением, не дёргая один и тот же трек лишний раз.
let playingMood: string | null = null;
let playingAssetId: string | null = null;
function seedPlaying(mood: string | null, assetId: string | null): void {
  playingMood = mood;
  playingAssetId = assetId;
}
function switchMood(project: Project, mood: string | null | undefined): void {
  if (!mood || mood === playingMood) return;
  const t = pickTrackForMood(project, mood, playingAssetId);
  playingMood = mood;
  playingAssetId = t;
  void playMusic(trackBlobKey(project, t));
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

  // Черновик строки ввода — живёт в сторе, чтобы при ошибке/отмене ввод НЕ терялся
  // (очищается только после успешного хода).
  draft: string;
  setDraft: (t: string) => void;

  // ---- Прохождения/чекпоинты (Batch 5.2) ----
  // Текущий контекст сохранения: какое прохождение и куда пишется автосейв-курсор.
  playthroughId: string;
  playthroughLabel: string;
  playthroughCreatedAt?: number;
  autosaveSlot: number; // числовой слот файла-курсора текущего прохождения
  currentCheckpointId?: string; // от какого чекпоинта форкнута текущая линия
  autosnapRing: number[]; // кольцо слотов автоснимков (история последних N автосейвов)

  // Продолжить активное прохождение (последний автосейв). false — продолжать нечего.
  continuePlaythrough: (projectId: string) => Promise<boolean>;
  // Начать новое прохождение с первого сообщения. wipe — удалить старый прогресс.
  newPlaythrough: (projectId: string, opts: { wipe: boolean; label?: string }, protagonistName?: string) => Promise<void>;
  // Загрузить конкретный сейв (автосейв прохождения ИЛИ чекпоинт-ветку).
  resumeSave: (projectId: string, save: SaveSlot) => Promise<void>;
  // Создать РУЧНОЙ чекпоинт (полная копия истории до текущей точки).
  createCheckpoint: (name?: string) => Promise<void>;
  renameCheckpoint: (slot: number, name: string) => Promise<void>;
  deleteCheckpoint: (slot: number) => Promise<void>;

  advance: () => void; // reveal next beat
  choose: (choice: Choice) => Promise<void>;
  submitFreeInput: (text: string) => Promise<void>;
  continueStory: () => Promise<void>;
  regenerate: () => Promise<void>;
  cancel: () => void; // отменить текущую генерацию (вернуть прошлый вид + ввод)
  clearError: () => void;
  // Автосейв-курсор текущего прохождения (перезаписывается). Заголовок опционален.
  autosave: (title?: string) => Promise<void>;
  dismissChapter: () => void;
  // Правка проекта прямо в игре — общий источник истины с конструктором.
  // Мутация применяется к живому проекту (влияет на манифест следующего хода)
  // и сохраняется в IndexedDB.
  patchProject: (mutator: (p: Project) => void) => Promise<void>;
  // Правка состояния Game Master (досье/часы/адженда…) прямо в игре — обновляет
  // runtime и автосохраняется.
  patchGm: (mutator: (gm: GameMasterState) => void) => void;
  patchPhone: (mutator: (p: PhoneState) => void) => void;
  // Мессенджер телефона (Batch 7 §7.2): отправить СМС персонажу и получить ответ ИИ.
  phoneTypingFrom: string | null; // characterId, от кого сейчас «печатается» ответ
  sendPhoneMessage: (characterId: string, text: string) => Promise<void>;
  markPhoneRead: (characterId: string) => void;
  // Правка памяти (список свёрток/саммари) прямо в игре.
  patchMemory: (mutator: (m: MemoryState) => void) => void;
  // Заметки для ИИ (Author's Notes) — менеджер записей; автосейв.
  setAuthorNotes: (notes: AuthorNote[]) => void;
}

// Сколько последних автосейвов хранить в кольце (история для отката, если прогресс
// слетел). Каждый ход пишется один автоснимок; старые вытесняются.
const AUTOSNAP_MAX = 15;

// Монотонный аллокатор числовых слотов для новых записей (курсоры новых прохождений,
// чекпоинты). Строго возрастающий, не пересекается с легаси-слотами 0..10.
let slotSeq = 0;
function nextSlot(): number {
  slotSeq = Math.max(Date.now(), slotSeq + 1);
  return slotSeq;
}

// Снимок вида сцены, к которому откатываемся при отмене/ошибке хода.
type PrevView = Pick<PlayerStore, 'visibleBeats' | 'queue' | 'phase' | 'choices' | 'cg'>;

// Текущая генерация в полёте (для «Отменить»/регенерации). Модульная переменная, а не
// поле стора — чтобы не гонять ре-рендеры и не сериализовать в сейв.
// `prevView` держим здесь же, чтобы cancel() мог откатить UI МГНОВЕННО, не дожидаясь,
// пока прервётся сеть и раскрутится промис. `handled` = вид уже восстановлен
// (оптимистичная отмена) или ход вытеснен новым — тогда catch/успех его не трогают.
interface InFlight {
  controller: AbortController;
  prevView: PrevView;
  handled: boolean;
}
let inFlight: InFlight | null = null;

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
  draft: '',
  playthroughId: LEGACY_PLAYTHROUGH,
  playthroughLabel: '',
  playthroughCreatedAt: undefined,
  autosaveSlot: 0,
  currentCheckpointId: undefined,
  autosnapRing: [],
  phoneTypingFrom: null,

  setDraft(t) {
    set({ draft: t });
  },

  cancel() {
    const cur = inFlight;
    if (!cur) return;
    // Оптимистично: возвращаем прошлый вид сцены СРАЗУ (не ждём обрыва сети/раскрутки
    // промиса). Помечаем ход обработанным, чтобы его catch не перезаписал UI повторно.
    cur.handled = true;
    set({ thinking: false, error: null, ...cur.prevView });
    // Реальный обрыв сетевого запроса — в фоне.
    cur.controller.abort();
  },

  async continuePlaythrough(projectId) {
    set({ loading: true, error: null });
    const project = await getProject(projectId);
    if (!project) {
      set({ loading: false, error: 'Проект не найден' });
      return false;
    }
    const info = await activePlaythrough(projectId);
    const save = info?.autosave || info?.checkpoints[info.checkpoints.length - 1];
    if (!info || !save) {
      set({ loading: false });
      return false;
    }
    applyResumedSave(set, project, info, save);
    set({ loading: false });
    return true;
  },

  async newPlaythrough(projectId, opts, protagonistName = '') {
    set({ loading: true, error: null });
    const project = await getProject(projectId);
    if (!project) {
      set({ loading: false, error: 'Проект не найден' });
      return;
    }
    const existing = await listPlaythroughs(projectId);
    if (opts.wipe) await deleteAllPlaythroughs(projectId);
    const id = uid('pt');
    const createdAt = Date.now();
    const label = opts.label?.trim() || `Прохождение ${opts.wipe ? 1 : existing.length + 1}`;
    const state = initialRuntimeState(project, protagonistName);
    set({
      project,
      state,
      loading: false,
      queue: [],
      visibleBeats: [],
      choices: [],
      cg: null,
      playthroughId: id,
      playthroughLabel: label,
      playthroughCreatedAt: createdAt,
      autosaveSlot: nextSlot(),
      currentCheckpointId: undefined,
      autosnapRing: [],
    });
    // Seed the opening turn (макросы в стартовой сцене раскрываются).
    const opening = expandMacros(project.lore.openingScene, { project, state });
    await runAndApply(set, get, project, state, `[GAME START] ${opening}`.trim());
  },

  async resumeSave(projectId, save) {
    set({ loading: true, error: null });
    const project = await getProject(projectId);
    if (!project) {
      set({ loading: false, error: 'Проект не найден' });
      return;
    }
    const infos = await listPlaythroughs(projectId);
    const info = infos.find((i) => i.id === (save.playthroughId || LEGACY_PLAYTHROUGH)) || null;
    applyResumedSave(set, project, info, save);
    set({ loading: false });
  },

  async createCheckpoint(name) {
    const { project, state, playthroughId, playthroughLabel, playthroughCreatedAt, currentCheckpointId } = get();
    if (!project || !state) return;
    const snapshot: RuntimeState = JSON.parse(JSON.stringify(state));
    const cpId = uid('cp');
    const title = name?.trim() || `Чекпоинт · ход ${state.turnCount}`;
    const save: SaveSlot = {
      slot: nextSlot(),
      projectId: project.id,
      savedAt: Date.now(),
      title,
      state: snapshot,
      kind: 'checkpoint',
      playthroughId,
      playthroughLabel,
      playthroughCreatedAt,
      checkpointId: cpId,
      parentCheckpointId: currentCheckpointId,
      branchName: title,
    };
    await putSave(save);
    // Дальнейшая линия считается форкнутой от этого чекпоинта (для родословной).
    set({ currentCheckpointId: cpId });
    logEvent('info', 'save', `Чекпоинт создан: «${title}» (ход ${state.turnCount})`);
  },

  async renameCheckpoint(slot, name) {
    const { project } = get();
    if (!project) return;
    const infos = await listPlaythroughs(project.id);
    for (const info of infos) {
      const cp = info.checkpoints.find((c) => c.slot === slot);
      if (cp) {
        await putSave({ ...cp, title: name, branchName: name, savedAt: cp.savedAt });
        return;
      }
    }
  },

  async deleteCheckpoint(slot) {
    const { project } = get();
    if (!project) return;
    await deleteSave(project.id, slot);
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
    // Мид-турн смена музыки: этот бит принёс новое настроение (Batch 6 §1).
    const proj = get().project;
    if (proj && 'mood' in next && next.mood) switchMood(proj, next.mood);
  },

  async choose(choice) {
    const { state, project } = get();
    if (!state || !project) return;
    // Стоимость платного выбора списывает ДВИЖОК (авторитетно, оптимистично). Модели
    // передаём пометку, что списание уже сделано — иначе она нередко списывает его
    // повторно через statChanges (двойная оплата).
    let move = `[CHOICE] ${choice.text}`;
    if (choice.cost) {
      const cur = state.statValues[choice.cost.statId] ?? 0;
      if (cur < choice.cost.amount) {
        set({ error: 'Недостаточно ресурса для этого выбора.' });
        return;
      }
      state.statValues[choice.cost.statId] = cur - choice.cost.amount;
      const statName = project.stats.find((s) => s.id === choice.cost!.statId)?.name || choice.cost!.statId;
      move += `\n[COST ALREADY CHARGED BY ENGINE: -${choice.cost.amount} ${statName} — do NOT include this in statChanges]`;
    }
    // Выбор кнопкой → ИИ разворачивает его в реплику/действие героя (Блок B.1).
    await runAndApply(set, get, project, state, move);
  },

  async continueStory() {
    const { state, project } = get();
    if (!state || !project) return;
    // Игрок продвигает историю без реплики (Блок I.1) — мир движется сам.
    await runAndApply(set, get, project, state, '[CONTINUE]');
  },

  async submitFreeInput(text) {
    const { state, project } = get();
    if (!state || !project || !text.trim()) return;

    // Слэш-команды (Блок B.3). Обработанная команда очищает черновик ввода.
    const slash = parseSlash(text, project);
    switch (slash.kind) {
      case 'none':
        break;
      case 'regen':
        set({ draft: '' });
        await get().regenerate();
        return;
      case 'mute':
        toggleMute();
        set({ draft: '' });
        return;
      case 'help':
        set({ error: SLASH_HELP, draft: '' });
        return;
      case 'setBackground':
        usePlayerStore.setState((st) => ({
          state: st.state ? { ...st.state, currentBackgroundId: slash.assetId } : st.state,
          draft: '',
        }));
        await get().autosave();
        return;
      case 'move': {
        const ok = await runAndApply(set, get, project, state, slash.text);
        if (ok) set({ draft: '' });
        return;
      }
    }

    // Обычный ввод — ДОСЛОВНАЯ реплика героя (Блок B.2): ИИ не пишет за протагониста.
    // Черновик очищаем ТОЛЬКО при успехе — при ошибке/отмене ввод остаётся в строке.
    const ok = await runAndApply(set, get, project, state, `[VERBATIM] ${text.trim()}`);
    if (ok) set({ draft: '' });
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

  async autosave(title) {
    const { project, state, autosaveSlot, playthroughId, playthroughLabel, playthroughCreatedAt, currentCheckpointId, autosnapRing } = get();
    if (!project || !state) return;
    // Глубокий снимок на момент сохранения — чтобы последующие мутации живого
    // состояния (напр. списание стоимости выбора) не могли задним числом исказить
    // уже отданный на запись сейв.
    const snapshot: RuntimeState = JSON.parse(JSON.stringify(state));
    const savedAt = Date.now();
    const meta = {
      projectId: project.id,
      playthroughId,
      playthroughLabel,
      playthroughCreatedAt,
      parentCheckpointId: currentCheckpointId,
    };
    // 1) Курсор «последнее состояние» (для «Продолжить») — фиксированный слот.
    const cursor: SaveSlot = {
      slot: autosaveSlot,
      savedAt,
      title: title || `Автосейв · ход ${state.turnCount}`,
      state: snapshot,
      kind: 'autosave',
      ...meta,
    };
    await putSave(cursor);
    // 2) Автоснимок в кольцо последних N — чтобы можно было откатиться на несколько
    // ходов назад, если прогресс слетел. Кольцо переиспользует самый старый слот.
    let ring = [...autosnapRing];
    let snapSlot: number;
    if (ring.length < AUTOSNAP_MAX) {
      snapSlot = nextSlot();
      ring.push(snapSlot);
    } else {
      snapSlot = ring.shift()!; // самый старый слот — под перезапись новым снимком
      ring.push(snapSlot);
    }
    set({ autosnapRing: ring });
    const snap: SaveSlot = {
      slot: snapSlot,
      savedAt,
      title: `Ход ${state.turnCount}`,
      state: snapshot,
      kind: 'autosnap',
      ...meta,
    };
    await putSave(snap);
    const firstBeat = snapshot.lastTurn?.beats?.map((b) => ('text' in b ? b.text : ''))?.find((t) => t) || '';
    logEvent('debug', 'save', `Автосейв ход ${snapshot.turnCount}, beats: ${snapshot.lastTurn?.beats?.length ?? 0} · «${firstBeat.slice(0, 40)}»`);
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

  patchGm(mutator) {
    const st = get();
    if (!st.state) return;
    const gm: GameMasterState = JSON.parse(JSON.stringify(st.state.gm));
    mutator(gm);
    const nextState = { ...st.state, gm };
    set({ state: nextState });
    // Автосейв (fire-and-forget) — правки GM переживают перезагрузку.
    void get().autosave();
  },

  // Правка состояния телефона (Batch 7) — контакты/переписки/транзакции/инвентарь.
  patchPhone(mutator) {
    const st = get();
    if (!st.state) return;
    const phone: PhoneState = JSON.parse(JSON.stringify(st.state.phone ?? initialPhoneState()));
    mutator(phone);
    set({ state: { ...st.state, phone } });
    void get().autosave();
  },

  markPhoneRead(characterId) {
    const st = get();
    if (!st.state?.phone) return;
    if (!st.state.phone.unreadFrom.includes(characterId)) return;
    get().patchPhone((p) => {
      p.unreadFrom = p.unreadFrom.filter((id) => id !== characterId);
    });
  },

  async sendPhoneMessage(characterId, text) {
    const st = get();
    const trimmed = text.trim();
    if (!st.project || !st.state || !trimmed || st.phoneTypingFrom) return;
    // Кладём сообщение игрока сразу (оптимистично) и чистим непрочитанное.
    get().patchPhone((p) => {
      (p.conversations[characterId] ||= []).push({ from: 'protagonist', text: trimmed, at: Date.now() });
      p.unreadFrom = p.unreadFrom.filter((id) => id !== characterId);
    });
    set({ phoneTypingFrom: characterId });
    try {
      const cur = get();
      const convo = cur.state?.phone?.conversations[characterId] || [];
      const reply = await generatePhoneReply(cur.project!, cur.state!, characterId, convo);
      get().patchPhone((p) => {
        (p.conversations[characterId] ||= []).push({ from: 'contact', text: reply, at: Date.now() });
      });
    } catch (e) {
      logEvent('error', 'phone', e instanceof Error ? e.message : String(e));
      get().patchPhone((p) => {
        (p.conversations[characterId] ||= []).push({
          from: 'contact',
          text: '…(нет связи)',
          at: Date.now(),
        });
      });
    } finally {
      set({ phoneTypingFrom: null });
    }
  },

  patchMemory(mutator) {
    const st = get();
    if (!st.state) return;
    const memory: MemoryState = JSON.parse(JSON.stringify(st.state.memory));
    mutator(memory);
    const nextState = { ...st.state, memory };
    set({ state: nextState });
    void get().autosave();
  },

  setAuthorNotes(notes) {
    const st = get();
    if (!st.state) return;
    const nextState = { ...st.state, authorNotes: notes };
    set({ state: nextState });
    void get().autosave();
  },
}));

// Загружает конкретный сейв (автосейв ИЛИ чекпоинт), выставляя контекст прохождения
// так, чтобы дальнейший автосейв-курсор писался в это прохождение. При загрузке
// чекпоинта курсор прохождения перезаписывается этим состоянием (продолжаем ветку,
// не теряя сам чекпоинт-снимок). См. Batch 5.2.
function applyResumedSave(
  set: (partial: Partial<PlayerStore>) => void,
  project: Project,
  info: PlaythroughInfo | null,
  save: SaveSlot
) {
  const isCheckpoint = save.kind === 'checkpoint';
  const playthroughId = save.playthroughId || LEGACY_PLAYTHROUGH;
  const playthroughLabel = save.playthroughLabel || info?.label || '';
  const playthroughCreatedAt = save.playthroughCreatedAt ?? info?.createdAt;
  // Куда писать курсор: только сам автосейв-курсор переиспользует свой слот. Чекпоинт
  // и автоснимок грузятся В курсор прохождения (существующий или новый) — не в их слот.
  const autosaveSlot = save.kind === 'autosave' ? save.slot : info?.autosave?.slot ?? nextSlot();
  const currentCheckpointId = isCheckpoint ? save.checkpointId : save.parentCheckpointId;
  // Продолжаем то же кольцо автоснимков прохождения (последние N слотов).
  const autosnapRing = (info?.autosnaps || [])
    .slice()
    .sort((a, b) => a.savedAt - b.savedAt)
    .map((a) => a.slot)
    .slice(-AUTOSNAP_MAX);

  set({
    playthroughId,
    playthroughLabel,
    playthroughCreatedAt,
    autosaveSlot,
    currentCheckpointId,
    autosnapRing,
  });
  applyLoadedState(set, project, save.state);

  // Сразу фиксируем курсор этого прохождения на загруженном состоянии — чтобы
  // «Продолжить» возобновляло отсюда (особенно после захода в чекпоинт). В фоне.
  const cursor: SaveSlot = {
    slot: autosaveSlot,
    projectId: project.id,
    savedAt: Date.now(),
    title: save.title || `Автосейв · ход ${save.state.turnCount}`,
    state: JSON.parse(JSON.stringify(save.state)),
    kind: 'autosave',
    playthroughId,
    playthroughLabel,
    playthroughCreatedAt,
    parentCheckpointId: currentCheckpointId,
  };
  void putSave(cursor).catch((e) => logEvent('error', 'save', 'Курсор не записан: ' + (e as Error).message));
}

// Reveal a loaded state without replaying beats (show last turn fully).
function applyLoadedState(
  set: (partial: Partial<PlayerStore>) => void,
  project: Project,
  state: RuntimeState
) {
  const last = state.lastTurn;
  const firstBeat = last?.beats?.map((b) => ('text' in b ? b.text : ''))?.find((t) => t) || '';
  logEvent('info', 'load', `Загружен ход ${state.turnCount}, beats: ${last?.beats?.length ?? 0} · «${firstBeat.slice(0, 40)}»`);
  seedPlaying(state.currentMusicMood, state.currentMusicAssetId);
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
// Возвращает true при успехе; false при ошибке или отмене (тогда прошлый вид сцены
// восстанавливается, а черновик ввода вызывающий сохраняет).
async function runAndApply(
  set: (partial: Partial<PlayerStore>) => void,
  get: () => PlayerStore,
  project: Project,
  baseState: RuntimeState,
  playerMove: string
): Promise<boolean> {
  // Новый ход вытесняет предыдущий: если что-то ещё в полёте (напр. регенерация
  // поверх текущей генерации) — сразу абортим его, не дожидаясь завершения. Помечаем
  // handled, чтобы его catch не тронул UI, который мы сейчас перезапишем своим видом.
  if (inFlight) {
    inFlight.handled = true;
    inFlight.controller.abort();
  }

  // Снимок текущего вида — чтобы вернуть его при отмене/ошибке (последний ответ ИИ
  // и его выборы остаются на экране, как будто хода не было).
  const prevView: PrevView = {
    visibleBeats: get().visibleBeats,
    queue: get().queue,
    phase: get().phase,
    choices: get().choices,
    cg: get().cg,
  };
  const controller = new AbortController();
  const self: InFlight = { controller, prevView, handled: false };
  inFlight = self;
  set({ thinking: true, error: null, choices: [], statFlash: [], queue: [], visibleBeats: [] });
  logEvent('info', 'turn', `Ход: ${playerMove.slice(0, 60)}`);
  try {
    // Обычная (нестриминговая) генерация — один ход целиком, затем показ.
    const { turn, state } = await runTurn(project, baseState, playerMove, controller.signal);

    // Ход вытеснен (отмена/регенерация) пока ждали ответ — результат игнорируем,
    // UI уже приведён в нужное состояние тем, кто нас вытеснил.
    if (self.handled) return false;

    // Compute stat flashes vs. the pre-turn values.
    const flash: { statId: string; delta: number }[] = [];
    for (const s of project.stats) {
      const before = baseState.statValues[s.id] ?? s.initial;
      const after = state.statValues[s.id] ?? s.initial;
      if (after !== before) flash.push({ statId: s.id, delta: after - before });
    }

    // Музыка: играем настроение ПЕРВОГО бита хода; мид-турн смены доиграет advance()
    // (Batch 6 §1). Сеем «что играет» из состояния ДО хода — если настроение не
    // сменилось, трек продолжается без рестарта.
    seedPlaying(baseState.currentMusicMood, baseState.currentMusicAssetId);
    const openMood = ('mood' in (turn.beats[0] || {}) ? (turn.beats[0] as { mood?: string }).mood : undefined) ?? state.currentMusicMood;
    switchMood(project, openMood);
    if (turn.scene.sfxId) void playSfx(trackBlobKey(project, turn.scene.sfxId));

    const [first, ...rest] = turn.beats;
    set({
      state,
      queue: rest,
      visibleBeats: first ? [first] : [],
      phase: turn.beats.length ? 'beats' : 'choices',
      choices: turn.choices,
      thinking: false,
      cg: turn.scene.cutsceneCgId,
      statFlash: flash,
      chapterTitle: turn.chapterEvent === 'chapter_end' ? 'Сюжетная веха' : null,
    });

    // Автосейв — в ФОНЕ: UI уже обновлён, запись на диск не должна его блокировать.
    // Ошибка записи не откатывает показанное состояние (в худшем случае — тихий лог).
    void get()
      .autosave()
      .catch((err) => logEvent('error', 'save', 'Фоновое автосохранение не удалось: ' + (err as Error).message));
    logEvent('info', 'turn', `Ход применён (ход ${state.turnCount}, beats: ${turn.beats.length})`);
    return true;
  } catch (e) {
    // Ход уже обработан (оптимистичная отмена или вытеснение новым ходом) — не трогаем UI.
    if (self.handled) return false;
    const aborted = (e as Error)?.name === 'AbortError';
    if (aborted) {
      // Отмена: возвращаем прошлый вид сцены; ошибку не показываем.
      logEvent('info', 'turn', 'Генерация отменена — возвращён прошлый ход');
      set({ thinking: false, error: null, ...prevView });
    } else {
      // Ошибка: тоже возвращаем прошлый вид (сцена не пустеет), показываем тост.
      logEvent('error', 'turn', 'Не удалось выполнить ход: ' + (e as Error).message, (e as Error).stack);
      set({ thinking: false, error: (e as Error).message, ...prevView });
    }
    return false;
  } finally {
    if (inFlight === self) inFlight = null;
  }
}
