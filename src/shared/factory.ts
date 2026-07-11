import type {
  Project,
  RuntimeState,
  MemoryState,
  Character,
  StatDefinition,
  AssetMeta,
  LorebookEntry,
} from './types';
import { uid } from './utils';

export function createEmptyProject(title = 'Новый проект'): Project {
  const now = Date.now();
  return {
    id: uid('proj'),
    createdAt: now,
    updatedAt: now,
    meta: {
      title,
      author: '',
      genre: 'романтика',
      description: '',
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
    aiConfig: {
      provider: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      temperature: 0.9,
      maxContextMessages: 12,
      contextBudget: 8000,
      liveWindow: 12,
    },
  };
}

// Coerce any stored/imported record (including legacy or partial shapes) into a
// complete, well-formed Project. This is the single choke point that guarantees
// the UI and game engine never see undefined fields — fixes crashes from old
// data left in IndexedDB by earlier builds.
export function normalizeProject(raw: any): Project {
  const base = createEmptyProject(raw?.meta?.title || 'Без названия');
  const str = (v: unknown, d = '') => (typeof v === 'string' ? v : d);
  const num = (v: unknown, d: number) => (typeof v === 'number' && !Number.isNaN(v) ? v : d);
  const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
  const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

  const characters: Character[] = arr<any>(raw?.characters).map((c) => ({
    id: str(c?.id) || uid('char'),
    name: str(c?.name, 'Персонаж'),
    role: ['love_interest', 'npc', 'protagonist'].includes(c?.role) ? c.role : 'npc',
    card: {
      appearance: str(c?.card?.appearance),
      personality: str(c?.card?.personality),
      backstory: str(c?.card?.backstory),
      speechStyle: str(c?.card?.speechStyle),
      relationshipArc: typeof c?.card?.relationshipArc === 'string' ? c.card.relationshipArc : undefined,
    },
    sprites: arr<any>(c?.sprites)
      .filter((s) => s && typeof s.emotion === 'string' && typeof s.assetId === 'string')
      .map((s) => ({ emotion: s.emotion, assetId: s.assetId })),
    linkedStatId: typeof c?.linkedStatId === 'string' ? c.linkedStatId : undefined,
  }));

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

  const assets: AssetMeta[] = arr<any>(raw?.assets)
    .filter((a) => a && typeof a.id === 'string' && typeof a.blobKey === 'string')
    .map((a) => ({
      id: a.id,
      type: ['background', 'sprite', 'music', 'sfx', 'cg', 'icon'].includes(a.type)
        ? a.type
        : 'background',
      name: str(a.name, a.id),
      tags: arr<string>(a.tags).filter((t) => typeof t === 'string'),
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

  return {
    id: str(raw?.id) || base.id,
    createdAt: num(raw?.createdAt, base.createdAt),
    updatedAt: num(raw?.updatedAt, base.updatedAt),
    meta: {
      title: str(raw?.meta?.title, base.meta.title),
      author: str(raw?.meta?.author),
      coverAssetId: typeof raw?.meta?.coverAssetId === 'string' ? raw.meta.coverAssetId : undefined,
      genre: str(raw?.meta?.genre, base.meta.genre),
      description: str(raw?.meta?.description),
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
      provider: raw?.aiConfig?.provider === 'anthropic' ? 'anthropic' : 'openai-compatible',
      baseUrl: str(raw?.aiConfig?.baseUrl, base.aiConfig.baseUrl),
      model: str(raw?.aiConfig?.model, base.aiConfig.model),
      temperature: num(raw?.aiConfig?.temperature, base.aiConfig.temperature),
      maxContextMessages: num(raw?.aiConfig?.maxContextMessages, base.aiConfig.maxContextMessages),
      contextBudget: num(raw?.aiConfig?.contextBudget, base.aiConfig.contextBudget),
      liveWindow: num(raw?.aiConfig?.liveWindow, base.aiConfig.liveWindow),
      customDirectorPrompt:
        typeof raw?.aiConfig?.customDirectorPrompt === 'string'
          ? raw.aiConfig.customDirectorPrompt
          : undefined,
      summarizerModel:
        typeof raw?.aiConfig?.summarizerModel === 'string' ? raw.aiConfig.summarizerModel : undefined,
    },
  };
}

export function initialMemory(): MemoryState {
  return { chronicle: [], currentChapterSummary: '', chapter: 1, facts: [] };
}

export function initialRuntimeState(project: Project): RuntimeState {
  const statValues: Record<string, number> = {};
  for (const s of project.stats) statValues[s.id] = s.initial;
  return {
    statValues,
    currentBackgroundId: null,
    currentMusicId: null,
    onScreen: [],
    history: [],
    memory: initialMemory(),
    lastTurn: null,
    turnCount: 0,
  };
}
