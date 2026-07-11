import type {
  Project,
  RuntimeState,
  MemoryState,
  Character,
  CharacterRole,
  StatDefinition,
  AssetMeta,
  AssetType,
  LorebookEntry,
  Emotion,
  AudioMood,
  AiConfig,
  RelationshipStats,
} from './types';
import { EMOTIONS, AUDIO_MOODS } from './types';
import { uid, clamp } from './utils';

export const DEFAULT_STYLE_PRESET = 'romance_club';

export function defaultAiConfig(): AiConfig {
  return {
    provider: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    temperature: 0.9,
    maxContextMessages: 12,
    contextBudget: 8000,
    liveWindow: 12,
    narrativeLanguage: 'ru',
    stylePreset: DEFAULT_STYLE_PRESET,
    jailbreakEnabled: false,
  };
}

export function createEmptyProject(title = 'Новый проект'): Project {
  const now = Date.now();
  return {
    id: uid('proj'),
    createdAt: now,
    updatedAt: now,
    meta: {
      title,
      contentRating: 'sfw',
    },
    lore: {
      worldDescription: '',
      plotOutline: '',
      openingScene: '',
      narrativeRules: 'Повествование от 2-го лица. Не принимай решений за игрока.',
    },
    lorebook: [],
    characters: [],
    stats: [],
    assets: [],
    aiConfig: defaultAiConfig(),
  };
}

