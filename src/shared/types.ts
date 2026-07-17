// Core project data models (see ТЗ §4 + доработки)

export type ContentRating = 'sfw' | 'mature';
export type CharacterRole = 'protagonist' | 'love_interest' | 'important_character' | 'npc';
export type AssetType = 'background' | 'sprite' | 'music' | 'sfx' | 'cg' | 'icon';

// Закрытый словарь эмоций — единый для нейминга файлов, выбора ИИ и UI-сетки.
// Ключи всегда английские; UI показывает локализованные подписи поверх ключа.
export const EMOTIONS = [
  'neutral',
  'joy',
  'sadness',
  'anger',
  'irritation',
  'embarrassment',
  'tender',
  'passion',
  'fear',
  'surprise',
  'mad',
] as const;
export type Emotion = (typeof EMOTIONS)[number];

export const EMOTION_LABELS: Record<Emotion, { ru: string; en: string }> = {
  neutral: { ru: 'нейтральная', en: 'neutral' },
  joy: { ru: 'радость', en: 'joy' },
  sadness: { ru: 'грусть', en: 'sadness' },
  anger: { ru: 'гнев', en: 'anger' },
  irritation: { ru: 'раздражение', en: 'irritation' },
  embarrassment: { ru: 'смущение', en: 'embarrassment' },
  tender: { ru: 'нежность', en: 'tenderness' },
  passion: { ru: 'страсть', en: 'passion' },
  fear: { ru: 'страх', en: 'fear' },
  surprise: { ru: 'удивление', en: 'surprise' },
  mad: { ru: 'одержимость', en: 'madness' },
};

// Закрытый словарь аудио-настроений (НЕ теги). ИИ выбирает настроение, движок — трек.
// Базовый закрытый словарь — 8 настроений (см. CR v2 §N.1). Проект может
// дополнить его своими кастомными ключами (Project.audioMoods, §N.2) — поэтому
// везде, где реально проверяется/передаётся настроение, используется string,
// а не этот union; AUDIO_MOODS — только источник базового набора для UI/ядра.
export const AUDIO_MOODS = [
  'calm',
  'tense',
  'scary',
  'romantic',
  'sad',
  'joyful',
  'epic',
  'dangerous',
] as const;
export type AudioMood = (typeof AUDIO_MOODS)[number];

export const AUDIO_MOOD_LABELS: Record<AudioMood, { ru: string; en: string }> = {
  calm: { ru: 'спокойная', en: 'calm' },
  tense: { ru: 'напряжённая', en: 'tense' },
  scary: { ru: 'жуткая', en: 'scary' },
  romantic: { ru: 'романтичная', en: 'romantic' },
  sad: { ru: 'грустная', en: 'sad' },
  joyful: { ru: 'весёлая', en: 'joyful' },
  epic: { ru: 'эпичная', en: 'epic' },
  dangerous: { ru: 'опасная', en: 'dangerous' },
};

export interface ProjectMeta {
  title: string;
  coverAssetId?: string;
  contentRating: ContentRating;
}

export interface Lore {
  worldDescription: string;
  plotOutline: string;
  openingScene: string;
  narrativeRules: string;
}

export interface LorebookEntry {
  id: string;
  title: string;
  keys: string[];
  content: string;
  alwaysActive: boolean;
  priority: number;
}

export interface CharacterCard {
  appearance: string;
  personality: string;
  backstory: string;
  speechStyle: string;
  relationshipArc?: string;
  scenario?: string; // из ST-карточки (стартовый контекст)
  greetings?: string[]; // first_mes + alternate_greetings
}

// Связанные статы отношений у КАЖДОГО персонажа (см. CR v2 §C), -100..100.
export interface RelationshipStats {
  affection: number; // ❤️ симпатия
  passion_stat: number; // 🔥 страсть
  friendship: number; // 🍀 дружба
  respect: number; // 🎖 уважение
}

export const RELATIONSHIP_FIELDS = ['affection', 'passion_stat', 'friendship', 'respect'] as const;
export type RelationshipField = (typeof RELATIONSHIP_FIELDS)[number];

