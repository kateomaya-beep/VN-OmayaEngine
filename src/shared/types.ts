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
  description?: string; // когда его надевать — триггер для ИИ (напр. «в нижнем белье; когда персонаж раздет»)
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
  /** @deprecated Связь стат↔персонаж переехала на StatDefinition.linkedCharacterId
   * (чтобы к одному персонажу можно было привязать несколько статов). Поле читается
   * только для миграции старых проектов. */
  linkedStatId?: string;
  importedFrom?: 'tavern_v2' | 'tavern_v3' | 'manual' | 'promoted_npc' | 'scanned_contact' | 'gm_sheet';
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
  // Персонаж, к которому привязан стат (опционально). Связь живёт НА СТАТЕ, поэтому к
  // одному персонажу можно привязать НЕСКОЛЬКО статов (many-to-one).
  linkedCharacterId?: string;
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
  minorEventsLimit?: number; // лимит MINOR EVENTS в саммари (Batch 6 §2), дефолт 10
  vectorization: VectorizationMode;
  embeddingsConnection?: ApiConnection; // для 'custom'
}

export function defaultMemoryConfig(): MemoryConfig {
  return { summaryEveryN: 30, minorEventsLimit: 10, vectorization: 'off' };
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
  playerTheme?: PlayerTheme; // пер-проектное оформление плеера (мини-мастерская)
  imageGen?: ImageGenConfig; // CG-студия: генерация кат-сцен через image-API
  randomEvents?: RandomEventConfig; // случайные сюжетные события (Batch 6 §3)
  randomSms?: RandomSmsConfig; // случайные входящие СМС — отдельно от событий (Batch 8-fix)
  phone?: PhoneConfig; // расширение «Телефон» (Batch 7)
  finance?: ProjectFinanceConfig; // стартовый капитал + регулярные статьи (Batch 8 §III)
}

// ---- Телефон (Batch 7) ----
// Опциональное расширение: внутриигровой смартфон, двусторонне связанный с игрой.
// PhoneConfig — авторская настройка (в проекте); PhoneState — рантайм (в RuntimeState/сейве).
// Баланс — глобальный «стат» под зарезервированным id (участвует в statChanges/контексте).
export const PHONE_BALANCE_STAT = 'phone_balance';

// ---- Инвентарь (Batch 8, Часть IV) — вещи протагониста. Живёт в RuntimeState
// (не в телефоне): существует даже при выключенном расширении «Телефон».
export interface InventoryItem {
  id: string;
  name: string;
  emoji: string;
  quantity: number;
  category?: string; // одежда|еда|ценности|ключевые|прочее|своё
  acquiredDate?: string; // ДД/ММ/ГГГГ
  source?: string; // «куплено» | «получено» | «найдено» | …
  manualEntry?: boolean;
}

// ---- Финансы проекта (Batch 8, Часть III): стартовый капитал + регулярные статьи.
export interface RecurringEntry {
  id: string;
  name: string;
  amount: number; // всегда положительное
  kind: 'income' | 'expense';
  periodDays: number;
  nextChargeDate: string; // ДД/ММ/ГГГГ
  enabled: boolean;
}

export interface ProjectFinanceConfig {
  startingBalance: number;
  startDate?: string; // стартовая внутриигровая дата ДД/ММ/ГГГГ (Batch 8 §II.2)
  recurringEntries: RecurringEntry[];
}

export function defaultFinanceConfig(): ProjectFinanceConfig {
  return { startingBalance: 0, recurringEntries: [] };
}

export function normalizeFinanceConfig(v: unknown): ProjectFinanceConfig {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const items = Array.isArray(o.recurringEntries) ? (o.recurringEntries as any[]) : [];
  return {
    startingBalance: typeof o.startingBalance === 'number' ? Math.round(o.startingBalance) : 0,
    startDate: typeof o.startDate === 'string' ? o.startDate : undefined,
    recurringEntries: items
      .filter((e) => e && typeof e.name === 'string' && typeof e.amount === 'number')
      .map((e) => ({
        id: typeof e.id === 'string' ? e.id : `rec_${Math.random().toString(36).slice(2, 8)}`,
        name: e.name,
        amount: Math.abs(Math.round(e.amount)),
        kind: e.kind === 'expense' ? 'expense' : 'income',
        periodDays: typeof e.periodDays === 'number' && e.periodDays > 0 ? Math.round(e.periodDays) : 30,
        nextChargeDate: typeof e.nextChargeDate === 'string' ? e.nextChargeDate : '',
        enabled: typeof e.enabled === 'boolean' ? e.enabled : true,
      })),
  };
}

