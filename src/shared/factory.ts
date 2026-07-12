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
  MemoryConfig,
  PromptLength,
  PromptPacing,
  PromptTone,
  ProseStyleId,
  ApiConnection,
  GameMasterState,
} from './types';
import { EMOTIONS, AUDIO_MOODS, defaultMemoryConfig, emptyGameMaster, normalizeTurnLength } from './types';
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
    length: 'medium',
    pacing: 'adaptive',
    tone: 'neutral',
    proseStyle: 'clean',
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
    memoryConfig: defaultMemoryConfig(),
    audioMoods: [],
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
  // Кастомные настроения проекта (см. CR v2 §N.2) — дедуп против базовых 8.
  const baseMoodSet = new Set<string>(AUDIO_MOODS);
  const audioMoods = arr<any>(raw?.audioMoods)
    .filter((m): m is string => typeof m === 'string' && m.trim().length > 0)
    .map((m) => m.trim())
    .filter((m, i, list) => !baseMoodSet.has(m) && list.indexOf(m) === i);
  const moodSet = new Set<string>([...AUDIO_MOODS, ...audioMoods]);
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
    respect: clampRel(v?.respect),
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
      audioMood: moodSet.has(a.audioMood) ? (a.audioMood as string) : undefined,
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

  const lengthSet = new Set<PromptLength>(['short', 'medium', 'long']);
  const pacingSet = new Set<PromptPacing>(['slow_burn', 'fast', 'adaptive']);
  const toneSet = new Set<PromptTone>(['neutral', 'anti_negative', 'anti_saccharine']);
  const proseSet = new Set<ProseStyleId>(['clean', 'anne_rice', 'king', 'gaiman', 'dostoevsky', 'gogol']);

  const normConnection = (v: any): ApiConnection | undefined => {
    if (!v || typeof v !== 'object' || typeof v.baseUrl !== 'string') return undefined;
    return {
      provider: v.provider === 'anthropic' ? 'anthropic' : 'openai-compatible',
      baseUrl: v.baseUrl,
      model: typeof v.model === 'string' ? v.model : undefined,
      availableModels: Array.isArray(v.availableModels)
        ? v.availableModels.filter((m: unknown) => typeof m === 'string')
        : undefined,
    };
  };

  const mem = raw?.memoryConfig || {};
  const vecSet = new Set(['builtin', 'custom', 'off']);

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
      length: lengthSet.has(ai.length) ? ai.length : base.aiConfig.length,
      pacing: pacingSet.has(ai.pacing) ? ai.pacing : base.aiConfig.pacing,
      tone: toneSet.has(ai.tone) ? ai.tone : base.aiConfig.tone,
      proseStyle: proseSet.has(ai.proseStyle) ? ai.proseStyle : base.aiConfig.proseStyle,
      jailbreakEnabled: bool(ai.jailbreakEnabled, false),
      jailbreakPrompt: typeof ai.jailbreakPrompt === 'string' ? ai.jailbreakPrompt : undefined,
      prefill: typeof ai.prefill === 'string' ? ai.prefill : undefined,
      turnLength: ai.turnLength ? normalizeTurnLength(ai.turnLength) : undefined,
      choiceMinGap:
        typeof ai.choiceMinGap === 'number' ? clamp(Math.round(ai.choiceMinGap), 0, 20) : undefined,
      advancedBlocks: arr<any>(ai.advancedBlocks)
        .filter((b) => b && typeof b.content === 'string')
        .map((b) => ({ content: b.content, depth: num(b.depth, 0) })),
      imageBaseUrl: typeof ai.imageBaseUrl === 'string' ? ai.imageBaseUrl : undefined,
      imageModel: typeof ai.imageModel === 'string' ? ai.imageModel : undefined,
      summaryConnection: normConnection(ai.summaryConnection),
      promptPreset: ai.promptPreset && typeof ai.promptPreset === 'object' ? ai.promptPreset : undefined,
    },
    memoryConfig: {
      summaryEveryN: num(mem.summaryEveryN, 30),
      summaryPrompt: typeof mem.summaryPrompt === 'string' ? mem.summaryPrompt : undefined,
      vectorization: vecSet.has(mem.vectorization) ? mem.vectorization : 'off',
      embeddingsConnection: normConnection(mem.embeddingsConnection),
    },
    audioMoods,
  };
}