export const RELATIONSHIP_META: Record<
  RelationshipField,
  { icon: string; ru: string; en: string }
> = {
  affection: { icon: '❤️', ru: 'Симпатия', en: 'Affection' },
  passion_stat: { icon: '🔥', ru: 'Страсть', en: 'Passion' },
  friendship: { icon: '🍀', ru: 'Дружба', en: 'Friendship' },
  respect: { icon: '🎖', ru: 'Уважение', en: 'Respect' },
};

export function emptyRelationship(): RelationshipStats {
  return { affection: 0, passion_stat: 0, friendship: 0, respect: 0 };
}

// Набор спрайтов одного наряда (костюма/внешнего вида) персонажа. Наряд — открытая
// ось (свободный тег), НЕЗАВИСИМАЯ от закрытого словаря эмоций. Внутри наряда — та же
// сетка 11 эмоций. См. Batch 5.3.
export interface OutfitSprites {
  outfit: string; // свободный тег наряда, задаёт юзер (regular/masked/suit/…)
  sprites: Partial<Record<Emotion, string>>;
}

export interface Character {
  id: string;
  name: string;
  role: CharacterRole;
  card: CharacterCard;
  // emotion -> assetId ДЕФОЛТНОГО наряда. Спрайты опциональны для любой роли: нет
  // спрайта — реплика рендерится как имя + текст (единое правило, без крашей).
  sprites: Partial<Record<Emotion, string>>;
  // Дополнительные наряды сверх дефолтного (опционально). Персонаж без доп. нарядов
  // работает как раньше — один набор спрайтов (this.sprites). См. Batch 5.3.
  outfits?: OutfitSprites[];
  // Тег дефолтного наряда (набор которого лежит в this.sprites). undefined ⇒ 'base'.
  // Обязателен как fallback: невалидный/отсутствующий наряд откатывается на него.
  defaultOutfit?: string;
  relationship: RelationshipStats; // стартовые значения (правятся в конструкторе)
  relationshipHidden?: boolean; // скрыть в инфобоксе
  linkedStatId?: string;
  importedFrom?: 'tavern_v2' | 'tavern_v3' | 'manual' | 'promoted_npc';
  sourceSystemPrompt?: string; // из карточки, НЕ применять авто
}

export interface StatDefinition {
  id: string;
  name: string;
  iconAssetId?: string;
  min: number;
  max: number;
  initial: number;
  visible: boolean;
  description: string;
}

export interface AssetMeta {
  id: string;
  type: AssetType;
  name: string;
  tags?: string[]; // для background/cg/sfx
  audioMood?: string; // для music — базовое (AudioMood) или кастомное настроение проекта
  generated?: boolean; // сгенерирован image-API по ходу игры
  blobKey: string;
  mime?: string;
}

export interface AdvancedPromptBlock {
  content: string;
  depth: number; // глубина от конца истории (0 = сразу перед ходом игрока)
}

// Переиспользуемое подключение: игра / саммари / эмбеддинги / картинки (см. CR v2 §G).
// Ключ API НЕ хранится здесь — только локально через ai/keys.ts по роли подключения.
export interface ApiConnection {
  provider: 'openai-compatible' | 'anthropic';
  baseUrl: string;
  model?: string;
  availableModels?: string[];
}

// Разделение ролей ИИ (Batch 5.4): Рассказчик (основная модель, сюжет/beats/статы) и
// Селектор ассетов (классификация emotion/наряд/фон/музыка из закрытых списков —
// справляются и маленькие/локальные модели). Источник селектора:
//   'main'   — та же модель, что Рассказчик (дефолт; ассеты выбирает сам нарратор);
//   'custom' — отдельное подключение (дешёвая/быстрая модель, ключ роли 'assetSelector');
//   'local'  — локальная модель в браузере (эмбеддинги MiniLM в Web Worker, как §E3).
export type AssetSelectorSource = 'main' | 'custom' | 'local';
export interface AssetSelectorConfig {
  source: AssetSelectorSource;
  customApi?: ApiConnection; // если source === 'custom'
}