export function normalizeInventory(v: unknown): InventoryItem[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((it) => it && typeof it.name === 'string')
    .map((it) => ({
      id: typeof it.id === 'string' ? it.id : `inv_${Math.random().toString(36).slice(2, 8)}`,
      name: it.name,
      emoji: typeof it.emoji === 'string' && it.emoji.trim() ? it.emoji : '📦',
      quantity: typeof it.quantity === 'number' && it.quantity > 0 ? Math.round(it.quantity) : 1,
      category: typeof it.category === 'string' ? it.category : undefined,
      acquiredDate: typeof it.acquiredDate === 'string' ? it.acquiredDate : undefined,
      source: typeof it.source === 'string' ? it.source : undefined,
      manualEntry: typeof it.manualEntry === 'boolean' ? it.manualEntry : undefined,
    }));
}

export interface PhoneShopItem {
  id: string;
  name: string;
  category: string;
  price: number;
  description?: string;
  generated?: boolean; // добавлен ИИ (кэш)
  outfitTag?: string; // одежда → тег наряда (если есть спрайт)
  spriteAssetId?: string;
}

// Категория доставки (ревизия блока 6): custom=true — добавлена юзером.
export interface PhoneDeliveryCategory {
  id: string;
  name: string;
  custom: boolean;
}

// Активный заказ доставки — влияет на сюжет (ИИ получает его в контексте).
export interface PhoneOrder {
  itemId: string;
  name: string;
  category: string;
  placedAtTurn: number;
  delivered?: boolean;
}

export interface PhoneConfig {
  enabled: boolean;
  showFloatingIcon: boolean;
  iconPosition: { x: number; y: number }; // проценты 0..100 от экрана
  wallpaperAssetId?: string;
  cameraPromptTemplate: string; // фронталка (селфи героя)
  rearCameraPromptTemplate: string; // основная камера: снимок того, что вокруг
  popupNotifications: boolean;
  currencyName: string; // «$», «кредиты» и т.п.
  priceGuide: string; // ориентиры цен сеттинга (уходят в контекст ИИ)
  deliveryCategories: PhoneDeliveryCategory[]; // только доставка (еда/одежда/дом + свои)
  baseCatalog: PhoneShopItem[]; // авторский базовый шаблон позиций доставки
}

export interface PhoneTransaction {
  amount: number;
  reason: string; // легаси/сводка; для новых — складывается из vendor+item
  vendor?: string; // где / от кого (выписка)
  item?: string; // что куплено / за что
  time?: string; // внутриигровое время
  date?: string; // внутриигровая дата ДД/ММ/ГГГГ (Batch 8 — для датированной выписки)
  at: number;
}
export interface PhoneContact {
  characterId: string;
  hidden?: boolean;
}
export interface PhoneMessage {
  from: 'protagonist' | 'contact';
  text: string;
  attachedAssetId?: string;
  at: number;
}
export interface PhoneInventoryItem {
  itemId: string;
  name: string;
  category: string;
}

export interface PhoneState {
  transactions: PhoneTransaction[];
  contacts: PhoneContact[];
  conversations: Record<string, PhoneMessage[]>; // characterId -> messages
  unreadFrom: string[]; // characterIds с непрочитанным
  gallery: string[]; // assetId сгенерированных фото
  inventory: PhoneInventoryItem[];
  deliveryCache: PhoneShopItem[]; // сгенерированные ИИ позиции доставки (кэш)
  activeOrders: PhoneOrder[]; // размещённые заказы (ждут появления в сюжете)
}

const DEFAULT_CAMERA_PROMPT =
  'semi-realistic front-camera selfie of {protagonist_name}, {user_prompt}, painterly semi-realism art style, soft cinematic lighting, natural skin texture, subtle bokeh background, shot at arm’s length on a smartphone, high detail, tasteful composition';

// Основная (задняя) камера: снимает не героя, а то, что перед ним — улицу, кофе,
// комнату. Никаких референсов и позирования; {location} и {time} подставляет движок.
const DEFAULT_REAR_CAMERA_PROMPT =
  'photo taken on a smartphone by {protagonist_name}: {user_prompt}. Location: {location}, {time}. Casual amateur phone photography, natural available light, realistic colours, slight handheld imperfection, no one posing for the camera, no selfie';

// Прежний дефолт — чтобы при загрузке старых проектов молча обновить его на новый
// (семи-реализм), не затирая пользовательские правки.
const LEGACY_CAMERA_PROMPT =
  'selfie photo of {protagonist_name}, {user_prompt}, casual phone camera quality, natural lighting';

export const DEFAULT_PRICE_GUIDE =
  'кофе ~5, обед в кафе ~15, продукты на неделю ~80, такси по городу ~20, одежда (вещь) ~50, аренда жилья в месяц ~1200, зарплата в месяц ~3000';

// Базовые категории доставки. id стабилен, name/custom редактируемы.
export function defaultDeliveryCategories(): PhoneDeliveryCategory[] {
  return [
    { id: 'food', name: 'Еда и продукты', custom: false },
    { id: 'clothing', name: 'Одежда', custom: false },
    { id: 'home', name: 'Товары для дома', custom: false },
  ];
}

