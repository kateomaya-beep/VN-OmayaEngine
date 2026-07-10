// Core project data models (see ТЗ §4)

export type ContentRating = 'sfw' | 'mature';
export type CharacterRole = 'love_interest' | 'npc' | 'protagonist';
export type AssetType = 'background' | 'sprite' | 'music' | 'sfx' | 'cg' | 'icon';

export const EMOTIONS = [
  'neutral',
  'happy',
  'sad',
  'angry',
  'shy',
  'surprised',
  'smug',
  'scared',
  'love',
] as const;

export interface ProjectMeta {
  title: string;
  author: string;
  coverAssetId?: string;
  genre: string;
  description: string;
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

export interface SpriteBinding {
  emotion: string;
  assetId: string;
}

export interface CharacterCard {
  appearance: string;
  personality: string;
  backstory: string;
  speechStyle: string;
  relationshipArc?: string;
}

export interface Character {
  id: string;
  name: string;
  role: CharacterRole;
  card: CharacterCard;
  sprites: SpriteBinding[];
  linkedStatId?: string;
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
  tags: string[];
  blobKey: string;
  mime?: string;
}

export interface AiConfig {
  provider: 'openai-compatible' | 'anthropic';
  baseUrl: string;
  model: string;
  temperature: number;
  maxContextMessages: number;
  contextBudget: number; // approx tokens reserved for history
  liveWindow: number; // K turns kept verbatim
  customDirectorPrompt?: string;
  summarizerModel?: string;
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

// ---- Runtime / AI response types (see ТЗ §7) ----

export type Beat =
  | { type: 'narration'; text: string }
  | { type: 'thought'; text: string }
  | {
      type: 'dialogue';
      characterId: string;
      emotion: string;
      position: 'left' | 'center' | 'right';
      text: string;
    };

export interface SceneDirective {
  backgroundId: string | null;
  musicId: string | null;
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

// ---- Memory (see ТЗ §10) ----

export interface CanonicalFact {
  chapter: number;
  kind: 'choice' | 'stat' | 'event';
  text: string;
}

export interface MemoryState {
  chronicle: string[]; // layer 1: summaries of chapters 1..N-1
  currentChapterSummary: string; // layer 2
  chapter: number; // current chapter index (1-based)
  facts: CanonicalFact[]; // canonical facts store
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
  statValues: Record<string, number>;
  currentBackgroundId: string | null;
  currentMusicId: string | null;
  onScreen: OnScreenSprite[];
  history: LlmMessage[]; // full LLM conversation
  memory: MemoryState;
  lastTurn: AiTurn | null;
  turnCount: number;
}

export interface SaveSlot {
  slot: number; // 0 = autosave, 1..10 = manual
  projectId: string;
  savedAt: number;
  title: string;
  state: RuntimeState;
}
