import { create } from 'zustand';
import type { Project, RuntimeState, Beat, Choice, SaveSlot, GameMasterState, MemoryState, AuthorNote, PhoneState, PhoneShopItem, PhoneContact, PhoneChat, AssetMeta, InventoryItem, CharacterRole, RelationshipStats } from '../../shared/types';
import { initialPhoneState, PHONE_BALANCE_STAT, defaultImageGenConfig, emptyRelationship } from '../../shared/types';
import type { GeneratedSheet } from '../../ai/gmScan';
import { initialRuntimeState } from '../../shared/factory';
import { runTurn, pickTrackForMood } from '../../ai/gameEngine';
import { generateChatReplies, type ChatReply } from '../../ai/phoneChat';
import { generateContactPhoto } from '../../ai/phonePhoto';
import { generateDeliveryItems } from '../../ai/deliveryGen';
import {
  generateImage,
  blobToRef,
  supportsReferences,
  composeFinalPrompt,
  type ImageRef,
} from '../../ai/imageProvider';
import { getApiKey } from '../../ai/keys';
import { resolveSprite } from '../../shared/outfits';
import { formatClock } from '../../ai/gameMaster';
import { uploadAsset } from '../../storage/assetOps';
import { expandMacros } from '../../ai/macros';
import { getProject, putSave, saveProject, deleteSave, getAssetBlob, putAsset } from '../../storage/db';
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
import { pushToast } from '../../shared/toast';
import { parseArchivedTranscript } from '../../ai/memoryEngine';
import { uid } from '../../shared/utils';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
// Пауза «набора» под длину сообщения (живой ритм переписки), с потолком.
const typingDelay = (text: string) => Math.min(1600, 350 + text.length * 18);

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
  // Правка инвентаря (Batch 8 §IV) прямо в игре — добавить/переименовать/кол-во/эмодзи/удалить.
  patchInventory: (mutator: (inv: InventoryItem[]) => void) => void;
  // Гардероб: вручную задать наряд персонажа на текущую сцену (если ИИ не переоделся).
  setSceneOutfit: (characterId: string, outfit: string) => void;
  // Мессенджер телефона (Телефон 2.0): чаты (личные и групповые), контакты, фото.
  phoneTypingFrom: string | null; // id чата, в котором сейчас «печатают» ответ
  // Отправить сообщение в чат (текст и/или фото) и получить ответ ИИ.
  sendChatMessage: (chatId: string, text: string, assetId?: string) => Promise<void>;
  markChatRead: (chatId: string) => void;
  // Контакты: создать/поправить/удалить. Возвращает id созданного контакта.
  createContact: (data: Partial<PhoneContact>) => string;
  updateContact: (id: string, patch: Partial<PhoneContact>) => void;
  // forget=true — стереть и переписку (боты «забудут»); иначе чат уходит в архив.
  deleteContact: (id: string, opts?: { forget?: boolean }) => void;
  // Личный чат с контактом: находит существующий или заводит новый. Возвращает id чата.
  openDirectChat: (contactId: string) => string;
  createGroupChat: (data: {
    title: string;
    participantIds: string[];
    avatarAssetId?: string;
    groupActivity?: number;
    topic?: string;
  }) => string;
  updateChat: (chatId: string, patch: Partial<PhoneChat>) => void;
  deleteChat: (chatId: string, opts?: { forget?: boolean }) => void;
  deleteMessage: (chatId: string, messageId: string) => void;
  // Аватарка (контакт/группа/герой): генерация через image-API. Возвращает assetId.
  avatarBusy: boolean;
  generateAvatar: (prompt: string) => Promise<string | null>;
  // Догенерация фото, которые боты «прислали» в этот ход (sms_photo-бит).
  resolvePendingPhotos: () => Promise<void>;
  // Доставка (ревизия блока 6 §3): догенерация ассортимента + оформление заказа.
  deliveryLoadingCat: string | null; // categoryName, для которой сейчас генерится каталог
  generateDelivery: (categoryName: string) => Promise<void>;
  orderDelivery: (item: PhoneShopItem) => void;
  // Камера (Batch 7 §5): генерация селфи протагониста через image-API + отправка фото.
  cameraBusy: boolean;
  // mode: 'front' — селфи героя (с рефами), 'rear' — снимок того, что вокруг.
  takeSelfie: (userPrompt: string, mode?: 'front' | 'rear') => Promise<void>;
  // Своя картинка с устройства → в галерею телефона. Возвращает assetId.
  uploadPhonePhoto: (file: File) => Promise<string | null>;
  // Тест подключения image-API (для камеры/CG). '' = успех, иначе текст ошибки.
  testImageApi: () => Promise<string>;
  // Ручная правка баланса в «Банке» (Batch 8 §III.1) — записывает корректировку в выписку.
  setBalance: (value: number) => void;
  // Ручная правка статов прямо в игре — если ИИ пропустил изменение по сюжету.
  setStatValue: (statId: string, value: number) => void;
  setRelationshipStat: (charId: string, field: keyof RelationshipStats, value: number) => void;
  // Контакты из сканирования (Batch 8 §V): создать минимальные npc-персонажи + контакты.
  addScannedContacts: (names: string[]) => void;
  // Экспорт анкеты в проект (Batch 8 §VI.3): промоушен существующего npc по имени или новый.
  exportCharacterSheet: (sheet: GeneratedSheet, role: CharacterRole) => void;
  // Склейка дублей персонажей (patch character-registry §3.3): survivor поглощает dup.
  mergeCharacters: (survivorId: string, dupId: string) => void;
  // Правка памяти (список свёрток/саммари) прямо в игре.
  patchMemory: (mutator: (m: MemoryState) => void) => void;
  // Вернуть свёрнутый период из архива обратно в живую историю (дословно).
  restoreArchivedPeriod: (archiveIndex: number) => void;
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