export function defaultPhoneConfig(): PhoneConfig {
  return {
    enabled: false,
    showFloatingIcon: true,
    iconPosition: { x: 84, y: 62 },
    cameraPromptTemplate: DEFAULT_CAMERA_PROMPT,
    rearCameraPromptTemplate: DEFAULT_REAR_CAMERA_PROMPT,
    popupNotifications: true,
    currencyName: '$',
    priceGuide: DEFAULT_PRICE_GUIDE,
    deliveryCategories: defaultDeliveryCategories(),
    baseCatalog: [],
  };
}

export function initialPhoneState(): PhoneState {
  return {
    transactions: [],
    contacts: [],
    conversations: {},
    unreadFrom: [],
    gallery: [],
    inventory: [],
    deliveryCache: [],
    activeOrders: [],
  };
}

function normShopItem(it: any): PhoneShopItem {
  return {
    id: typeof it.id === 'string' ? it.id : `item_${Math.random().toString(36).slice(2, 8)}`,
    name: it.name,
    category: typeof it.category === 'string' ? it.category : 'Разное',
    price: typeof it.price === 'number' ? it.price : 0,
    description: typeof it.description === 'string' ? it.description : undefined,
    generated: typeof it.generated === 'boolean' ? it.generated : undefined,
    outfitTag: typeof it.outfitTag === 'string' ? it.outfitTag : undefined,
    spriteAssetId: typeof it.spriteAssetId === 'string' ? it.spriteAssetId : undefined,
  };
}

export function normalizePhoneConfig(v: unknown): PhoneConfig {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const d = defaultPhoneConfig();
  const pos = (o.iconPosition && typeof o.iconPosition === 'object' ? o.iconPosition : {}) as {
    x?: unknown;
    y?: unknown;
  };
  const catItems = Array.isArray(o.baseCatalog) ? (o.baseCatalog as any[]) : [];
  // Категории доставки: новый формат {id,name,custom}; миграция со старого
  // shopCategories: string[] → пользовательские категории.
  let deliveryCategories: PhoneDeliveryCategory[];
  if (Array.isArray(o.deliveryCategories)) {
    deliveryCategories = (o.deliveryCategories as any[])
      .filter((c) => c && typeof c.name === 'string' && c.name.trim())
      .map((c) => ({
        id: typeof c.id === 'string' ? c.id : `cat_${Math.random().toString(36).slice(2, 8)}`,
        name: c.name,
        custom: typeof c.custom === 'boolean' ? c.custom : true,
      }));
  } else if (Array.isArray(o.shopCategories)) {
    const names = (o.shopCategories as any[]).filter((x) => typeof x === 'string' && x.trim());
    deliveryCategories = names.length
      ? names.map((n: string) => ({ id: `cat_${Math.random().toString(36).slice(2, 8)}`, name: n, custom: true }))
      : d.deliveryCategories;
  } else {
    deliveryCategories = d.deliveryCategories;
  }
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : false,
    showFloatingIcon: typeof o.showFloatingIcon === 'boolean' ? o.showFloatingIcon : true,
    iconPosition: {
      x: typeof pos.x === 'number' ? Math.max(0, Math.min(100, pos.x)) : d.iconPosition.x,
      y: typeof pos.y === 'number' ? Math.max(0, Math.min(100, pos.y)) : d.iconPosition.y,
    },
    wallpaperAssetId: typeof o.wallpaperAssetId === 'string' ? o.wallpaperAssetId : undefined,
    cameraPromptTemplate:
      typeof o.cameraPromptTemplate === 'string' && o.cameraPromptTemplate.trim()
        ? o.cameraPromptTemplate.trim() === LEGACY_CAMERA_PROMPT
          ? d.cameraPromptTemplate // молча апгрейдим прежний дефолт до семи-реализма
          : o.cameraPromptTemplate
        : d.cameraPromptTemplate,
    rearCameraPromptTemplate:
      typeof o.rearCameraPromptTemplate === 'string' && o.rearCameraPromptTemplate.trim()
        ? o.rearCameraPromptTemplate
        : d.rearCameraPromptTemplate,
    popupNotifications: typeof o.popupNotifications === 'boolean' ? o.popupNotifications : true,
    currencyName: typeof o.currencyName === 'string' && o.currencyName.trim() ? o.currencyName : '$',
    priceGuide: typeof o.priceGuide === 'string' && o.priceGuide.trim() ? o.priceGuide : d.priceGuide,
    deliveryCategories,
    baseCatalog: catItems.filter((it) => it && typeof it.name === 'string').map(normShopItem),
  };
}

// Случайные события (Batch 6 §3): движок с заданной вероятностью подмешивает в ход
// скрытую директиву-событие. Конфиг в проекте; счётчик кулдауна — в RuntimeState.
export type RandomEventType =
  | 'new_npc'
  | 'new_location'
  | 'secret_reveal'
  | 'dramatic_event'
  | 'unexpected_twist';