// Тумблеры Слоя 2 (см. CR v2 §F1.2, адаптация пресета Omaya).
export type PromptLength = 'short' | 'medium' | 'long';
export type PromptPacing = 'slow_burn' | 'fast' | 'adaptive';
export type PromptTone = 'neutral' | 'anti_negative' | 'anti_saccharine';
export type ProseStyleId = 'clean' | 'anne_rice' | 'king' | 'gaiman' | 'dostoevsky' | 'gogol';

export interface AiConfig {
  provider: 'openai-compatible' | 'anthropic';
  baseUrl: string;
  model: string;
  temperature: number;
  maxContextMessages: number;
  contextBudget: number;
  liveWindow: number;
  summarizerModel?: string;
  // Слоёная промпт-архитектура (слой 1 — ядро — вшит и не хранится в конфиге)
  narrativeLanguage: 'ru' | 'en'; // язык нарратива (независим от языка UI)
  stylePreset: string; // id пресета или 'custom'
  customStyle?: string;
  length: PromptLength;
  pacing: PromptPacing;
  tone: PromptTone;
  proseStyle: ProseStyleId;
  jailbreakEnabled: boolean; // слой 3, по умолчанию ВЫКЛ
  jailbreakPrompt?: string;
  prefill?: string; // слой 4 (продвинутый)
  // Длина хода в СЛОВАХ: авторитетный диапазон min..max, задаётся ползунком/вводом
  // в пресете. Переопределяет числа в тексте блока «Стиль». undefined = дефолт.
  turnLength?: { min: number; max: number };
  // Частота выборов: минимум ходов между показами выбора. 0/undefined = без
  // ограничения (как решит ИИ). Движок глушит choices, если прошло меньше N ходов.
  choiceMinGap?: number;
  // «Глубина размышления» reasoning-моделей (Gemini 3 pro, o-series и т.п.):
  // отправляется как reasoning_effort. Меньше = быстрее ответ. undefined = не
  // отправлять (поведение провайдера по умолчанию — у thinking-моделей медленное).
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
  // Управляемое размышление: вместо медленной родной «думалки» модель пишет
  // короткий план в <thinking> (через префилл) — быстрее. thinkingPlan — шаблон
  // плана (редактируемый). При включении родной reasoning форсится в none.
  guidedThinking?: boolean;
  thinkingPlan?: string;
  advancedBlocks?: AdvancedPromptBlock[];
  // Генерация изображений (BYO key, ключ в localStorage под ролью 'image')
  imageBaseUrl?: string;
  imageModel?: string;
  // Отдельное подключение для саммари (см. CR v2 §E2.3/§G). undefined = использовать
  // основное игровое подключение (глобальное).
  summaryConnection?: ApiConnection;
  // Селектор ассетов (Batch 5.4). undefined ⇒ { source: 'main' } — как сейчас.
  assetSelector?: AssetSelectorConfig;
  // Полностью редактируемый пресет промпта (Batch 3 §8). any — чтобы не тянуть
  // ai-слой в shared/types; реальная форма — PromptPreset из ai/promptPreset.ts.
  promptPreset?: unknown;
}

// Настройки памяти проекта (см. CR v2 §E).
export type VectorizationMode = 'builtin' | 'custom' | 'off';

export interface MemoryConfig {
  summaryEveryN: number; // частота свёртки (20/30/40/…) по счётчику сообщений
  summaryPrompt?: string; // кастомный промпт саммарайзера, иначе дефолт
  vectorization: VectorizationMode;
  embeddingsConnection?: ApiConnection; // для 'custom'
}

export function defaultMemoryConfig(): MemoryConfig {
  return { summaryEveryN: 30, vectorization: 'off' };
}