// Coerce any stored/imported record (including legacy or partial shapes) into a
// complete, well-formed Project. Single choke point that guarantees the UI and
// game engine never see undefined fields, and migrates old schemas (sprite
// arrays, meta.author/genre/description, scene.musicId) forward.
export function normalizeProject(raw: any): Project {
  const base = createEmptyProject(raw?.meta?.title || 'Без названия');
  const str = (v: unknown, d = '') => (typeof v === 'string' ? v : d);
  const num = (v: unknown, d: number) => (typeof v === 'number' && !Number.isNaN(v) ? v : d);
  const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
  const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

  const emotionSet = new Set<string>(EMOTIONS);
  const moodSet = new Set<string>(AUDIO_MOODS);
  const roleSet = new Set<CharacterRole>([
    'protagonist',
    'love_interest',
    'important_character',
    'npc',
  ]);

  const normSprites = (v: unknown): Partial<Record<Emotion, string>> => {
    const out: Partial<Record<Emotion, string>> = {};
    // New shape: record { emotion: assetId }.
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [emo, assetId] of Object.entries(v as Record<string, unknown>)) {
        if (emotionSet.has(emo) && typeof assetId === 'string') out[emo as Emotion] = assetId;
      }
      return out;
    }
    // Legacy shape: array [{ emotion, assetId }].
    for (const s of arr<any>(v)) {
      if (s && emotionSet.has(s.emotion) && typeof s.assetId === 'string') {
        out[s.emotion as Emotion] = s.assetId;
      }
    }
    return out;
  };

  const clampRel = (v: unknown) => clamp(num(v, 0), -100, 100);
  const normRelationship = (v: any): RelationshipStats => ({
    affection: clampRel(v?.affection),
    passion_stat: clampRel(v?.passion_stat),
    friendship: clampRel(v?.friendship),
  });

  let protagonistSeen = false;
  const characters: Character[] = arr<any>(raw?.characters).map((c) => {
    let role: CharacterRole = roleSet.has(c?.role) ? c.role : 'npc';
    // Legacy flag some early builds may have used.
    if (!roleSet.has(c?.role) && c?.important) role = 'important_character';
    // Один протагонист на проект (CR v2 §B.4): лишних понижаем.
    if (role === 'protagonist') {
      if (protagonistSeen) role = 'important_character';
      else protagonistSeen = true;
    }
    const importFrom = ['tavern_v2', 'tavern_v3', 'manual', 'promoted_npc'].includes(c?.importedFrom)
      ? c.importedFrom
      : undefined;
    return {
      id: str(c?.id) || uid('char'),
      name: str(c?.name, 'Персонаж'),
      role,
      card: {
        appearance: str(c?.card?.appearance),
        personality: str(c?.card?.personality),
        backstory: str(c?.card?.backstory),
        speechStyle: str(c?.card?.speechStyle),
        relationshipArc:
          typeof c?.card?.relationshipArc === 'string' ? c.card.relationshipArc : undefined,
        scenario: typeof c?.card?.scenario === 'string' ? c.card.scenario : undefined,
        greetings: Array.isArray(c?.card?.greetings)
          ? c.card.greetings.filter((g: unknown) => typeof g === 'string')
          : undefined,
      },
      sprites: normSprites(c?.sprites),
      relationship: normRelationship(c?.relationship),
      relationshipHidden: bool(c?.relationshipHidden, false) || undefined,
      linkedStatId: typeof c?.linkedStatId === 'string' ? c.linkedStatId : undefined,
      importedFrom: importFrom,
      sourceSystemPrompt:
        typeof c?.sourceSystemPrompt === 'string' ? c.sourceSystemPrompt : undefined,
    };
  });

  const stats: StatDefinition[] = arr<any>(raw?.stats).map((s) => ({
    id: str(s?.id) || uid('stat'),
    name: str(s?.name, 'Стат'),
    iconAssetId: typeof s?.iconAssetId === 'string' ? s.iconAssetId : undefined,
    min: num(s?.min, 0),
    max: num(s?.max, 100),
    initial: num(s?.initial, 0),
    visible: bool(s?.visible, true),
    description: str(s?.description),
  }));

  const assetTypes: AssetType[] = ['background', 'sprite', 'music', 'sfx', 'cg', 'icon'];
  const assets: AssetMeta[] = arr<any>(raw?.assets)
    .filter((a) => a && typeof a.id === 'string' && typeof a.blobKey === 'string')
    .map((a) => ({
      id: a.id,
      type: assetTypes.includes(a.type) ? a.type : 'background',
      name: str(a.name, a.id),
      tags: Array.isArray(a.tags) ? a.tags.filter((t: unknown) => typeof t === 'string') : undefined,
      audioMood: moodSet.has(a.audioMood) ? (a.audioMood as AudioMood) : undefined,
      generated: bool(a.generated, false) || undefined,
      blobKey: a.blobKey,
      mime: typeof a.mime === 'string' ? a.mime : undefined,
    }));

  const lorebook: LorebookEntry[] = arr<any>(raw?.lorebook).map((e) => ({
    id: str(e?.id) || uid('lb'),
    title: str(e?.title, 'Запись'),
    keys: arr<string>(e?.keys).filter((k) => typeof k === 'string'),
    content: str(e?.content),
    alwaysActive: bool(e?.alwaysActive, false),
    priority: num(e?.priority, 0),
  }));

  const ai = raw?.aiConfig || {};
  // Legacy: старый «жанр» переносим в customStyle как штрих тона.
  const legacyGenre = typeof raw?.meta?.genre === 'string' ? raw.meta.genre : '';
  const customStyle =
    typeof ai.customStyle === 'string'
      ? ai.customStyle
      : legacyGenre
        ? `Жанр/тон: ${legacyGenre}`
        : undefined;

  return {
    id: str(raw?.id) || base.id,
    createdAt: num(raw?.createdAt, base.createdAt),
    updatedAt: num(raw?.updatedAt, base.updatedAt),
    meta: {
      title: str(raw?.meta?.title, base.meta.title),
      coverAssetId: typeof raw?.meta?.coverAssetId === 'string' ? raw.meta.coverAssetId : undefined,
      contentRating: raw?.meta?.contentRating === 'mature' ? 'mature' : 'sfw',
    },
    lore: {
      worldDescription: str(raw?.lore?.worldDescription),
      plotOutline: str(raw?.lore?.plotOutline),
      openingScene: str(raw?.lore?.openingScene),
      narrativeRules: str(raw?.lore?.narrativeRules, base.lore.narrativeRules),
    },
    lorebook,
    characters,
    stats,
    assets,
    aiConfig: {
      provider: ai.provider === 'anthropic' ? 'anthropic' : 'openai-compatible',
      baseUrl: str(ai.baseUrl, base.aiConfig.baseUrl),
      model: str(ai.model, base.aiConfig.model),
      temperature: num(ai.temperature, base.aiConfig.temperature),
      maxContextMessages: num(ai.maxContextMessages, base.aiConfig.maxContextMessages),
      contextBudget: num(ai.contextBudget, base.aiConfig.contextBudget),
      liveWindow: num(ai.liveWindow, base.aiConfig.liveWindow),
      summarizerModel: typeof ai.summarizerModel === 'string' ? ai.summarizerModel : undefined,
      narrativeLanguage: ai.narrativeLanguage === 'en' ? 'en' : 'ru',
      stylePreset: str(ai.stylePreset, base.aiConfig.stylePreset),
      customStyle,
      jailbreakEnabled: bool(ai.jailbreakEnabled, false),
      jailbreakPrompt: typeof ai.jailbreakPrompt === 'string' ? ai.jailbreakPrompt : undefined,
      prefill: typeof ai.prefill === 'string' ? ai.prefill : undefined,
      advancedBlocks: arr<any>(ai.advancedBlocks)
        .filter((b) => b && typeof b.content === 'string')
        .map((b) => ({ content: b.content, depth: num(b.depth, 0) })),
      imageBaseUrl: typeof ai.imageBaseUrl === 'string' ? ai.imageBaseUrl : undefined,
      imageModel: typeof ai.imageModel === 'string' ? ai.imageModel : undefined,
    },
  };
}

export function initialMemory(): MemoryState {
  return { chronicle: [], currentChapterSummary: '', chapter: 1, facts: [] };
}

export function initialRuntimeState(project: Project, protagonistName?: string): RuntimeState {
  const statValues: Record<string, number> = {};
  for (const s of project.stats) statValues[s.id] = s.initial;

  // Живые значения отношений — из стартовых значений персонажей.
  const relationship: Record<string, RelationshipStats> = {};
  for (const c of project.characters) relationship[c.id] = { ...c.relationship };

  // Имя героя берём из карточки протагониста (CR v2 §B.5) — отдельного экрана нет.
  const protagonist = project.characters.find((c) => c.role === 'protagonist');
  const name = protagonistName ?? protagonist?.name ?? '';

  return {
    protagonistName: name,
    statValues,
    relationship,
    currentBackgroundId: null,
    currentMusicMood: null,
    currentMusicAssetId: null,
    onScreen: [],
    history: [],
    memory: initialMemory(),
    lastTurn: null,
    turnCount: 0,
  };
}