export interface RandomEventTypeConfig {
  id: RandomEventType;
  enabled: boolean;
  weight: number; // относительная частота (0 = не выпадает)
}

export interface RandomEventConfig {
  enabled: boolean; // дефолт false
  chancePercent: number; // шанс на ход, дефолт 10
  cooldownTurns: number; // мин. ходов между событиями, дефолт 5
  canInterruptTenseScenes: boolean; // дефолт false
  types: RandomEventTypeConfig[];
}

export const RANDOM_EVENT_TYPES: RandomEventType[] = [
  'new_npc',
  'new_location',
  'secret_reveal',
  'dramatic_event',
  'unexpected_twist',
];

export const RANDOM_EVENT_LABELS: Record<RandomEventType, { ru: string; en: string }> = {
  new_npc: { ru: 'Новый персонаж', en: 'New character' },
  new_location: { ru: 'Новая локация', en: 'New location' },
  secret_reveal: { ru: 'Раскрытие секрета', en: 'Secret revealed' },
  dramatic_event: { ru: 'Драматичное событие', en: 'Dramatic event' },
  unexpected_twist: { ru: 'Неожиданный поворот', en: 'Unexpected twist' },
};

// Случайные входящие СМС (Batch 8-fix): отдельная от рандом-ивентов система — свой
// тумблер и свой шанс. Работает только при включённом телефоне и наличии контактов.
export interface RandomSmsConfig {
  enabled: boolean; // дефолт false
  chancePercent: number; // шанс на ход, дефолт 15
  cooldownTurns: number; // мин. ходов между СМС, дефолт 4
  canInterruptTenseScenes: boolean; // дефолт false
}

export function defaultRandomSms(): RandomSmsConfig {
  return { enabled: false, chancePercent: 15, cooldownTurns: 4, canInterruptTenseScenes: false };
}

export function normalizeRandomSms(v: unknown): RandomSmsConfig {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const num = (x: unknown, def: number, lo: number, hi: number) =>
    typeof x === 'number' && x >= lo && x <= hi ? x : def;
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : false,
    chancePercent: num(o.chancePercent, 15, 0, 100),
    cooldownTurns: num(o.cooldownTurns, 4, 0, 100),
    canInterruptTenseScenes: typeof o.canInterruptTenseScenes === 'boolean' ? o.canInterruptTenseScenes : false,
  };
}

export function defaultRandomEvents(): RandomEventConfig {
  return {
    enabled: false,
    chancePercent: 10,
    cooldownTurns: 5,
    canInterruptTenseScenes: false,
    types: RANDOM_EVENT_TYPES.map((id) => ({ id, enabled: true, weight: 1 })),
  };
}

export function normalizeRandomEvents(v: unknown): RandomEventConfig {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const d = defaultRandomEvents();
  const num = (x: unknown, def: number, lo: number, hi: number) =>
    typeof x === 'number' && x >= lo && x <= hi ? x : def;
  const byId = new Map<RandomEventType, RandomEventTypeConfig>();
  if (Array.isArray(o.types)) {
    for (const t of o.types as any[]) {
      if (t && RANDOM_EVENT_TYPES.includes(t.id)) {
        byId.set(t.id, {
          id: t.id,
          enabled: typeof t.enabled === 'boolean' ? t.enabled : true,
          weight: num(t.weight, 1, 0, 100),
        });
      }
    }
  }
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : false,
    chancePercent: num(o.chancePercent, 10, 0, 100),
    cooldownTurns: num(o.cooldownTurns, 5, 0, 100),
    canInterruptTenseScenes: typeof o.canInterruptTenseScenes === 'boolean' ? o.canInterruptTenseScenes : false,
    // Гарантируем все 5 типов (новые версии могут добавить) в фиксированном порядке.
    types: RANDOM_EVENT_TYPES.map((id) => byId.get(id) || d.types.find((t) => t.id === id)!),
  };
}

// Кадр картинки. Списки закрытые: это ровно то, что принимает imageConfig у Gemini
// (Nano Banana), а для остальных путей движок пересчитывает их в пиксели/подсказку.
export const IMAGE_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9'] as const;
export type ImageAspectRatio = (typeof IMAGE_ASPECT_RATIOS)[number];
export const IMAGE_SIZE_TIERS = ['1K', '2K', '4K'] as const;
export type ImageSizeTier = (typeof IMAGE_SIZE_TIERS)[number];
// 'auto' — кадр выбирает воркер: он заканчивает промпт строкой «ASPECT: 16:9».
export type ImageAspectSetting = ImageAspectRatio | 'auto';
export const IMAGE_ASPECT_LABELS: Record<ImageAspectRatio, string> = {
  '1:1': '1:1 — квадрат',
  '16:9': '16:9 — широкий (как экран игры)',
  '9:16': '9:16 — вертикальный (телефон)',
  '4:3': '4:3 — классический',
  '3:4': '3:4 — портрет',
  '3:2': '3:2 — фото',
  '2:3': '2:3 — постер',
  '21:9': '21:9 — кинематограф',
};