// Длина хода (слов). Ползунок/ввод ограничены этими границами; дефолт совпадает с
// длинными ходами по умолчанию.
export const TURN_LENGTH_BOUNDS = { min: 100, max: 2500 } as const;
export const DEFAULT_TURN_LENGTH = { min: 500, max: 900 };
// Короткий шаблон плана для управляемого размышления (по умолчанию). Специально
// компактный — длинный план = медленно, теряется весь смысл.
export const DEFAULT_THINKING_PLAN = `- Focus: what shifts this turn (1 line)
- Present & what each wants (1 line)
- Any stat/relationship change? (1 line, or "none")
- Offer a choice? (only at a real fork, else "no")`;

export function normalizeTurnLength(v: any): { min: number; max: number } {
  const clampW = (n: number) =>
    Math.min(Math.max(Math.round(n), TURN_LENGTH_BOUNDS.min), TURN_LENGTH_BOUNDS.max);
  const lo = Number(v?.min);
  const hi = Number(v?.max);
  let min = Number.isFinite(lo) ? clampW(lo) : DEFAULT_TURN_LENGTH.min;
  let max = Number.isFinite(hi) ? clampW(hi) : DEFAULT_TURN_LENGTH.max;
  if (min > max) [min, max] = [max, min];
  return { min, max };
}

export interface Project {
  id: string;
  createdAt: number;
  updatedAt: number;
  meta: ProjectMeta;
  lore: Lore;
  lorebook: LorebookEntry[]; // статичный мир (см. CR v2 §E1) — Меморибук отдельно, в RuntimeState.memory
  characters: Character[];
  stats: StatDefinition[];
  assets: AssetMeta[];
  aiConfig: AiConfig;
  memoryConfig: MemoryConfig;
  audioMoods: string[]; // кастомные настроения сверх базовых 8 (см. CR v2 §N.2)
}

// ---- Runtime / AI response types (JSON-контракт с ИИ) ----

// bg — динамическая смена фона на этом бите (id ассета-фона), как emotion у реплик.
// ИИ ставит его на бите, где меняется место/обстановка; движок при сборке хода
// «протягивает» эффективный фон вперёд, поэтому у каждого бита bg заполнен.
export type Beat =
  | { type: 'narration'; text: string; bg?: string }
  | { type: 'thought'; text: string; bg?: string }
  | {
      type: 'dialogue';
      characterId?: string; // для персонажей из списка
      name?: string; // для эпизодических NPC, введённых ИИ
      emotion: string;
      // Наряд говорящего на этом бите (свободный тег из доступных наряду персонажа).
      // undefined ⇒ дефолтный наряд. Невалидный тег движок откатывает по fallback.
      outfit?: string;
      position: 'left' | 'center' | 'right';
      text: string;
      bg?: string;
    };

export interface SceneDirective {
  backgroundId: string | null;
  musicMood: string | null; // ИИ выбирает НАСТРОЕНИЕ, не трек
  sfxId: string | null;
  cutsceneCgId: string | null;
}

export interface StatChange {
  statId: string;
  delta: number;
  reason: string;
}

export interface Choice {
  id: string;
  text: string;
  cost: { statId: string; amount: number } | null;
}

export type ChapterEvent = 'chapter_end' | 'cg_moment' | null;

export interface AiTurn {
  scene: SceneDirective;
  beats: Beat[];
  statChanges: StatChange[];
  choices: Choice[];
  chapterEvent: ChapterEvent;
  worldState?: WorldStateUpdate; // обновление Game Master за этот ход (опц.)
}

// Дельта состояния мира, которую ИИ присылает каждый ход (Game Master). Все поля
// опциональны — движок мержит их в RuntimeState.gm.
export interface WorldStateUpdate {
  clock?: { day?: string; month?: string; year?: string; time?: string; location?: string };
  characters?: Array<Partial<Omit<GmCharacter, 'tags'>> & { name: string; tags?: string[] }>;
  relations?: GmRelationEdge[];
  locations?: Array<{ name: string; description?: string; tags?: string[] }>; // новые/изменённые локации
  event?: string; // анализ текущей сцены
  eventChars?: string[]; // с кем произошло событие
  mood?: string; // общее настроение сцены
  agendaAdd?: string[]; // новые задачи в адженду
  agendaDone?: string[]; // задачи, отмеченные выполненными (по тексту)
}