export function initialMemory(): MemoryState {
  return {
    chronicle: [],
    foldedMsgCount: 0,
    liveSummary: '',
    facts: [],
    memorybook: [],
    messagesSinceSummary: 0,
    rawArchive: [],
  };
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
    gm: initialGameMaster(project),
    lastTurn: null,
    turnCount: 0,
    lastChoiceTurn: -1e9,
    authorNote: '',
  };
}

// Стартовое состояние Game Master: досье персонажей из карточек конструктора,
// далее ИИ обновляет их каждый ход.
function initialGameMaster(project: Project): GameMasterState {
  const gm = emptyGameMaster();
  const roleToHero: Record<string, string> = {
    protagonist: 'the player hero',
    love_interest: 'love interest',
    important_character: 'important character',
    npc: 'minor character',
  };
  gm.characters = project.characters
    .filter((c) => c.role !== 'protagonist')
    .map((c) => ({
      charId: c.id,
      name: c.name,
      dossier: (c.card.personality || '').slice(0, 160),
      appearance: c.card.appearance || '',
      personality: c.card.personality || '',
      roleToHero: roleToHero[c.role] || c.role,
      outfit: '',
      mood: 'neutral',
      status: '',
      location: '',
      tags: [],
    }));
  return gm;
}

// Coerce a stored save's RuntimeState (raw, possibly from an older schema before
// relationship stats / protagonistName / currentMusicMood existed) into a complete
// shape. Same choke-point pattern as normalizeProject — prevents crashes like
// "Cannot read properties of undefined (reading '<charId>')" in RelationshipsPanel
// when an old save lacks fields that later builds added.
export function normalizeRuntimeState(raw: any, project: Project): RuntimeState {
  const fresh = initialRuntimeState(project);
  if (!raw || typeof raw !== 'object') return fresh;

  const str = (v: unknown, d = '') => (typeof v === 'string' ? v : d);
  const num = (v: unknown, d: number) => (typeof v === 'number' && !Number.isNaN(v) ? v : d);
  const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

  const statValues: Record<string, number> = { ...fresh.statValues };
  if (raw.statValues && typeof raw.statValues === 'object') {
    for (const [k, v] of Object.entries(raw.statValues)) {
      if (typeof v === 'number') statValues[k] = v;
    }
  }

  // Живые значения отношений: старт из дефолтов проекта, поверх — сохранённые.
  const relationship: Record<string, RelationshipStats> = { ...fresh.relationship };
  if (raw.relationship && typeof raw.relationship === 'object') {
    for (const [charId, v] of Object.entries<any>(raw.relationship)) {
      relationship[charId] = {
        affection: clamp(num(v?.affection, 0), -100, 100),
        passion_stat: clamp(num(v?.passion_stat, 0), -100, 100),
        friendship: clamp(num(v?.friendship, 0), -100, 100),
        respect: clamp(num(v?.respect, 0), -100, 100),
      };
    }
  }

  return {
    protagonistName: str(raw.protagonistName, fresh.protagonistName),
    statValues,
    relationship,
    currentBackgroundId: typeof raw.currentBackgroundId === 'string' ? raw.currentBackgroundId : null,
    currentMusicMood: typeof raw.currentMusicMood === 'string' ? raw.currentMusicMood : null,
    currentMusicAssetId:
      typeof raw.currentMusicAssetId === 'string' ? raw.currentMusicAssetId : null,
    onScreen: arr<any>(raw.onScreen),
    history: arr<any>(raw.history).filter(
      (m: any) => m && typeof m.role === 'string' && typeof m.content === 'string'
    ),
    memory: normalizeMemory(raw.memory, str, num, arr),
    gm: normalizeGameMaster(raw.gm, fresh.gm, str, num, arr),
    lastTurn: raw.lastTurn && typeof raw.lastTurn === 'object' ? raw.lastTurn : null,
    turnCount: num(raw.turnCount, 0),
    lastChoiceTurn: num(raw.lastChoiceTurn, -1e9),
    authorNote: str(raw.authorNote),
  };
}