// CG-студия — генерация кат-сцен по текущей сцене через image-API (Nano Banana/Gemini
// или OpenAI-совместимый). Хранится в проекте: у каждой игры свой воркер-промпт,
// стиль, референсы и галерея. Ключ image-API — только в localStorage (роль 'image').
export interface ImageGenConfig {
  // Как именно шлюз рисует картинки:
  //  • gemini      — родной Google generateContent (с рефами);
  //  • openai      — /images/generations (текст→картинка, без рефов);
  //  • openai_chat — /chat/completions с картинкой в ОТВЕТЕ (OpenRouter и клоны:
  //    google/gemini-…-image, modalities:['image','text']). Рефы работают.
  providerKind: 'gemini' | 'openai' | 'openai_chat';
  baseUrl?: string; // пусто — дефолт под providerKind
  model?: string; // пусто — дефолт под providerKind
  // Кадр: соотношение сторон и разрешение (у Nano Banana это родные параметры).
  // Применяются к CG; фон движок всегда просит горизонтальным, селфи — вертикальным.
  aspectRatio?: ImageAspectSetting;
  imageSize?: ImageSizeTier;
  negativePrompt?: string; // «чего в кадре быть не должно» — уходит строкой Avoid: …
  availableModels?: string[]; // подтянутый ⟳ список моделей image-провайдера (как у основного подключения)
  systemPrompt: string; // редактируемый шаблон ВОРКЕРА: как превратить сцену в image-промпт
  style: string; // текущий стиль изображения (независим от systemPrompt)
  references: Record<string, string>; // charId → assetId рефа ВНЕШНОСТИ; нет ⇒ авто (нейтральный базовый спрайт)
  // charId → assetId рефа ОДЕЖДЫ (отдельная картинка: наряд, а не лицо). Уходит
  // вторым изображением с явной пометкой «отсюда бери только одежду». Авто нет:
  // пусто ⇒ одежду модель берёт из описания и рефа внешности.
  outfitReferences?: Record<string, string>;
  sendReferences: boolean; // отправлять ли референсы (для gemini)
  gallery: string[]; // сохранённые в галерею CG (assetId), новые в конце
}

export const DEFAULT_IMAGE_SYSTEM_PROMPT = `You turn the CURRENT visual-novel scene into ONE prompt for a text-to-image model.
Output ONLY the prompt text: a single English paragraph of 100+ words. No quotes, no headings, no markdown, no explanations.

Write it in this exact order:
1. CAMERA — shot type, angle and lens. E.g. "Medium shot, 85mm, f/2.0 shallow depth of field, slight low angle".
2. SUBJECT — who or what is in the foreground. If a character is in frame, START with their FIRST NAME exactly as given, then their appearance: hair, eyes, build, current outfit. Name EVERY character who appears; if a reference image is supplied for them, stay consistent with it.
3. POSE AND COMPOSITION — the single most important part. For EVERY person in frame describe a pose a real person could actually hold, and spell out the CONTACT POINTS that carry their weight: which foot is planted, what the hand grips or leans on, what the body rests against. Say where BOTH hands are and where the eyes look. Then place each subject in the frame (left / centre / right, foreground / behind).
4. ENVIRONMENT — location, props, background depth, time of day, weather.
5. LIGHTING AND ATMOSPHERE — the mood carried by light: golden hour, dramatic backlighting, soft diffused light, harsh contrast, practical lamps, haze, rim light.

Rules:
- Pick something worth looking at: a charged moment, a telling detail, an unusual angle — never a flat centred headshot. Let the frame tell part of the story.
- ANATOMY BEATS DRAMA. A simple, readable, physically possible pose always wins over an acrobatic one — twisted torsos, straddling in cramped spaces, arms bent behind bodies and floating limbs come out mangled. If the moment is physically awkward to draw, choose a tighter crop (hands, faces, shoulders) or a calmer instant just before or after it.
- Keep at most THREE people in frame. Crop the rest out or leave them off-screen; crowds turn into deformed faces.
- In cramped settings (car interior, doorway, stairwell, bed) state explicitly how the bodies fit: who sits, who leans, what their knees and elbows touch.
- Reference images define a character's FACE, HAIR and OUTFIT only. Never copy the pose or framing of a reference — build the pose from this description.
- No nudity and no explicit private parts — suggestion, framing and cropping instead.
- Do NOT name an art style or medium — the style line is appended separately by the engine.
- On the LAST line, alone, state the frame you want: "ASPECT: 16:9". Allowed: 1:1, 2:3, 3:2, 3:4, 4:3, 9:16, 16:9, 21:9. Wide for landscapes, interiors and group scenes; tall for portraits and single figures. The engine uses this only when the aspect ratio is set to "auto".`;