// Состояние ДО применения последнего хода — база для реролла. Реролл обязан
// откатывать ВЕСЬ ход, а не только историю: иначе статы, инвентарь, деньги, часы,
// досье GM и счётчик свёртки от отклонённого варианта остаются применёнными, а
// новый ход накладывается поверх — состояние уплывает (двойные списания, «уже
// был в Нью-Йорке, а после реролла снова в Китае»). Живёт только в памяти
// вкладки: после перезагрузки честно откатываемся хотя бы по истории.
let preTurnState: { move: string; state: RuntimeState } | null = null;

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
  deliveryLoadingCat: null,
  cameraBusy: false,
  avatarBusy: false,

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
      const isPhoneCost = choice.cost.statId === PHONE_BALANCE_STAT;
      const statName = isPhoneCost
        ? project.phone?.currencyName || '$'
        : project.stats.find((s) => s.id === choice.cost!.statId)?.name || choice.cost!.statId;
      move += `\n[COST ALREADY CHARGED BY ENGINE: -${choice.cost.amount} ${statName} — do NOT include this in statChanges]`;
      // Платный выбор за баланс телефона автоматически создаёт транзакцию-выписку
      // (ревизия блока 6 §2) — без отдельного beat от ИИ.
      if (isPhoneCost && state.phone) {
        state.phone = {
          ...state.phone,
          transactions: [
            ...state.phone.transactions,
            {
              amount: -choice.cost.amount,
              reason: choice.text.replace(/[*_`]/g, '').slice(0, 60),
              item: choice.text.replace(/[*_`]/g, '').slice(0, 60),
              at: Date.now(),
            },
          ],
        };
      }
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
    // Отклонённый вариант передаём движку: без него реролл возвращал то же самое
    // (контекст не изменился), и «нежелательное событие» повторялось раз за разом.
    const rejected = hist[hist.length - 1]?.content;
    // ПОЛНЫЙ откат хода. Снимок есть — берём его: он снимает ВСЕ последствия
    // отклонённого варианта (статы, деньги, инвентарь, часы/локация GM, реестр,
    // память, счётчик свёртки). Снимка нет (перезагрузили вкладку) — откатываем
    // хотя бы историю, как раньше, и предупреждаем в логе.
    const snap = preTurnState && preTurnState.move === lastMove.content ? preTurnState.state : null;
    if (!snap) {
      logEvent(
        'warn',
        'turn',
        'Реролл без снимка состояния (вкладку перезагружали): откатываю только историю — ' +
          'статы/инвентарь/часы от прошлой версии хода могли остаться применёнными.'
      );
    }
    const rolledBack: RuntimeState = snap
      ? JSON.parse(JSON.stringify(snap))
      : { ...state, history: hist.slice(0, -2) };
    await runAndApply(set, get, project, rolledBack, lastMove.content, rejected);
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

  markChatRead(chatId) {
    const st = get();
    const chat = st.state?.phone?.chats.find((c) => c.id === chatId);
    if (!chat) return;
    const peers = chat.participantIds;
    if (!chat.unread && !peers.some((id) => st.state!.phone!.unreadFrom.includes(id))) return;
    get().patchPhone((p) => {
      const c = p.chats.find((x) => x.id === chatId);
      if (c) c.unread = false;
      p.unreadFrom = p.unreadFrom.filter((id) => !peers.includes(id));
    });
  },

  openDirectChat(contactId) {
    const st = get();
    const existing = st.state?.phone?.chats.find(
      (c) => c.kind === 'direct' && c.participantIds[0] === contactId && !c.archived
    );
    if (existing) return existing.id;
    const id = uid('chat');
    get().patchPhone((p) => {
      p.chats.push({ id, kind: 'direct', participantIds: [contactId], messages: [] });
    });
    return id;
  },

  createContact(data) {
    const id = data.id || uid('ct');
    get().patchPhone((p) => {
      if (p.contacts.some((c) => c.id === id)) return;
      p.contacts.push({
        id,
        characterId: data.characterId,
        registryId: data.registryId,
        name: data.name?.trim() || undefined,
        avatarAssetId: data.avatarAssetId,
        chattiness: typeof data.chattiness === 'number' ? data.chattiness : 50,
      });
    });
    return id;
  },

  updateContact(id, patch) {
    get().patchPhone((p) => {
      const c = p.contacts.find((x) => x.id === id);
      if (!c) return;
      Object.assign(c, patch);
      if (!c.name?.trim()) c.name = undefined;
    });
  },

  deleteContact(id, opts) {
    get().patchPhone((p) => {
      p.contacts = p.contacts.filter((c) => c.id !== id);
      p.unreadFrom = p.unreadFrom.filter((x) => x !== id);
      for (const chat of p.chats) {
        chat.participantIds = chat.participantIds.filter((x) => x !== id);
      }
      // Личный чат с удалённым контактом: либо стираем совсем (боты забудут),
      // либо прячем в архив — переписка остаётся в памяти истории.
      if (opts?.forget) {
        p.chats = p.chats.filter((c) => !(c.kind === 'direct' && !c.participantIds.length));
      } else {
        for (const c of p.chats) if (c.kind === 'direct' && !c.participantIds.length) c.archived = true;
      }
    });
  },

  createGroupChat(data) {
    const id = uid('grp');
    get().patchPhone((p) => {
      p.chats.push({
        id,
        kind: 'group',
        title: data.title.trim() || 'Новая группа',
        avatarAssetId: data.avatarAssetId,
        participantIds: [...data.participantIds],
        messages: [],
        groupActivity: typeof data.groupActivity === 'number' ? data.groupActivity : 50,
        topic: data.topic?.trim() || undefined,
      });
    });
    return id;
  },

  updateChat(chatId, patch) {
    get().patchPhone((p) => {
      const c = p.chats.find((x) => x.id === chatId);
      if (!c) return;
      Object.assign(c, patch);
    });
  },

  deleteChat(chatId, opts) {
    get().patchPhone((p) => {
      if (opts?.forget) p.chats = p.chats.filter((c) => c.id !== chatId);
      else {
        const c = p.chats.find((x) => x.id === chatId);
        if (c) {
          c.archived = true;
          c.unread = false;
        }
      }
    });
  },

  deleteMessage(chatId, messageId) {
    get().patchPhone((p) => {
      const c = p.chats.find((x) => x.id === chatId);
      if (!c) return;
      c.messages = c.messages.filter((m) => m.id !== messageId);
    });
  },

  async sendChatMessage(chatId, text, assetId) {
    const st = get();
    const trimmed = text.trim();
    if (!st.project || !st.state || st.phoneTypingFrom) return;
    if (!trimmed && !assetId) return;
    const chat = st.state.phone?.chats.find((c) => c.id === chatId);
    if (!chat) return;
    // Кладём сообщение игрока сразу (оптимистично) и чистим непрочитанное.
    get().patchPhone((p) => {
      const c = p.chats.find((x) => x.id === chatId);
      if (!c) return;
      c.messages.push({
        id: uid('msg'),
        from: 'protagonist',
        text: trimmed,
        attachedAssetId: assetId,
        at: Date.now(),
      });
      c.unread = false;
      p.unreadFrom = p.unreadFrom.filter((id) => !c.participantIds.includes(id));
    });
    set({ phoneTypingFrom: chatId });
    try {
      await runChatReplies(get, set, chatId, {});
    } finally {
      set({ phoneTypingFrom: null });
    }
  },

  async generateAvatar(prompt) {
    const st = get();
    if (!st.project || st.avatarBusy) return null;
    if (!getApiKey('image')) {
      set({ error: 'Настройте генерацию изображений (🎬 CG-студия → подключение).' });
      return null;
    }
    set({ avatarBusy: true, error: null });
    try {
      const ig = st.project.imageGen ?? defaultImageGenConfig();
      const basePrompt = `Messenger profile picture (avatar), square close-up portrait framing: ${prompt.trim() || 'a person'}.`;
      const blob = await generateImage(ig, {
        prompt: composeFinalPrompt(ig, basePrompt),
        aspectRatio: '1:1',
      });
      const blobKey = uid('blob');
      await putAsset(blobKey, blob);
      const asset: AssetMeta = {
        id: uid('cg'),
        type: 'cg',
        name: `Аватар: ${prompt.trim().slice(0, 24) || 'без описания'}`,
        generated: true,
        blobKey,
        mime: blob.type || 'image/png',
      };
      await get().patchProject((p) => {
        if (!p.assets.some((a) => a.id === asset.id)) p.assets.push(asset);
      });
      return asset.id;
    } catch (e) {
      logEvent('error', 'phone', 'Аватар не сгенерировался: ' + (e as Error).message);
      set({ error: 'Не удалось сгенерировать аватарку.' });
      return null;
    } finally {
      set({ avatarBusy: false });
    }
  },

  async resolvePendingPhotos() {
    const st = get();
    if (!st.project || !st.state?.phone) return;
    // Собираем все «висящие» фото: сообщение уже видно, картинки ещё нет.
    const pending: { chatId: string; msgId: string; senderId?: string; prompt: string }[] = [];
    for (const chat of st.state.phone.chats) {
      for (const m of chat.messages) {
        if (m.pendingPhoto && m.photoPrompt && m.id && !m.attachedAssetId) {
          pending.push({ chatId: chat.id, msgId: m.id, senderId: m.senderId, prompt: m.photoPrompt });
        }
      }
    }
    for (const p of pending) {
      const cur = get();
      if (!cur.project || !cur.state) return;
      const contact = p.senderId ? cur.state.phone?.contacts.find((c) => c.id === p.senderId) : undefined;
      const asset = await generateContactPhoto(cur.project, cur.state, contact, p.prompt);
      if (asset) {
        await get().patchProject((proj) => {
          if (!proj.assets.some((a) => a.id === asset.id)) proj.assets.push(asset);
        });
      }
      get().patchPhone((ph) => {
        const chat = ph.chats.find((c) => c.id === p.chatId);
        const msg = chat?.messages.find((m) => m.id === p.msgId);
        if (!msg) return;
        msg.pendingPhoto = false;
        if (asset) {
          msg.attachedAssetId = asset.id;
          ph.gallery = [...ph.gallery, asset.id];
        } else {
          msg.photoFailed = true;
        }
      });
    }
  },

  async generateDelivery(categoryName) {
    const st = get();
    if (!st.project || !st.state || st.deliveryLoadingCat) return;
    set({ deliveryLoadingCat: categoryName });
    try {
      const existing = [
        ...(st.project.phone?.baseCatalog || []),
        ...(st.state.phone?.deliveryCache || []),
      ]
        .filter((it) => it.category === categoryName)
        .map((it) => it.name);
      const items = await generateDeliveryItems(st.project, st.state, categoryName, existing);
      if (items.length) {
        get().patchPhone((p) => {
          p.deliveryCache = [...p.deliveryCache, ...items];
        });
      }
    } catch (e) {
      logEvent('error', 'delivery', e instanceof Error ? e.message : String(e));
      set({ error: 'Не удалось загрузить ассортимент. Проверьте подключение ИИ.' });
    } finally {
      set({ deliveryLoadingCat: null });
    }
  },

  orderDelivery(item) {
    const st = get();
    if (!st.state || !st.project) return;
    const price = Math.max(0, Math.round(item.price));
    const bal = st.state.statValues[PHONE_BALANCE_STAT] ?? 0;
    if (bal < price) {
      set({ error: 'Недостаточно средств для заказа.' });
      return;
    }
    const vendor = 'Доставка';
    // Списание баланса + транзакция-выписка + активный заказ (влияет на сюжет) +
    // позиция в инвентаре. Всё в одной мутации состояния.
    const nextState: RuntimeState = JSON.parse(JSON.stringify(st.state));
    nextState.statValues[PHONE_BALANCE_STAT] = bal - price;
    const phone = nextState.phone ?? initialPhoneState();
    phone.transactions.push({
      amount: -price,
      reason: `${vendor} — ${item.name}`,
      vendor,
      item: item.name,
      at: Date.now(),
    });
    phone.activeOrders.push({
      itemId: item.id,
      name: item.name,
      category: item.category,
      placedAtTurn: nextState.turnCount,
    });
    phone.inventory.push({ itemId: item.id, name: item.name, category: item.category });
    nextState.phone = phone;
    set({ state: nextState });
    void get().autosave();
  },

  async takeSelfie(userPrompt, mode = 'front') {
    const st = get();
    if (!st.project || !st.state || st.cameraBusy) return;
    const project = st.project;
    const state = st.state;
    const protagonist = project.characters.find((c) => c.role === 'protagonist');
    const spriteAssetId = protagonist ? resolveSprite(protagonist, undefined, 'neutral') : undefined;
    const rear = mode === 'rear';
    // Fallback (Batch 7 §5.5): нет ключа image-API — мягкий отказ. Спрайт нужен
    // только фронталке: основная камера снимает мир, а не героя.
    if (!getApiKey('image') || (!rear && (!protagonist || !spriteAssetId))) {
      set({
        error: rear
          ? 'Настройте генерацию изображений (🎬 CG-студия → подключение).'
          : 'Настройте генерацию изображений и загрузите спрайт протагониста.',
      });
      return;
    }
    set({ cameraBusy: true, error: null });
    try {
      const ig = project.imageGen ?? defaultImageGenConfig();
      const heroName = state.protagonistName || protagonist?.name || 'the hero';
      const tmpl = rear
        ? project.phone?.rearCameraPromptTemplate || 'photo taken on a phone by {protagonist_name}: {user_prompt}'
        : project.phone?.cameraPromptTemplate || 'selfie photo of {protagonist_name}, {user_prompt}';
      const basePrompt = tmpl
        .replace(/\{protagonist_name\}/g, heroName)
        .replace(/\{user_prompt\}/g, userPrompt.trim() || (rear ? 'what is in front of the hero right now' : 'casual selfie'))
        .replace(/\{location\}/g, state.gm.clock.location || 'wherever the hero is now')
        .replace(/\{time\}/g, formatClock(state.gm.clock) || 'now');
      // Референсы протагониста: внешность (свой реф или спрайт) + одежда, если
      // задана в CG-студии. Порядок как там же — промпт ссылается по номерам.
      // Основной камере рефы не нужны: героя в кадре нет.
      const refs: ImageRef[] = [];
      if (!rear && protagonist && supportsReferences(ig) && ig.sendReferences) {
        const who = heroName;
        const slots: { id?: string; kind: 'appearance' | 'outfit' }[] = [
          { id: ig.references[protagonist.id] || spriteAssetId, kind: 'appearance' },
          { id: ig.outfitReferences?.[protagonist.id], kind: 'outfit' },
        ];
        for (const slot of slots) {
          const blobKey = slot.id ? project.assets.find((a) => a.id === slot.id)?.blobKey : undefined;
          if (!blobKey) continue;
          const b = await getAssetBlob(blobKey);
          if (b) refs.push(await blobToRef(b, { who, kind: slot.kind }));
        }
      }
      // Стиль, запреты и правило про референсы — общей сборкой (как в CG-студии).
      const finalPrompt = composeFinalPrompt(ig, basePrompt, { refs });
      // Кадр как у телефона: селфи вертикальное, основная камера — горизонтальная.
      const blob = await generateImage(ig, {
        prompt: finalPrompt,
        references: refs,
        aspectRatio: rear ? '4:3' : '3:4',
      });
      const blobKey = uid('blob');
      await putAsset(blobKey, blob);
      const asset: AssetMeta = {
        id: uid('cg'),
        type: 'cg',
        name: `${rear ? 'Фото' : 'Селфи'}: ${(userPrompt.trim() || 'фото').slice(0, 24)}`,
        generated: true,
        blobKey,
        mime: blob.type || 'image/png',
      };
      // В манифест проекта (переиспользуемо) + в галерею телефона.
      await get().patchProject((p) => {
        if (!p.assets.some((a) => a.id === asset.id)) p.assets.push(asset);
      });
      get().patchPhone((p) => {
        p.gallery = [...p.gallery, asset.id];
      });
    } catch (e) {
      logEvent('error', 'camera', e instanceof Error ? e.message : String(e));
      set({ error: 'Не удалось сделать фото. Проверьте настройки генерации изображений.' });
    } finally {
      set({ cameraBusy: false });
    }
  },

  setStatValue(statId, value) {
    const st = get();
    if (!st.state || !st.project) return;
    const def = st.project.stats.find((s) => s.id === statId);
    if (!def) return;
    const v = Math.max(def.min, Math.min(def.max, Math.round(value)));
    if ((st.state.statValues[statId] ?? def.initial) === v) return;
    set({ state: { ...st.state, statValues: { ...st.state.statValues, [statId]: v } } });
    void get().autosave();
  },

  setRelationshipStat(charId, field, value) {
    const st = get();
    if (!st.state) return;
    const v = Math.max(-100, Math.min(100, Math.round(value)));
    const cur = st.state.relationship[charId] ?? emptyRelationship();
    if (cur[field] === v) return;
    set({
      state: {
        ...st.state,
        relationship: { ...st.state.relationship, [charId]: { ...cur, [field]: v } },
      },
    });
    void get().autosave();
  },

  setBalance(value) {
    const st = get();
    if (!st.state) return;
    const target = Math.round(value);
    const cur = st.state.statValues[PHONE_BALANCE_STAT] ?? 0;
    const delta = target - cur;
    if (delta === 0) return;
    const nextState: RuntimeState = JSON.parse(JSON.stringify(st.state));
    nextState.statValues[PHONE_BALANCE_STAT] = target;
    if (st.project?.phone?.enabled) {
      const phone = nextState.phone ?? initialPhoneState();
      phone.transactions.push({
        amount: delta,
        reason: 'Корректировка',
        vendor: 'Корректировка',
        date: nextState.gm.clock.date || undefined,
        at: Date.now(),
      });
      nextState.phone = phone;
    }
    set({ state: nextState });
    void get().autosave();
  },

  addScannedContacts(names) {
    const st = get();
    if (!st.project || !st.state) return;
    const project = st.project;
    // Собираем новые npc-персонажи для имён без карточки; затем — контакты в телефон.
    const created: { id: string; name: string }[] = [];
    const resolveId = (name: string): string => {
      const existing = project.characters.find((c) => c.name.toLowerCase() === name.toLowerCase());
      if (existing) return existing.id;
      const already = created.find((c) => c.name.toLowerCase() === name.toLowerCase());
      if (already) return already.id;
      const id = uid('char');
      created.push({ id, name });
      return id;
    };
    const contactIds = names.map((n) => ({ name: n, id: resolveId(n) }));
    if (created.length) {
      void get().patchProject((p) => {
        for (const c of created) {
          if (!p.characters.some((x) => x.id === c.id)) {
            p.characters.push({
              id: c.id,
              name: c.name,
              role: 'npc',
              card: { appearance: '', personality: '', backstory: '', speechStyle: '' },
              sprites: {},
              relationship: emptyRelationship(),
              importedFrom: 'scanned_contact',
            });
          }
        }
      });
    }
    // Добавляем контакты в телефон (только для включённого расширения).
    if (project.phone?.enabled) {
      get().patchPhone((ph) => {
        for (const c of contactIds) {
          if (!ph.contacts.some((x) => x.characterId === c.id)) ph.contacts.push({ id: c.id, characterId: c.id });
        }
      });
    }
  },

  exportCharacterSheet(sheet, role) {
    const st = get();
    if (!st.project || !st.state) return;
    const project = st.project;
    const existing = project.characters.find((c) => c.name.toLowerCase() === sheet.name.toLowerCase());
    const cid = existing?.id ?? uid('char');
    void get().patchProject((p) => {
      const card = {
        appearance: sheet.appearance || '',
        personality: sheet.personality || '',
        backstory: sheet.backstory || '',
        speechStyle: sheet.speechStyle || '',
      };
      const target = p.characters.find((c) => c.id === cid);
      if (target) {
        // Промоушен существующего (в т.ч. сканированного контакта) — без дубля.
        target.role = role;
        target.card = card;
        if (!target.relationship) target.relationship = emptyRelationship();
      } else {
        p.characters.push({
          id: cid,
          name: sheet.name,
          role,
          card,
          sprites: {},
          relationship: emptyRelationship(),
          importedFrom: 'gm_sheet',
        });
      }
    });
    // Сидим живые значения отношений, чтобы стат сразу работал в текущей игре.
    if (role !== 'npc') {
      usePlayerStore.setState((s2) => ({
        state: s2.state
          ? { ...s2.state, relationship: { ...s2.state.relationship, [cid]: s2.state.relationship[cid] ?? emptyRelationship() } }
          : s2.state,
      }));
    }
  },

  mergeCharacters(survivorId, dupId) {
    const st = get();
    if (!st.project || !st.state || survivorId === dupId) return;
    // Обновляем состояние (отношения/gm/телефон) и проект (персонажи) согласованно.
    const next: RuntimeState = JSON.parse(JSON.stringify(st.state));

    // Статы отношений — берём максимум по каждому полю, дубль удаляем.
    const rel = next.relationship;
    if (rel[dupId]) {
      const s = rel[survivorId] || emptyRelationship();
      const d = rel[dupId];
      rel[survivorId] = {
        affection: Math.max(s.affection, d.affection),
        passion_stat: Math.max(s.passion_stat, d.passion_stat),
        friendship: Math.max(s.friendship, d.friendship),
        respect: Math.max(s.respect, d.respect),
      };
      delete rel[dupId];
    }

    // Реестр: survivor поглощает алиасы/merged дубля; запись дубля убираем.
    const reg = (next.gm.registry ||= []);
    const surv = reg.find((e) => e.id === survivorId);
    const dup = reg.find((e) => e.id === dupId);
    if (surv && dup) {
      for (const a of [dup.canonicalName, ...dup.aliases]) {
        if (!surv.aliases.some((x) => x.toLowerCase() === a.toLowerCase())) surv.aliases.push(a);
      }
      surv.merged = [...(surv.merged || []), dupId, ...(dup.merged || [])];
      surv.status = surv.status || dup.status;
    }
    next.gm.registry = reg.filter((e) => e.id !== dupId);
    // GM-досье дубля убираем (survivor остаётся).
    next.gm.characters = next.gm.characters.filter((c) => c.charId !== dupId);

    // Телефон: контакты/переписки дубля → survivor.
    if (next.phone) {
      const dupChat = next.phone.chats.find((c) => c.kind === 'direct' && c.participantIds[0] === dupId);
      if (dupChat) {
        const survChat = next.phone.chats.find((c) => c.kind === 'direct' && c.participantIds[0] === survivorId);
        if (survChat) {
          survChat.messages = [...survChat.messages, ...dupChat.messages].sort((a, b) => a.at - b.at);
          next.phone.chats = next.phone.chats.filter((c) => c !== dupChat);
        } else {
          dupChat.participantIds = [survivorId];
          for (const m of dupChat.messages) if (m.senderId === dupId) m.senderId = survivorId;
        }
      }
      for (const c of next.phone.chats) {
        c.participantIds = c.participantIds.map((id) => (id === dupId ? survivorId : id)).filter((id, i, a) => a.indexOf(id) === i);
        for (const m of c.messages) if (m.senderId === dupId) m.senderId = survivorId;
      }
      next.phone.contacts = next.phone.contacts.filter((c) => c.characterId !== dupId && c.id !== dupId);
      next.phone.unreadFrom = next.phone.unreadFrom
        .map((id) => (id === dupId ? survivorId : id))
        .filter((id, i, a) => a.indexOf(id) === i);
    }

    set({ state: next });
    // Проект: удаляем персонажа-дубль.
    void get().patchProject((p) => {
      p.characters = p.characters.filter((c) => c.id !== dupId);
    });
    void get().autosave();
  },

  async testImageApi() {
    const st = get();
    if (!st.project) return 'Проект не загружен.';
    if (!getApiKey('image')) return 'Не задан ключ image-API (🎬 CG-студия → подключение).';
    try {
      const ig = st.project.imageGen ?? defaultImageGenConfig();
      // Минимальная генерация — проверяем, что ключ/URL/модель отвечают.
      const blob = await generateImage(ig, {
        prompt: 'a tiny simple test image of a single red apple on a plain white background',
      });
      if (!blob || blob.size === 0) return 'Пустой ответ от image-API.';
      return '';
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  },

  // Скрепка в мессенджере: своя картинка с устройства (галерея/камера телефона)
  // кладётся в ассеты проекта и в галерею телефона — дальше её видно как любое фото.
  async uploadPhonePhoto(file) {
    try {
      const asset = await uploadAsset(file, 'cg');
      asset.name = `Фото: ${file.name.replace(/\.[^.]+$/, '').slice(0, 24) || 'из галереи'}`;
      await get().patchProject((p) => {
        if (!p.assets.some((a) => a.id === asset.id)) p.assets.push(asset);
      });
      get().patchPhone((p) => {
        p.gallery = [...p.gallery, asset.id];
      });
      return asset.id;
    } catch (e) {
      logEvent('error', 'phone', 'Не удалось загрузить фото: ' + (e as Error).message);
      set({ error: 'Не удалось загрузить фото.' });
      return null;
    }
  },

  patchInventory(mutator) {
    const st = get();
    if (!st.state) return;
    const inventory: InventoryItem[] = JSON.parse(JSON.stringify(st.state.inventory ?? []));
    mutator(inventory);
    set({ state: { ...st.state, inventory } });
    void get().autosave();
  },

  setSceneOutfit(characterId, outfit) {
    const st = get();
    if (!st.state) return;
    // Меняем наряд в уже показанных битах (спрайт сменится сразу) и в onScreen
    // (сохранится + уйдёт в контекст ИИ на следующий ход).
    const visibleBeats = st.visibleBeats.map((b) =>
      b.type === 'dialogue' && b.characterId === characterId ? { ...b, outfit } : b
    );
    const queue = st.queue.map((b) =>
      b.type === 'dialogue' && b.characterId === characterId ? { ...b, outfit } : b
    );
    const onScreen = st.state.onScreen.some((o) => o.characterId === characterId)
      ? st.state.onScreen.map((o) => (o.characterId === characterId ? { ...o, outfit } : o))
      : [...st.state.onScreen, { characterId, emotion: 'neutral', outfit, position: 'center' as const }];
    set({ visibleBeats, queue, state: { ...st.state, onScreen } });
    void get().autosave();
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

  // Возврат свёрнутого периода в живую историю. Архив хранит текст периода
  // построчно («ИГРОК: …» / «ИГРА: …»), поэтому сообщения восстанавливаются
  // дословно и встают в начало истории — ИИ снова их видит. Нужно, когда свёртка
  // не удалась и период выпал из памяти: пересказ уже не восстановить, а текст —
  // можно. Повторный клик ничего не дублирует.
  restoreArchivedPeriod(archiveIndex) {
    const st = get();
    if (!st.state) return;
    const chunk = st.state.memory.rawArchive[archiveIndex];
    if (!chunk?.text?.trim()) {
      pushToast('error', 'В архиве нет текста этого периода.');
      return;
    }
    const msgs = parseArchivedTranscript(chunk.text);
    if (!msgs.length) {
      pushToast('error', 'Не удалось разобрать архив периода.');
      return;
    }
    if (st.state.history.some((h) => h.content === msgs[0].content)) {
      pushToast('info', 'Этот период уже в живой истории.');
      return;
    }
    const next: RuntimeState = { ...st.state, history: [...msgs, ...st.state.history] };
    set({ state: next });
    logEvent('info', 'memory', `Период (ход ${chunk.turn}) возвращён в живую историю: ${msgs.length} сообщений`);
    pushToast('success', `Вернула ${msgs.length} сообщений периода в живую историю.`);
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

// Ответ ИИ в чате: один запрос → пачка «пузырей» с живыми паузами набора.
// Общая для лички и групп (в группе ИИ сам решает, кто отвечает). Фото, которое
// бот решил приложить, генерируется после того, как пузырь уже показан.
async function runChatReplies(
  get: () => PlayerStore,
  set: (partial: Partial<PlayerStore>) => void,
  chatId: string,
  opts: { spontaneous?: boolean }
): Promise<void> {
  const cur = get();
  const chat = cur.state?.phone?.chats.find((c) => c.id === chatId);
  if (!cur.project || !cur.state || !chat) return;
  let replies: ChatReply[] = [];
  try {
    replies = await generateChatReplies(cur.project, cur.state, chat, { spontaneous: opts.spontaneous });
  } catch (e) {
    logEvent('error', 'phone', e instanceof Error ? e.message : String(e));
    if (!opts.spontaneous) {
      get().patchPhone((p) => {
        const c = p.chats.find((x) => x.id === chatId);
        c?.messages.push({ id: uid('msg'), from: 'contact', text: '…(нет связи)', at: Date.now() });
      });
    }
    return;
  }
  if (!replies.length) {
    // Модель вернула пустоту даже после повтора — не мусорим в переписке
    // пузырём-заглушкой, честно сообщаем и даём переотправить.
    if (!opts.spontaneous) set({ error: 'Собеседник не ответил (пустой ответ модели). Попробуйте ещё раз.' });
    return;
  }
  for (const r of replies) {
    await sleep(typingDelay(r.text || '📷'));
    const msgId = uid('msg');
    get().patchPhone((p) => {
      const c = p.chats.find((x) => x.id === chatId);
      if (!c) return;
      c.messages.push({
        id: msgId,
        from: 'contact',
        senderId: r.senderId,
        text: r.text,
        photoPrompt: r.photoPrompt,
        pendingPhoto: !!r.photoPrompt,
        at: Date.now(),
      });
      if (opts.spontaneous) c.unread = true;
    });
  }
  // Фото — уже после того, как переписка показана целиком.
  if (replies.some((r) => r.photoPrompt)) await get().resolvePendingPhotos();
}

// Групповые чаты живут сами по себе: после хода группа с некоторой вероятностью
// (её «оживлённость», 0..100) сама заводит разговор — кто-то кидает новость, шутку
// или фото. Пишет не больше одной группы за ход, чтобы телефон не взрывался.
async function maybeGroupChatter(
  get: () => PlayerStore,
  set: (partial: Partial<PlayerStore>) => void
): Promise<void> {
  const st = get();
  if (!st.project?.phone?.enabled || !st.state?.phone || st.phoneTypingFrom) return;
  const groups = st.state.phone.chats.filter(
    (c) => c.kind === 'group' && !c.archived && c.participantIds.length > 0
  );
  if (!groups.length) return;
  // Кандидаты по своей же вероятности; из прошедших ролл берём одну случайную.
  const rolled = groups.filter((g) => Math.random() * 100 < (g.groupActivity ?? 50) / 3);
  if (!rolled.length) return;
  const chat = rolled[Math.floor(Math.random() * rolled.length)];
  // Не встреваем, если последним в группе и так писал бот, а герой не отвечал.
  const last = chat.messages[chat.messages.length - 1];
  if (last && last.from === 'contact' && chat.unread) return;
  set({ phoneTypingFrom: chat.id });
  try {
    await runChatReplies(get, set, chat.id, { spontaneous: true });
    if (get().project?.phone?.popupNotifications) {
      pushToast('info', `💬 Новые сообщения в «${chat.title || 'группе'}»`);
    }
  } finally {
    set({ phoneTypingFrom: null });
  }
}

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
  playerMove: string,
  rejectedTurn?: string
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
  // База для будущего реролла: состояние ровно перед этим ходом.
  const turnBase: RuntimeState = JSON.parse(JSON.stringify(baseState));
  set({ thinking: true, error: null, choices: [], statFlash: [], queue: [], visibleBeats: [] });
  logEvent('info', 'turn', `Ход: ${playerMove.slice(0, 60)}`);
  try {
    // Обычная (нестриминговая) генерация — один ход целиком, затем показ.
    const { turn, state } = await runTurn(project, baseState, playerMove, controller.signal, rejectedTurn);

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
    preTurnState = { move: playerMove, state: turnBase };
    logEvent('info', 'turn', `Ход применён (ход ${state.turnCount}, beats: ${turn.beats.length})`);
    // Телефон живёт своей жизнью параллельно сцене: догенерируем фото, которые
    // боты прислали этим ходом, и даём группам шанс написать самим. Всё в фоне —
    // ход игрока это не задерживает и падать из-за этого не должно.
    void get()
      .resolvePendingPhotos()
      .then(() => maybeGroupChatter(get, set))
      .catch((err) => logEvent('warn', 'phone', 'Фоновая жизнь телефона: ' + (err as Error).message));
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
