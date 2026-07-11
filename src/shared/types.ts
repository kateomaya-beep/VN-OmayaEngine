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
export const AUDIO_MOODS = ['calm', 'tense', 'scary', 'romantic', 'sad', 'joyful'] as const;
export type AudioMood = (typeof AUDIO_MOODS)[number];

export const AUDIO_MOOD_LABELS: Record<AudioMood, { ru: string; en: string }> = {
  calm: { ru: 'спокойная', en: 'calm' },
  tense: { ru: 'напряжённая', en: 'tense' },
  scary: { ru: 'жуткая', en: 'scary' },
  romantic: { ru: 'романтичная', en: 'romantic' },
  sad: { ru: 'грустная', en: 'sad' },
  joyful: { ru: 'весёлая', en: 'joyful' },
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

// Три связанных стата отношений у КАЖДОГО персонажа (см. CR v2 §C), -100..100.
export interface RelationshipStats {
  affection: number; // ❤️ симпатия
  passion_stat: number; // 🔥 страсть
  friendship: number; // 🍀 дружба
}

export const RELATIONSHIP_FIELDS = ['affection', 'passion_stat', 'friendship'] as const;
export type RelationshipField = (typeof RELATIONSHIP_FIELDS)[number];

export const RELATIONSHIP_META: Record<
  RelationshipField,
  { icon: string; ru: string; en: string }
> = {
  affection: { icon: '❤️', ru: 'Симпатия', en: 'Affection' },
  passion_stat: { icon: '🔥', ru: 'Страсть', en: 'Passion' },
  friendship: { icon: '🍀', ru: 'Дружба', en: 'Friendship' },
};

export function emptyRelationship(): RelationshipStats {
  return { affection: 0, passion_stat: 0, friendship: 0 };
}

export interface Character {
  id: string;
  name: string;
  role: CharacterRole;
  card: CharacterCard;
  // emotion -> assetId. Спрайты опциональны для любой роли: нет спрайта —
  // реплика рендерится как имя + текст (единое правило, без крашей).
  sprites: Partial<Record<Emotion, string>>;
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
  audioMood?: AudioMood; // для music
  generated?: boolean; // сгенерирован image-API по ходу игры
  blobKey: string;
  mime?: string;
}

export interface AdvancedPromptBlock {
  content: string;
  depth: number; // глубина от конца истории (0 = сразу перед ходом игрока)
}

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
  jailbreakEnabled: boolean; // слой 3, по умолчанию ВЫКЛ
  jailbreakPrompt?: string;
  prefill?: string; // слой 4 (продвинутый)
  advancedBlocks?: AdvancedPromptBlock[];
  // Генерация изображений (BYO key, ключ в localStorage)
  imageBaseUrl?: string;
  imageModel?: string;
}

export interface Project {
  id: string;
  createdAt: number;
  updatedAt: number;
  meta: ProjectMeta;
  lore: Lore;
  lorebook: LorebookEntry[];
  characters: Character[];
  stats: StatDefinition[];
  assets: AssetMeta[];
  aiConfig: AiConfig;
}

// ---- Runtime / AI response types (JSON-контракт с ИИ) ----

export type Beat =
  | { type: 'narration'; text: string }
  | { type: 'thought'; text: string }
  | {
      type: 'dialogue';
      characterId?: string; // для персонажей из списка
      name?: string; // для эпизодических NPC, введённых ИИ
      emotion: string;
      position: 'left' | 'center' | 'right';
      text: string;
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
}

// ---- Memory ----

export interface CanonicalFact {
  chapter: number;
  kind: 'choice' | 'stat' | 'event';
  text: string;
}

export interface MemoryState {
  chronicle: string[];
  currentChapterSummary: string;
  chapter: number;
  facts: CanonicalFact[];
}

export type LlmRole = 'system' | 'user' | 'assistant';
export interface LlmMessage {
  role: LlmRole;
  content: string;
}

// ---- Save slots ----

export interface OnScreenSprite {
  characterId: string;
  emotion: string;
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
  lastTurn: AiTurn | null;
  turnCount: number;
}

export interface SaveSlot {
  slot: number;
  projectId: string;
  savedAt: number;
  title: string;
  state: RuntimeState;
}