// Стиль по умолчанию — дописывается к промпту воркера отдельной строкой.
// Ориентир — кат-сцены романтических новелл: полуреализм с живыми цветами,
// правильная анатомия, аккуратная живописная отделка (не аниме-плоскость).
export const DEFAULT_IMAGE_STYLE =
  'masterpiece, best quality, 8k, semi-realistic digital painting in the style of a modern romance visual novel cut-scene, realistic human proportions and anatomy, lifelike faces with subtle expressions, rich saturated colors, warm natural skin tones, soft volumetric cinematic lighting, glossy polished rendering with fine painterly detail, shallow depth of field';

// Чего в кадре быть НЕ должно. Отдельным полем: у Gemini и роутеров нет параметра
// negative prompt, поэтому движок дописывает это строкой «Avoid: …» — модели
// такую формулировку понимают, а пользователь может править список под себя.
export const DEFAULT_IMAGE_NEGATIVE =
  'distorted anatomy, deformed or fused hands, extra fingers, extra limbs, broken joints, twisted spine, impossible or contorted pose, floating limbs, disproportionate body, stiff mannequin posing, melted faces, duplicated characters, cluttered composition, blurry, lowres, watermark, text, signature';

// Обрывок ПРЕЖНЕГО дефолтного воркер-промпта: если в проекте лежит он (значит,
// пользователь его не правил) — подменяем на актуальный, как с блоками пресета.
const OUTDATED_IMAGE_PROMPT_MARK = 'Do NOT add an art-style tag';
// То же для стиля: прежний дефолт (аниме-полуреализм) → новый, реалистичнее.
const OUTDATED_IMAGE_STYLE_MARK = 'semi realism anime inspired style';

export function defaultImageGenConfig(): ImageGenConfig {
  return {
    providerKind: 'gemini',
    aspectRatio: 'auto',
    imageSize: '2K',
    systemPrompt: DEFAULT_IMAGE_SYSTEM_PROMPT,
    style: DEFAULT_IMAGE_STYLE,
    negativePrompt: DEFAULT_IMAGE_NEGATIVE,
    references: {},
    outfitReferences: {},
    sendReferences: true,
    gallery: [],
  };
}

// Санитизация ImageGenConfig (импорт/старые проекты) → полная конфигурация.
export function normalizeImageGen(v: unknown): ImageGenConfig {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const d = defaultImageGenConfig();
  const pickRefs = (v: unknown): Record<string, string> => {
    const out: Record<string, string> = {};
    if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (typeof val === 'string' && val) out[k] = val;
      }
    }
    return out;
  };
  const refs = pickRefs(o.references);
  return {
    providerKind:
      o.providerKind === 'openai' ? 'openai' : o.providerKind === 'openai_chat' ? 'openai_chat' : 'gemini',
    baseUrl: typeof o.baseUrl === 'string' && o.baseUrl.trim() ? o.baseUrl.trim() : undefined,
    model: typeof o.model === 'string' && o.model.trim() ? o.model.trim() : undefined,
    availableModels: Array.isArray(o.availableModels)
      ? o.availableModels.filter((x): x is string => typeof x === 'string' && !!x)
      : undefined,
    aspectRatio:
      o.aspectRatio === 'auto' || (IMAGE_ASPECT_RATIOS as readonly string[]).includes(o.aspectRatio as string)
        ? (o.aspectRatio as ImageAspectSetting)
        : d.aspectRatio,
    imageSize: (IMAGE_SIZE_TIERS as readonly string[]).includes(o.imageSize as string)
      ? (o.imageSize as ImageSizeTier)
      : d.imageSize,
    // Лежит прежний дефолтный воркер-промпт (значит, его не правили) → обновляем.
    systemPrompt:
      typeof o.systemPrompt === 'string' &&
      o.systemPrompt.trim() &&
      !o.systemPrompt.includes(OUTDATED_IMAGE_PROMPT_MARK)
        ? o.systemPrompt
        : d.systemPrompt,
    // Пустой стиль неотличим от «ни разу не задавали» — подставляем дефолтный.
    // Прежний дефолтный стиль (аниме-полуреализм) обновляем на актуальный.
    style:
      typeof o.style === 'string' && o.style.trim() && !o.style.includes(OUTDATED_IMAGE_STYLE_MARK)
        ? o.style
        : d.style,
    negativePrompt:
      typeof o.negativePrompt === 'string' && o.negativePrompt.trim() ? o.negativePrompt : d.negativePrompt,
    references: refs,
    outfitReferences: pickRefs(o.outfitReferences),
    sendReferences: typeof o.sendReferences === 'boolean' ? o.sendReferences : true,
    gallery: Array.isArray(o.gallery) ? o.gallery.filter((x): x is string => typeof x === 'string') : [],
  };
}