// Мягкая нормализация состояния Game Master из сейва (старые сейвы без gm → fresh).
function normalizeGameMaster(
  raw: any,
  fresh: GameMasterState,
  str: (v: unknown, d?: string) => string,
  num: (v: unknown, d: number) => number,
  arr: <T>(v: unknown) => T[]
): GameMasterState {
  if (!raw || typeof raw !== 'object') return fresh;
  const strArr = (v: unknown): string[] => arr<any>(v).filter((x) => typeof x === 'string');
  const months = strArr(raw?.calendar?.months);
  return {
    clock: {
      // Миграция старого clock.date → day, если новых полей нет.
      day: str(raw?.clock?.day) || str(raw?.clock?.date),
      month: str(raw?.clock?.month),
      year: str(raw?.clock?.year),
      time: str(raw?.clock?.time),
      location: str(raw?.clock?.location),
    },
    calendar: { months: months.length ? months : [...fresh.calendar.months] },
    showClockInGame: typeof raw.showClockInGame === 'boolean' ? raw.showClockInGame : false,
    characters: arr<any>(raw.characters)
      .filter((c) => c && typeof c.name === 'string')
      .map((c) => ({
        charId: typeof c.charId === 'string' ? c.charId : undefined,
        name: c.name,
        dossier: str(c.dossier),
        appearance: str(c.appearance),
        personality: str(c.personality),
        roleToHero: str(c.roleToHero),
        outfit: str(c.outfit),
        mood: str(c.mood),
        status: str(c.status),
        location: str(c.location),
        tags: strArr(c.tags),
      })),
    relations: arr<any>(raw.relations)
      .filter((r) => r && typeof r.from === 'string' && typeof r.to === 'string')
      .map((r) => ({ from: r.from, to: r.to, label: str(r.label) })),
    events: arr<any>(raw.events)
      .filter((e) => e && typeof e.summary === 'string')
      .map((e) => ({
        id: typeof e.id === 'string' ? e.id : uid('evt'),
        turn: num(e.turn, 0),
        date: str(e.date),
        chars: strArr(e.chars),
        summary: e.summary,
        mood: str(e.mood),
        source: e.source === 'manual' ? 'manual' : 'auto',
      })),
    agenda: arr<any>(raw.agenda)
      .filter((t) => t && typeof t.text === 'string')
      .map((t) => ({
        id: typeof t.id === 'string' ? t.id : uid('task'),
        text: t.text,
        done: !!t.done,
        source: t.source === 'manual' ? 'manual' : 'auto',
      })),
  };
}

const FACT_KINDS = new Set(['choice', 'stat', 'event']);

// Migrates legacy MemoryState (chapter-based: currentChapterSummary/chapter/facts
// with a `chapter` field) to the chapter-free shape (см. CR v2 §E: «глав» больше нет).
function normalizeMemory(
  raw: any,
  str: (v: unknown, d?: string) => string,
  num: (v: unknown, d: number) => number,
  arr: <T>(v: unknown) => T[]
): MemoryState {
  const liveSummary = str(raw?.liveSummary) || str(raw?.currentChapterSummary);

  const facts = arr<any>(raw?.facts)
    .filter((f) => f && typeof f.text === 'string' && FACT_KINDS.has(f.kind))
    .map((f) => ({
      turn: typeof f.turn === 'number' ? f.turn : num(f.chapter, 0),
      kind: f.kind,
      text: f.text,
    }));

  const memorybook = arr<any>(raw?.memorybook)
    .filter((e) => e && typeof e.text === 'string')
    .map((e) => ({
      id: str(e.id) || uid('mem'),
      text: e.text,
      turn: num(e.turn, 0),
      source: (e.source === 'manual' ? 'manual' : 'auto') as 'manual' | 'auto',
      pinned: typeof e.pinned === 'boolean' ? e.pinned : false,
    }));

  const rawArchive = arr<any>(raw?.rawArchive)
    .filter((r) => r && typeof r.text === 'string')
    .map((r) => ({ turn: num(r.turn, 0), text: r.text }));

  // Хроника: миграция старого формата (string[]) в записи с метаданными.
  const chronicle = arr<any>(raw?.chronicle)
    .map((c, i) => {
      if (typeof c === 'string') return { id: uid('chr'), text: c, atTurn: 0, fromMsg: 0, toMsg: 0, _i: i };
      if (c && typeof c.text === 'string')
        return {
          id: typeof c.id === 'string' ? c.id : uid('chr'),
          text: c.text,
          atTurn: num(c.atTurn, 0),
          fromMsg: num(c.fromMsg, 0),
          toMsg: num(c.toMsg, 0),
          _i: i,
        };
      return null;
    })
    .filter(Boolean)
    .map(({ _i, ...e }: any) => e);

  return {
    chronicle,
    foldedMsgCount: num(raw?.foldedMsgCount, 0),
    liveSummary,
    facts,
    memorybook,
    messagesSinceSummary: num(raw?.messagesSinceSummary, 0),
    rawArchive,
  };
}
