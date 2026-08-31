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
  // ЛИЧНАЯ подгонка спрайта на сцене: рисовки приходят в разном масштабе и с
  // разным полем вокруг фигуры, и общей настройки оформления на всех не хватает —
  // подогнал одного, разъехались остальные. Множится с общей: итог = общее ×
  // личное. Пусто ⇒ персонаж рисуется ровно по общим настройкам.
  spriteDisplay?: SpriteDisplay;
  relationship: RelationshipStats; // стартовые значения (правятся в конструкторе)
  relationshipHidden?: boolean; // скрыть в инфобоксе
  /** @deprecated Связь стат↔персонаж переехала на StatDefinition.linkedCharacterId
   * (чтобы к одному персонажу можно было привязать несколько статов). Поле читается
   * только для миграции старых проектов. */
  linkedStatId?: string;
  importedFrom?: 'tavern_v2' | 'tavern_v3' | 'manual' | 'promoted_npc' | 'scanned_contact' | 'gm_sheet';
  sourceSystemPrompt?: string; // из карточки, НЕ применять авто
}

// Личная подгонка спрайта персонажа. scale — множитель к общему (1 = как у всех),
// offsetX/offsetY — добавка к общему смещению в процентах (Y: вверх положительный).
export interface SpriteDisplay {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export const DEFAULT_SPRITE_DISPLAY: SpriteDisplay = { scale: 1, offsetX: 0, offsetY: 0 };

/** Личная подгонка спрайта или дефолт. Одна точка чтения — и в игре, и в редакторе. */
export function spriteDisplayOf(c: { spriteDisplay?: SpriteDisplay } | undefined): SpriteDisplay {
  const d = c?.spriteDisplay;
  if (!d) return DEFAULT_SPRITE_DISPLAY;
  return {
    scale: Number.isFinite(d.scale) ? d.scale : 1,
    offsetX: Number.isFinite(d.offsetX) ? d.offsetX : 0,
    offsetY: Number.isFinite(d.offsetY) ? d.offsetY : 0,
  };
}

/** Настройка «как у всех» — такую не храним, чтобы не плодить пустые записи. */
export function isDefaultSpriteDisplay(d: SpriteDisplay): boolean {
  return d.scale === 1 && d.offsetX === 0 && d.offsetY === 0;
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
  // В каком режиме вставлять. Пусто — в обоих (так вели себя все блоки раньше).
  // Разделение нужно потому, что блок, написанный под новеллу (биты, спрайты,
  // выборы), в текстовом РП тянет ответ обратно к формату новеллы — и наоборот.
  mode?: NarrativeMode;
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
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'max';
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
  // Потолок ответа свёртки в токенах. Двухсекционный ответ (журнал + снапшот
  // состояния) объёмный: на 3000 снапшот обрывался на середине. undefined = дефолт.
  summaryMaxTokens?: number;
  minorEventsLimit?: number; // лимит MINOR EVENTS в саммари (Batch 6 §2), дефолт 10
  vectorization: VectorizationMode;
  embeddingsConnection?: ApiConnection; // для 'custom'
}

export function defaultMemoryConfig(): MemoryConfig {
  return { summaryEveryN: 30, minorEventsLimit: 10, vectorization: 'off', summaryMaxTokens: 8000 };
}

// Длина хода (слов). Ползунок/ввод ограничены этими границами; дефолт совпадает с
// длинными ходами по умолчанию.
export const TURN_LENGTH_BOUNDS = { min: 100, max: 4000 } as const;
export const DEFAULT_TURN_LENGTH = { min: 500, max: 900 };

// Готовые размеры ответа — от короткой реплики до полотна. Ползунки никуда не
// делись: пресеты просто ставят в них осмысленные пары, потому что «сколько слов»
// — вопрос, на который проще ответить примером, чем числом.
export const TURN_LENGTH_PRESETS: { id: string; name: string; hint: string; min: number; max: number }[] = [
  { id: 'short', name: 'Короткий', hint: 'реплика-другая, быстрый пинг-понг', min: 120, max: 300 },
  { id: 'medium', name: 'Средний', hint: 'сцена в пару абзацев', min: 300, max: 600 },
  { id: 'long', name: 'Длинный', hint: 'полноценная сцена — по умолчанию', min: 500, max: 900 },
  { id: 'huge', name: 'Очень длинный', hint: 'глава целиком', min: 900, max: 1600 },
  { id: 'canvas', name: 'Полотно', hint: 'много прозы и диалогов за один ход', min: 1600, max: 3000 },
];
// ЧЕК-ЛИСТ ХОДА (управляемое размышление). Это не «план сцены», а РАЗБОР ПО ШАГАМ:
// половина пунктов здесь — проверки против конкретных известных поломок, а не
// творческое планирование.
//
// Почему он длинный, хотя каждая строка оплачивается на каждом ходу. Правила в
// пресете модель читает — и всё равно нарушает, причём предсказуемо и всегда одни
// и те же: персонаж действует по факту, которого ему никто не говорил; ответ
// открывается пересказом хода игрока; удачная фраза из прошлого хода едет в
// следующий. Это не «недостаточно строгие формулировки», а слепые зоны: изнутри
// генерации модель их не видит. Единственное, что реально помогает, — заставить
// её ВЫПИСАТЬ проверку явно, до текста: выписанное «Марк не знает про письмо»
// меняет ход, прочитанное «соблюдай информационную гигиену» — нет.
//
// Список закрытый и упорядоченный: сначала обстановка, потом информационная
// гигиена, потом повторы, потом сам ход и формат. Пункт, ответ на который «чисто»,
// стоит две-три токена — платим мы за те, где ответ другой.
export const DEFAULT_THINKING_PLAN = `1. SCENE: where, when, who is physically present, what each is doing and wearing — carried over from last turn; name only what CHANGES now. (1 line)
2. WANTS: what does each present character want in this exact moment, and what are they covering up? (1 line)
3. PUBLIC vs PRIVATE: what did the hero's move actually make visible or audible to the others? Their private reasoning is not perceivable — nobody reacts to it. (1 line)
4. WHO KNOWS WHAT: for every character about to speak or act, name the fact they are about to use and WHERE THEY GOT IT — saw it themselves / were told it in a played scene / it is in their dossier or tags / common knowledge. Anything not on that list they DO NOT KNOW: say so and change what they do. (1-2 lines)
5. MY LAST REPLY: name 2-3 exact phrases or images I used last turn, and how it was built (what opened it, what closed it). They are BANNED for this turn. (1 line)
6. ECHO: does my planned opening retell, paraphrase or mirror the hero's move? If yes, move the opening to where the world ANSWERS. (1 line)
7. BAN LIST: is anything from the banned words and phrases about to slip in? Name it and what replaces it, or "clean". (1 line)
8. FRICTION: who here does NOT simply go along with the hero right now, and why? ("nobody, and here is why that is earned" is a valid answer — but it has to be earned.) (1 line)
9. THE TURN: the first beat, the turn it takes, where it stops. (1-2 lines)
10. STATE: any stat or relationship change this turn? (1 line, or "none")
11. CHOICE: is this a real fork? (only at a real fork, else "no")
12. FORMAT: one JSON object per the schema, every dialogue beat carrying the speaker's characterId, nothing outside the JSON. ("ok", or name what you are fixing.)`;

// РП-вариант того же чек-листа. Отличия не косметические:
//  — нет пунктов про статы и выбор: в РП нет ни JSON-статов, ни кнопок, и строка
//    «Offer a choice?» в плане была ровно тем, из-за чего модель начинала
//    предлагать выбор в конце обычной прозы — мысль просачивалась из скрытого
//    плана в видимый текст;
//  — пункт 3 разделяет сказанное вслух и подуманное: ход игрока приходит его
//    собственным текстом, где курсив = невысказанная мысль, и слышать её никто
//    не может;
//  — пункт формата проверяет кавычки и второе лицо, а не JSON.
export const DEFAULT_RP_THINKING_PLAN = `1. SCENE: where, when, who is physically here, what each is doing and wearing — carried over from last turn; name only what CHANGES now. (1 line)
2. WANTS: what does each present character want in this exact moment, and what are they covering up? (1 line)
3. SAID vs THOUGHT: what did {{user}} actually say or do OUT LOUD this turn, and what was only a thought or an unstated intention? Thoughts are NOT audible — nobody may react to them. (1 line)
4. WHO KNOWS WHAT: for every character about to speak or act, name the fact they are about to use and WHERE THEY GOT IT — saw it themselves / were told it in a played scene / it is in their tags / common knowledge. Anything not on that list they DO NOT KNOW: say so and change what they do. (1-2 lines)
5. MY LAST REPLY: name 2-3 exact phrases or images I used last turn, and how it was built (what opened it, what closed it). They are BANNED for this turn. (1 line)
6. ECHO: does my planned opening retell, paraphrase or mirror {{user}}'s move? If yes, move the opening to where the world ANSWERS. (1 line)
7. BAN LIST: is anything from the banned words and phrases about to slip in? Name it and what replaces it, or "clean". (1 line)
8. FRICTION: who here does NOT simply go along with {{user}} right now, and why? ("nobody, and here is why that is earned" is a valid answer — but it has to be earned.) (1 line)
9. THE TURN: the first beat, the turn it takes, and where it STOPS — and it stops where it is {{user}}'s move. (1-2 lines)
10. FORMAT: speech in one kind of quotation marks, a quote inside speech in 'single' ones, {{user}} in the second person, italics only for an unspoken thought, no dash opening a line of speech, nothing written for {{user}}. ("ok", or name what you are fixing.)`;

// СТОП-СЛОВА по умолчанию. Не «плохие слова», а обороты, которые модели тянут в
// каждый второй ход независимо от сцены: они не режут глаз поодиночке, но на
// двадцатом ходу читаются как подпись генератора. Список правится и чистится в
// панели пресета; пустой — блок вообще не уходит в запрос.
export const DEFAULT_BAN_WORDS = `воздух загустел / сгустился, повисла тишина, что-то неуловимо изменилось, по спине пробежал холодок, сердце пропустило удар, затаив дыхание, многозначительная пауза, взгляд задержался на мгновение дольше положенного, уголок губ дрогнул, он не мог не заметить
the air thickened, a shiver ran down their spine, their breath hitched, silence hung between them, something shifted imperceptibly, a beat of silence, the corner of their mouth twitched, they couldn't help but notice, little did they know, a mixture of X and Y`;

// Прежние дефолты плана. Если у проекта лежит ровно такой текст — автор его не
// правил, просто он сохранился при первом открытии панели, и его надо обновить.
// Отредактированный вручную план не трогаем никогда.
export const LEGACY_THINKING_PLANS = [
  // Чек-листы до пошагового разбора: информационная гигиена была ОДНОЙ строкой
  // «is anyone about to act on something they were never told?», и модель отвечала
  // на неё «clean», ничего не проверив — проверять было нечего, вопрос не просил
  // назвать ни факт, ни его источник.
  `- Scene: where we are, who is actually here, what each of them wants, what they are wearing — carried over from last turn; name only what CHANGES now (1 line)
- Focus: what shifts this turn — does the story move, or circle what already happened? (1 line)
- Friction: who here does NOT simply go along with the hero right now, and why? (1 line, or "nobody, and here is why that is earned")
- Who knows what: is anyone about to act on something they were never told? (1 line, or "clean")
- Tone: does the mood of the scene turn this turn? (1 line, or "same")
- Any stat/relationship change? (1 line, or "none")
- Offer a choice? (only at a real fork, else "no")`,
  `- Scene: where we are, who is actually here, what each of them wants, what they are wearing — carried over from last turn; name only what CHANGES now (1 line)
- Focus: what shifts this turn — does the story move, or circle what already happened? (1 line)
- Friction: who here does NOT simply go along with {{user}} right now, and why? (1 line, or "nobody, and here is why that is earned")
- Who knows what: is anyone about to act on something they were never told? (1 line, or "clean")
- Tone: does the mood of the scene turn this turn? (1 line, or "same")`,
  `- Last turn, mine: name 2–3 exact phrases/images I used, and how it was built (what opened it, what closed it). These are now BANNED for this turn.
- Opening: what happens FIRST that {{user}} does not already know? (never a retelling of their move)
- Shape: how is this turn built differently from the last one? (1 line)
- Who acts: who moves or speaks on their own initiative this turn, and what do they want? (1 line)
- Friction: who here does not simply go along with {{user}}, and why? (1 line, or "nobody, and here is why that is earned")`,
  `- Scene: where we are, who is actually here, what each of them wants, what they are wearing — carried over from last turn; name only what CHANGES now (1 line)
- Focus: what shifts this turn — does the story move, or circle what already happened? (1 line)
- Who knows what: is anyone about to act on something they were never told? (1 line, or "clean")
- Tone: does the mood of the scene turn this turn? (1 line, or "same")
- Any stat/relationship change? (1 line, or "none")
- Offer a choice? (only at a real fork, else "no")`,
  `- Focus: what shifts this turn (1 line)
- Present & what each wants (1 line)
- Who knows what: is anyone about to act on something they were never told? (1 line, or "clean")
- Any stat/relationship change? (1 line, or "none")
- Offer a choice? (only at a real fork, else "no")`,
  `- Focus: what shifts this turn (1 line)
- Present & what each wants (1 line)
- Any stat/relationship change? (1 line, or "none")
- Offer a choice? (only at a real fork, else "no")`,
];

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

// РЕЖИМ ПОВЕСТВОВАНИЯ. 'vn' — визуальная новелла: ход приходит структурированным
// JSON (биты, спрайты, выборы). 'rp' — классический текстовый ролеплей в духе
// Таверны: модель пишет обычную прозу, движок ничего не разбирает по схеме, а
// состояние мира (Game Master) при желании едет отдельным служебным блоком.
// Всё остальное — сеттинг, персонажи, лорбук, память, свёртка — общее для обоих.
export type NarrativeMode = 'vn' | 'rp';

export const DEFAULT_NARRATIVE_MODE: NarrativeMode = 'vn';

export function normalizeNarrativeMode(v: unknown): NarrativeMode {
  return v === 'rp' ? 'rp' : 'vn';
}

// Пользовательский макрос проекта. name — без фигурных скобок, только буквы, цифры,
// точка и дефис (иначе он не отличим от служебных вставок и ломает разбор).
export interface ProjectMacro {
  name: string;
  value: string;
}

export interface Project {
  id: string;
  createdAt: number;
  updatedAt: number;
  meta: ProjectMeta;
  // Режим повествования: новелла (по умолчанию) или текстовый ролеплей. Поле
  // опциональное — у всех проектов, созданных до режимов, его нет, и они читаются
  // как 'vn' без миграции.
  mode?: NarrativeMode;
  lore: Lore;
  lorebook: LorebookEntry[]; // статичный мир (см. CR v2 §E1) — Меморибук отдельно, в RuntimeState.memory
  characters: Character[];
  stats: StatDefinition[];
  assets: AssetMeta[];
  aiConfig: AiConfig;
  memoryConfig: MemoryConfig;
  audioMoods: string[]; // кастомные настроения сверх базовых 8 (см. CR v2 §N.2)
  // Свои макросы проекта: {{имя}} → произвольный текст. Раскрываются перед
  // встроенными, поэтому внутри значения можно пользоваться {{user}} и остальными.
  macros?: ProjectMacro[];
  // Переписка с ассистентом-соавтором. Живёт в проекте, а не рядом: разговор про
  // ЭТОТ сеттинг бессмыслен в отрыве от него и должен ехать вместе при экспорте.
  // Хранится как есть, включая записи о применённых правках и их откате.
  assistantChat?: unknown[];
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

export interface PhoneConfig {
  enabled: boolean;
  showFloatingIcon: boolean;
  iconPosition: { x: number; y: number }; // проценты 0..100 от экрана
  wallpaperAssetId?: string;
  heroAvatarAssetId?: string; // аватарка самого героя в мессенджере
  cameraPromptTemplate: string; // фронталка (селфи героя)
  rearCameraPromptTemplate: string; // основная камера: снимок того, что вокруг
  popupNotifications: boolean;
  currencyName: string; // «$», «кредиты» и т.п.
  priceGuide: string; // ориентиры цен сеттинга (уходят в контекст ИИ)
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
// Контакт телефона (Телефон 2.0). Раньше это была лишь ссылка на персонажа проекта,
// поэтому «создать контакт как в настоящем телефоне» было невозможно. Теперь у
// контакта своё имя и аватар, а привязка к персонажу — необязательная: можно
// связать с персонажем проекта ИЛИ с тем, кого задетектил Game Master (реестр).
export interface PhoneContact {
  id: string; // собственный id контакта (для новых); у мигрированных = characterId
  characterId?: string; // привязка к персонажу проекта (если есть карточка)
  registryId?: string; // привязка к записи реестра Game Master (персонаж без карточки)
  name?: string; // отображаемое имя; пусто → имя персонажа
  avatarAssetId?: string; // своя аватарка; пусто → спрайт персонажа или буква
  // Кто это и как себя ведёт — своими словами. Нужно тем, у кого нет карточки
  // персонажа (мама, папа, коллега): без этого бот отвечал «никем».
  note?: string;
  // Насколько охотно болтает в групповых чатах и пишет первым: 0 — молчун,
  // 100 — трещотка. Уходит в промпт, решение об ответе принимает ИИ по контексту.
  chattiness?: number;
  hidden?: boolean;
}

export interface PhoneMessage {
  id?: string; // для удаления конкретного сообщения
  // Кто отправил: герой или контакт. В группах отправитель уточняется в senderId.
  from: 'protagonist' | 'contact';
  senderId?: string; // id контакта-отправителя (группы; в личке = собеседник)
  text: string;
  attachedAssetId?: string;
  // Фото, которое отправляет бот: сперва приходит только промпт (сообщение видно
  // сразу, с плашкой «загружается»), картинка подставляется после генерации.
  photoPrompt?: string;
  pendingPhoto?: boolean;
  photoFailed?: boolean;
  at: number; // реальное время (для сортировки в UI)
  // ВНУТРИИГРОВОЕ время сообщения и ход, на котором оно отправлено. Без них
  // переписка висела вне хронологии истории: в сюжете 2029 год, а сообщения
  // помечены только реальным Date.now(). Модель не могла понять, было это
  // сегодня утром или три года назад, и телефон жил отдельной жизнью.
  storyDate?: string; // ДД/ММ/ГГГГ на момент отправки
  storyTime?: string; // ЧЧ:ММ
  turn?: number; // ход истории, на котором отправлено
}

// Чат: личный (один собеседник) или групповой (несколько + название и фото).
export interface PhoneChat {
  id: string;
  kind: 'direct' | 'group';
  title?: string; // название группы; для личного — пусто (берётся имя контакта)
  avatarAssetId?: string; // фото группы
  participantIds: string[]; // id контактов (без героя — он всегда участник)
  messages: PhoneMessage[];
  unread?: boolean;
  // Групповой тонус: как часто участники пишут сами по себе, 0..100.
  groupActivity?: number;
  // Заметка автора для этой группы: о чём чат, как себя ведут (уходит в промпт).
  topic?: string;
  // Чат удалён из мессенджера, но переписка сохранена: в списке его нет, а в
  // контексте истории он остаётся (выбор «удалить, но чтобы помнили»).
  archived?: boolean;
}
export interface PhoneState {
  transactions: PhoneTransaction[];
  contacts: PhoneContact[];
  // Чаты (Телефон 2.0). Личные и групповые в одном списке.
  chats: PhoneChat[];
  // Непрочитанное — флаг на самом чате. Отдельного списка контактов с
  // непрочитанным больше нет: групповой чат он выразить не мог, а два
  // параллельных механизма приходилось синхронизировать в каждой точке записи.
  gallery: string[]; // assetId сгенерированных фото
  // Инвентаря здесь БОЛЬШЕ НЕТ. Он остался от интернет-магазина и был вторым
  // списком вещей рядом с настоящим (RuntimeState.inventory) — ровно тот случай,
  // когда одна и та же правда лежит в двух местах. Старые сейвы переносятся
  // в нормальный инвентарь при загрузке (см. normalizeRuntimeState).
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
  };
}

export function initialPhoneState(): PhoneState {
  return {
    transactions: [],
    contacts: [],
    chats: [],
    gallery: [],
  };
}

// Имя контакта: своё → имя персонажа проекта → имя из реестра GM → id.
export function contactDisplayName(
  contact: PhoneContact,
  lookup: { characterName?: (id: string) => string | undefined; registryName?: (id: string) => string | undefined }
): string {
  if (contact.name?.trim()) return contact.name.trim();
  if (contact.characterId) {
    const n = lookup.characterName?.(contact.characterId);
    if (n) return n;
  }
  if (contact.registryId) {
    const n = lookup.registryName?.(contact.registryId);
    if (n) return n;
  }
  return contact.id;
}

export function normalizePhoneConfig(v: unknown): PhoneConfig {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const d = defaultPhoneConfig();
  const pos = (o.iconPosition && typeof o.iconPosition === 'object' ? o.iconPosition : {}) as {
    x?: unknown;
    y?: unknown;
  };
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : false,
    showFloatingIcon: typeof o.showFloatingIcon === 'boolean' ? o.showFloatingIcon : true,
    iconPosition: {
      x: typeof pos.x === 'number' ? Math.max(0, Math.min(100, pos.x)) : d.iconPosition.x,
      y: typeof pos.y === 'number' ? Math.max(0, Math.min(100, pos.y)) : d.iconPosition.y,
    },
    wallpaperAssetId: typeof o.wallpaperAssetId === 'string' ? o.wallpaperAssetId : undefined,
    // Аватарку героя нормализатор раньше не переносил — а он прогоняется при КАЖДОЙ
    // загрузке проекта, так что поставленная аватарка жила ровно до перезагрузки.
    heroAvatarAssetId: typeof o.heroAvatarAssetId === 'string' ? o.heroAvatarAssetId : undefined,
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
- Not everyone listed as available is in this shot. Include ONLY the people the moment is actually about; a character who is merely somewhere nearby must be left out of both the description and the cast line.

FINISH with two control lines, each alone on its own line:
CAST: <first names of the people visible in the image, comma-separated — or NONE for a shot without people>
ASPECT: <1:1 | 2:3 | 3:2 | 3:4 | 4:3 | 9:16 | 16:9 | 21:9>
CAST decides whose reference photos get attached, so never name someone who is not in the frame. Wide ratios suit landscapes, interiors and group scenes; tall ones suit portraits and single figures.`;

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
const OUTDATED_IMAGE_PROMPT_MARKS = [
  'Do NOT add an art-style tag', // самый первый дефолт
  'The engine uses this only when the aspect ratio is set to "auto"', // дефолт без строки CAST
];
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
      !OUTDATED_IMAGE_PROMPT_MARKS.some((mark) => (o.systemPrompt as string).includes(mark))
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
  // Номер сообщения (#N) рядом с именем в ленте переписки — как в Таверне. Смысл
  // есть только у режима РП (там есть лента); в новелле поле просто не читается.
  showMessageNumbers: boolean;
  // --- Ниже — поля, которые читает только лента РП (RpChat). В новелле у них нет
  // экрана, где применяться: там свой DialogueBox и своя «Окна/панели» поверхность. ---
  // Фон ленты переписки — под сообщениями, не путать с фоном сцены новеллы.
  chatBgColor: string;
  // Своя картинка на фон ленты. Лежит обычным ассетом проекта (тип 'icon'),
  // поэтому уезжает вместе с ним при экспорте и копировании.
  chatBgAssetId?: string;
  // Затемнение поверх картинки, 0..1. Не украшение: на светлом или пёстром фоне
  // текст истории читаться перестаёт, а подбирать цвет текста под каждую картинку
  // — работа, которой не должно быть.
  chatBgDim: number;
  // Бабл рассказчика — отдельно от общей поверхности «окна/панели» (та же
  // поверхность ещё красит панель ввода и HUD, трогать её ради одного бабла нельзя).
  narratorBubbleColor: string;
  narratorBubbleOpacity: number; // 0..1
  // Бабл игрока — отдельно от акцента: акцент используется много где ещё (кнопки,
  // подсветки), а бабл игрока должен настраиваться независимо.
  userBubbleColor: string;
  userBubbleOpacity: number; // 0..1
  // Настройки набора текста «как в читалке»: межстрочный интервал, расстояние
  // между сообщениями в ленте, отступ между абзацами внутри одного сообщения.
  lineHeight: number; // 1.2–2.4
  messageSpacing: number; // множитель отступа между сообщениями (0.4–3)
  paragraphSpacing: number; // множитель отступа между абзацами внутри сообщения (0–3)
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
  showMessageNumbers: false,
  chatBgColor: '#000000',
  chatBgDim: 0.45,
  narratorBubbleColor: '#100d18',
  narratorBubbleOpacity: 0.72,
  userBubbleColor: '#b18cff',
  userBubbleOpacity: 0.16,
  lineHeight: 1.6,
  messageSpacing: 1,
  paragraphSpacing: 1,
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
    showMessageNumbers: typeof o.showMessageNumbers === 'boolean' ? o.showMessageNumbers : D.showMessageNumbers,
    chatBgColor: strOr(o.chatBgColor, D.chatBgColor),
    chatBgAssetId: typeof o.chatBgAssetId === 'string' ? o.chatBgAssetId : undefined,
    chatBgDim: numIn(o.chatBgDim, D.chatBgDim, 0, 1),
    narratorBubbleColor: strOr(o.narratorBubbleColor, D.narratorBubbleColor),
    narratorBubbleOpacity: numIn(o.narratorBubbleOpacity, D.narratorBubbleOpacity, 0, 1),
    userBubbleColor: strOr(o.userBubbleColor, D.userBubbleColor),
    userBubbleOpacity: numIn(o.userBubbleOpacity, D.userBubbleOpacity, 0, 1),
    lineHeight: numIn(o.lineHeight, D.lineHeight, 1.2, 2.4),
    messageSpacing: numIn(o.messageSpacing, D.messageSpacing, 0.4, 3),
    paragraphSpacing: numIn(o.paragraphSpacing, D.paragraphSpacing, 0, 3),
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
  // Герой САМ пишет кому-то из игры. Раньше такого бита не было вовсе, и когда
  // героиня отвечала на СМС прямо в сцене, модели оставался только sms_incoming —
  // ответ ложился в переписку от лица собеседника, а не от её.
  | { type: 'sms_outgoing'; characterId: string; text: string }
  // Персонаж присылает герою ФОТО: движок рисует картинку по описанию photo.
  | { type: 'sms_photo'; characterId: string; caption?: string; photo: string }
  | { type: 'contact_added'; characterId: string }
  // Симулятор жизни (Batch 8): продвижение времени и инвентарь. Все — управляющие.
  | { type: 'time_advance'; newDate?: string; newTime?: string }
  // Переезд героя. Отдельный ДЕТЕРМИНИРОВАННЫЙ бит: раньше место ехало только через
  // необязательный worldState.clock, и стоило модели его не прислать — запись
  // застывала и тянула сюжет обратно в покинутый город.
  | { type: 'location_change'; location: string }
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
  eventLevel?: 'general' | 'important' | 'key'; // важность: key/important не вытесняются
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
  // На каком ходу снят снапшот. Без этого он выдавал себя за «положение дел СЕЙЧАС»
  // независимо от возраста: замороженный снапшот тянул сюжет назад, к моменту свёртки.
  storyStateAtTurn?: number;
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
  // СВАЙПЫ — альтернативные варианты одного и того же ответа ИИ (режим РП).
  // Хранится СЫРОЙ ответ модели каждого варианта (со служебной сводкой <state>),
  // тогда как content — проза активного варианта, то есть то, что видят и модель,
  // и игрок. Иначе при возврате к прошлому варианту нечем было бы восстановить
  // состояние мира: в прозе сводки уже нет.
  swipes?: string[];
  swipe?: number; // индекс активного варианта в swipes
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
  // На каком ходу досье последний раз обновлялось. Без этого поля статус вроде
  // «беременна» жил вечно и подавался как факт «сейчас» даже через сто ходов
  // после родов — ИИ верил досье, а не истории.
  updatedAtTurn?: number;
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
  // Важность (как в Horae). Определяет, вытесняется ли событие из промпта: ключевые
  // и важные видны ВСЕГДА, обычные — только последние N. Раньше уровня не было, и
  // лента резалась просто по свежести: крупные вехи (переезд, роды, таймскип)
  // вытеснялись бытовой мелочёвкой и переставали существовать для модели.
  level?: 'general' | 'important' | 'key';
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
  // На каком ходу записана локация — для пометки свежести в промпте.
  locationAtTurn?: number;
  // Дата НАЧАЛА истории (ДД/ММ/ГГГГ), ставится один раз. Нужна, чтобы прошедшее
  // внутриигровое время всегда было видно в промпте: запись о таймскипе живёт
  // в ленте событий и рано или поздно из неё вытесняется, а «прошло 3 года»
  // обязано оставаться фактом столько, сколько идёт история.
  startDate?: string;
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
  // Ход, на котором персонаж последний раз подавал голос. Список onScreen сам себя
  // не чистит (никто со сцены не «уходит», просто вытесняется третьим говорящим),
  // поэтому без отметки времени нельзя отличить «стоит рядом» от «попрощались три
  // хода назад». См. presence.ts.
  atTurn?: number;
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