// ---- Memory (см. CR v2 §E — без деления на главы, история бесконечна) ----

export interface CanonicalFact {
  turn: number; // номер хода, на котором произошло событие (не «глава»)
  kind: 'choice' | 'stat' | 'event';
  text: string;
}

// Меморибук — динамическая, авто-заполняемая сущность (в отличие от статичного
// Лорбука). Записи создаёт движок по значимым событиям; юзер правит/удаляет/
// продвигает в постоянные прямо в игре (см. CR v2 §E1).
export interface MemoryBookEntry {
  id: string;
  text: string;
  turn: number;
  source: 'auto' | 'manual';
  pinned: boolean; // «продвинута в постоянные» — всегда в контексте, не сжимается
}

// Запись Хроники (одно сжатие). Пользователь видит список свёрток с диапазоном
// сообщений, нумерацией и текстом — редактируемым/удаляемым (см. правку по саммари).
export interface ChronicleEntry {
  id: string;
  text: string;
  atTurn: number; // ход, на котором создана свёртка
  fromMsg: number; // порядковый номер первого свёрнутого сообщения (1-based)
  toMsg: number; // порядковый номер последнего свёрнутого сообщения
}

export interface MemoryState {
  chronicle: ChronicleEntry[]; // свёрнутые сегменты истории (список записей)
  foldedMsgCount: number; // всего сообщений свёрнуто (для диапазонов записей)
  liveSummary: string; // ручная заметка о текущей арке (не авто-управляется)
  facts: CanonicalFact[]; // canonical facts store — не проходит через LLM-сжатие
  memorybook: MemoryBookEntry[];
  messagesSinceSummary: number; // счётчик для триггера по частоте (E2.1)
  // Свёрнутые «сырые» куски истории — НЕ инжектятся целиком, только через
  // векторный подсос релевантного (см. CR v2 §E3).
  rawArchive: { turn: number; text: string }[];
}

export type LlmRole = 'system' | 'user' | 'assistant';
export interface LlmMessage {
  role: LlmRole;
  content: string;
}

// ---- Game Master (вдохновлено Horae) — динамическое состояние мира, которое ИИ
// обновляет каждый ход: досье персонажей, статусы/настроение/одежда, сетка
// отношений, календарь/часы, анализ сцен (события), адженда (задачи). Живёт в
// сейве, редактируется в панели Game Master. Помогает ИИ не путаться в персонажах
// и сюжете (структурированная память вместо раздутого контекста). ----

export interface GmCharacter {
  charId?: string; // связь с персонажем проекта, если есть
  name: string;
  dossier: string; // кто это (кратко)
  appearance: string;
  personality: string;
  roleToHero: string; // кто он для протагониста
  outfit: string; // во что одет сейчас
  mood: string; // текущее настроение
  status: string; // текущий статус (ранен, присутствует, ушёл…)
  location: string;
  tags: string[]; // вся инфа тегами (для ИИ)
}

export interface GmRelationEdge {
  from: string; // имя персонажа
  to: string;
  label: string; // характер связи между персонажами
}

// Событие = запись «меморибука»: что произошло, когда (внутриигровая дата) и с кем.
export interface GmEvent {
  id: string;
  turn: number;
  date: string; // внутриигровая дата/время на момент события (для хронологии)
  chars: string[]; // с кем произошло
  summary: string; // что произошло
  mood: string; // настроение сцены
  source: 'auto' | 'manual';
}

export interface GmTask {
  id: string;
  text: string;
  done: boolean;
  source: 'auto' | 'manual';
}

// Память локаций: места, которые уже встречались в истории (для непротиворечивости
// описаний). ИИ дополняет их через worldState.locations; редактируются в GM-панели.
export interface GmLocation {
  id: string;
  name: string;
  description: string; // приметы места, атмосфера, кто там бывает
  tags: string[];
  source: 'auto' | 'manual';
}