// Пер-проектное оформление ЭКРАНА ИГРЫ (мини-мастерская в бургер-меню плеера).
// Хранится в проекте → едет с ним при копировании/экспорте/шаринге. Влияет только
// на плеер (CSS-переменные корня плеера), не на конструктор/библиотеку.
export interface PlayerTheme {
  accent: string; // hex акцент (тег имени, кнопка отправки, подсветки)
  // «Окна/панели»: пузырь реплики, панель ввода, плашки HUD (календарь+статы).
  bubbleColor: string;
  bubbleOpacity: number; // 0..1
  // Обычные кнопки выбора.
  choiceColor: string;
  choiceOpacity: number; // 0..1
  // Премиум-выборы (стоят очков стата).
  premiumColor: string;
  premiumOpacity: number; // 0..1
  // Цвета текста.
  textColor: string; // основной текст реплики
  nameColor: string; // имя говорящего (тег-заголовок)
  quoteColor: string; // прямая речь в кавычках
  italicColor: string; // курсив (действия/мысли)
  calendarColor: string; // текст плашки календаря/локации
  fontUrl: string; // ссылка на таблицу стилей шрифта (Google Fonts и т.п.), опц.
  fontFamily: string; // CSS font-family, опц.
  fontScale: number; // множитель размера читаемого текста (0.8–1.6)
  nameScale: number; // множитель размера имени говорящего (0.8–1.6)
  spriteScale: number; // множитель размера спрайта персонажа (0.5–1.6)
  spriteOffsetX: number; // смещение спрайта по X, % (влево−/вправо+)
  spriteOffsetY: number; // смещение спрайта по Y, % (вниз−/вверх+)
}

export const DEFAULT_PLAYER_THEME: PlayerTheme = {
  accent: '#b18cff',
  bubbleColor: '#100d18',
  bubbleOpacity: 0.72,
  choiceColor: '#100d18',
  choiceOpacity: 0.72,
  premiumColor: '#f59e0b',
  premiumOpacity: 0.22,
  textColor: '#f0ecfa',
  nameColor: '#1c1526',
  quoteColor: '#f0ecfa',
  italicColor: '#f0ecfa',
  calendarColor: '#eae6f7',
  fontUrl: '',
  fontFamily: '',
  fontScale: 1,
  nameScale: 1,
  spriteScale: 1,
  spriteOffsetX: 0,
  spriteOffsetY: 0,
};

// Санитизация частичной/битой темы (импорт проекта, старый глобальный конфиг) → полная.
export function normalizePlayerTheme(p: unknown): PlayerTheme {
  const o = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
  const numIn = (v: unknown, def: number, lo: number, hi: number) =>
    typeof v === 'number' && v >= lo && v <= hi ? v : def;
  const D = DEFAULT_PLAYER_THEME;
  const strOr = (v: unknown, def: string) => (typeof v === 'string' ? v : def);
  return {
    accent: strOr(o.accent, D.accent),
    bubbleColor: strOr(o.bubbleColor, D.bubbleColor),
    bubbleOpacity: numIn(o.bubbleOpacity, D.bubbleOpacity, 0, 1),
    choiceColor: strOr(o.choiceColor, D.choiceColor),
    choiceOpacity: numIn(o.choiceOpacity, D.choiceOpacity, 0, 1),
    premiumColor: strOr(o.premiumColor, D.premiumColor),
    premiumOpacity: numIn(o.premiumOpacity, D.premiumOpacity, 0, 1),
    textColor: strOr(o.textColor, D.textColor),
    nameColor: strOr(o.nameColor, D.nameColor),
    quoteColor: strOr(o.quoteColor, D.quoteColor),
    italicColor: strOr(o.italicColor, D.italicColor),
    calendarColor: strOr(o.calendarColor, D.calendarColor),
    fontUrl: strOr(o.fontUrl, ''),
    fontFamily: strOr(o.fontFamily, ''),
    fontScale: numIn(o.fontScale, 1, 0.6, 2),
    nameScale: numIn(o.nameScale, 1, 0.6, 2),
    spriteScale: numIn(o.spriteScale, 1, 0.3, 2),
    spriteOffsetX: numIn(o.spriteOffsetX, 0, -100, 100),
    spriteOffsetY: numIn(o.spriteOffsetY, 0, -100, 100),
  };
}

// ---- Runtime / AI response types (JSON-контракт с ИИ) ----

// bg — динамическая смена фона на этом бите (id ассета-фона), как emotion у реплик.
// ИИ ставит его на бите, где меняется место/обстановка; движок при сборке хода
// «протягивает» эффективный фон вперёд, поэтому у каждого бита bg заполнен.
// bg/mood — эффективные фон/муз-настроение на момент бита (движок протягивает их
// вперёд, в т.ч. от управляющих битов scene_change). scene_change/outfit_change —
// УПРАВЛЯЮЩИЕ биты (Batch 6 §1): текста не несут, движок применяет их как команду
// смены визуального состояния в точке появления в потоке.
export type Beat =
  | { type: 'narration'; text: string; bg?: string; mood?: string }
  | { type: 'thought'; text: string; bg?: string; mood?: string }
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
      mood?: string;
    }
  | { type: 'scene_change'; bg?: string; musicMood?: string } // смена фона/музыки в потоке
  | { type: 'outfit_change'; characterId: string; outfit: string } // переодевание персонажа
  // Телефон (Batch 7 §7.2) — управляющие биты состояния телефона (не отображают текст).
  // transaction (ревизия блока 6): траты/поступления из повествования с деталями
  // выписки (где, что, когда). money_change — легаси-синоним (amount + reason).
  | { type: 'transaction'; amount: number; vendor?: string; item?: string; time?: string }
  | { type: 'money_change'; amount: number; reason?: string }
  | { type: 'sms_incoming'; characterId: string; text: string }
  | { type: 'contact_added'; characterId: string }
  // Симулятор жизни (Batch 8): продвижение времени и инвентарь. Все — управляющие.
  | { type: 'time_advance'; newDate?: string; newTime?: string }
  | { type: 'inventory_add'; name: string; emoji?: string; quantity?: number; category?: string; source?: string }
  | { type: 'inventory_remove'; name: string; quantity?: number; reason?: string }
  // Реестр персонажей (patch character-registry) — идентичность по id, не по имени.
  | { type: 'character_new'; id?: string; canonicalName: string; aliases?: string[]; role?: CharacterRole }
  | { type: 'character_alias_add'; id: string; alias: string }
  | { type: 'character_update'; id: string; status?: string; canonicalName?: string; sheetPatch?: Record<string, string> };

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
  chronicle: ChronicleEntry[]; // ЖУРНАЛ ЭПИЗОДОВ: хронологические свёртки «что произошло» (append-only, редактируемые)
  // ЖИВОЙ СНАПШОТ СОСТОЯНИЯ: одно эволюционирующее структурированное саммари
  // (персонажи/отношения/крючки/текущее положение). Заменяется при каждой свёртке.
  storyState?: string;
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
  lastSeenDate?: string; // когда протагонист виделся с ним в последний раз (ДД/ММ/ГГГГ, Batch 8)
}

export interface GmRelationEdge {
  from: string; // имя персонажа
  to: string;
  label: string; // характер связи между персонажами
}

// Реестр персонажей (patch character-registry) — единый источник правды «кто есть кто».
// Один персонаж = одна запись = один стабильный id (совпадает с id персонажа проекта,
// если он есть). Все ссылки (анкета, контакт, статы) идут на id, а не на имя.
export interface CharacterStatusLog {
  status: string;
  date?: string; // ДД/ММ/ГГГГ
}
export interface CharacterRegistryEntry {
  id: string; // стабильный, не меняется
  canonicalName: string;
  aliases: string[]; // как его называют
  role: CharacterRole;
  status: string; // краткий текущий статус
  statusLog?: CharacterStatusLog[]; // история смен статуса
  firstSeenDate?: string;
  lastSeenDate?: string;
  sheetId?: string; // id персонажа проекта (анкета), если создан
  contactId?: string; // id контакта в телефоне (= id персонажа), если есть
  merged?: string[]; // id поглощённых дублей
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
  // Каноническая дата — строго "ДД/ММ/ГГГГ" (Batch 8, Часть II). Источник правды для
  // финансов/времени. day/month/year остаются для легаси-отображения (фэнтези-месяцы).
  date?: string;
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
  registry?: CharacterRegistryEntry[]; // реестр персонажей (patch character-registry)
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
    registry: [],
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
  // Ходов с последнего случайного события (Batch 6 §3) — для кулдауна. В сейве.
  turnsSinceLastEvent?: number;
  // Ходов с последнего случайного СМС (Batch 8-fix) — отдельный кулдаун. В сейве.
  turnsSinceLastSms?: number;
  // Состояние телефона (Batch 7) — контакты, переписки, транзакции, инвентарь. В сейве.
  phone?: PhoneState;
  // Инвентарь протагониста (Batch 8 §IV) — не в телефоне: работает и без него. В сейве.
  inventory?: InventoryItem[];
}

export interface AuthorNote {
  id: string;
  text: string;
}

// Batch 5.2 — уровни сущностей сейвов:
//  • Прохождение (playthrough) — независимый заход в историю. У него ровно один
//    автосейв-курсор (kind:'autosave', перезаписывается) и любое число чекпоинтов.
//  • Автосейв-курсор — непрерывное «последнее состояние» внутри прохождения (для «Продолжить»).
//  • Автоснимок (kind:'autosnap') — кольцо последних N автосейвов (история для отката,
//    если прогресс слетел). Пишутся каждый ход рядом с курсором, старые вытесняются.
//  • Чекпоинт (kind:'checkpoint') — РУЧНАЯ точка-ветка (полная копия истории до неё).
// Всё хранится теми же durable-сейвами (IndexedDB + диск). Старые сейвы без этих
// полей попадают в бакет прохождения 'legacy' (kind по умолчанию — autosave).
export type SaveKind = 'autosave' | 'checkpoint' | 'autosnap';

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