// Внутриигровые часы/календарь. День/месяц/год + время + локация. Месяцы
// настраиваемые (для фэнтези-сеттинга; по умолчанию — земные 12).
export interface GmClock {
  day: string; // число/день, напр. "3"
  month: string; // название месяца (из calendar.months либо своё)
  year: string; // год, напр. "1024"
  time: string; // время суток, напр. "14:30" / "evening"
  location: string; // текущая локация
}

export interface GmCalendar {
  months: string[]; // названия месяцев по порядку (кастомизируемо)
}

export const DEFAULT_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export interface GameMasterState {
  clock: GmClock;
  calendar: GmCalendar;
  showClockInGame: boolean; // выносить часы/дату отдельно в игру
  characters: GmCharacter[];
  relations: GmRelationEdge[];
  events: GmEvent[];
  agenda: GmTask[];
  locations: GmLocation[];
}

export function emptyGameMaster(): GameMasterState {
  return {
    clock: { day: '', month: '', year: '', time: '', location: '' },
    calendar: { months: [...DEFAULT_MONTHS] },
    showClockInGame: false,
    characters: [],
    relations: [],
    events: [],
    agenda: [],
    locations: [],
  };
}

// ---- Save slots ----

export interface OnScreenSprite {
  characterId: string;
  emotion: string;
  outfit?: string; // текущий наряд персонажа на сцене (undefined ⇒ дефолтный)
  position: 'left' | 'center' | 'right';
}

export interface RuntimeState {
  protagonistName: string; // имя героя (из карточки протагониста в конструкторе)
  statValues: Record<string, number>;
  // Живые значения статов отношений per персонаж (charId -> RelationshipStats).
  relationship: Record<string, RelationshipStats>;
  currentBackgroundId: string | null;
  currentMusicMood: string | null;
  currentMusicAssetId: string | null; // фактический играющий трек
  onScreen: OnScreenSprite[];
  history: LlmMessage[];
  memory: MemoryState;
  gm: GameMasterState; // динамическое состояние мира (Game Master)
  lastTurn: AiTurn | null;
  turnCount: number;
  // Номер хода, когда игроку в последний раз показали выборы — для троттлинга
  // частоты выборов (aiConfig.choiceMinGap). -1e9 = ещё ни разу.
  lastChoiceTurn: number;
  // Заметки для ИИ (Author's Notes) — список записей, каждая инжектится перед
  // ходом игрока (глубина 0). Менеджер заметок в игре: создать/править/подтвердить/
  // удалить/копировать. Живут в сейве до ручного изменения.
  authorNotes: AuthorNote[];
}

export interface AuthorNote {
  id: string;
  text: string;
}

// Batch 5.2 — три уровня сущностей сейвов:
//  • Прохождение (playthrough) — независимый заход в историю. У него ровно один
//    автосейв-курсор (kind:'autosave', перезаписывается) и любое число чекпоинтов.
//  • Автосейв — непрерывный курсор «последнее состояние» внутри прохождения.
//  • Чекпоинт (kind:'checkpoint') — РУЧНАЯ точка-ветка (полная копия истории до неё).
// Всё хранится теми же durable-сейвами (IndexedDB + диск). Старые сейвы без этих
// полей попадают в бакет прохождения 'legacy' (kind по умолчанию — autosave).
export type SaveKind = 'autosave' | 'checkpoint';

export interface SaveSlot {
  slot: number; // уникальный числовой id записи (файл saves/<slot>.jsonl)
  projectId: string;
  savedAt: number;
  title: string;
  state: RuntimeState;
  kind?: SaveKind; // undefined ⇒ 'autosave'
  playthroughId?: string; // undefined ⇒ бакет 'legacy'
  playthroughLabel?: string; // человекочитаемое имя прохождения (на курсоре)
  playthroughCreatedAt?: number;
  checkpointId?: string; // стабильный id чекпоинта (для ссылок форка)
  parentCheckpointId?: string; // от какого чекпоинта форкнулись (внутри прохождения)
  branchName?: string; // имя чекпоинта/ветки для UI
}
