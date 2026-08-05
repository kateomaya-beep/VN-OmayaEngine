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
  PhoneState,
} from './types';
import {
  EMOTIONS,
  AUDIO_MOODS,
  defaultMemoryConfig,
  emptyGameMaster,
  normalizeTurnLength,
  normalizePlayerTheme,
  normalizeImageGen,
  normalizeRandomEvents,
  normalizePhoneConfig,
  initialPhoneState,
  normalizeFinanceConfig,
  normalizeInventory,
  normalizeRandomSms,
  PHONE_BALANCE_STAT,
} from './types';
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
  // Доп. наряды (Batch 5.3): [{ outfit, description?, sprites }]. Пустые/безымянные отбрасываем.
  const normOutfits = (
    v: unknown
  ): { outfit: string; description?: string; sprites: Partial<Record<Emotion, string>> }[] | undefined => {
    const list = arr<any>(v)
      .map((o) => {
        const desc = str(o?.description).trim();
        return { outfit: str(o?.outfit).trim(), ...(desc ? { description: desc } : {}), sprites: normSprites(o?.sprites) };
      })
      .filter((o) => o.outfit);
    return list.length ? list : undefined;
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
      outfits: normOutfits(c?.outfits),
      defaultOutfit: typeof c?.defaultOutfit === 'string' && c.defaultOutfit.trim()
        ? c.defaultOutfit.trim()
        : undefined,
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
    linkedCharacterId: typeof s?.linkedCharacterId === 'string' ? s.linkedCharacterId : undefined,
  }));

  // Миграция старой связи (Character.linkedStatId, one-to-one) → новую
  // (StatDefinition.linkedCharacterId, many-to-one). Только если у стата ещё нет связи.
  for (const c of characters) {
    if (c.linkedStatId) {
      const st = stats.find((s) => s.id === c.linkedStatId);
      if (st && !st.linkedCharacterId) st.linkedCharacterId = c.id;
      c.linkedStatId = undefined;
    }
  }

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
      reasoningEffort: ['none', 'low', 'medium', 'high'].includes(ai.reasoningEffort)
        ? ai.reasoningEffort
        : undefined,
      guidedThinking: bool(ai.guidedThinking, false) || undefined,
      thinkingPlan: typeof ai.thinkingPlan === 'string' ? ai.thinkingPlan : undefined,
      advancedBlocks: arr<any>(ai.advancedBlocks)
        .filter((b) => b && typeof b.content === 'string')
        .map((b) => ({ content: b.content, depth: num(b.depth, 0) })),
      imageBaseUrl: typeof ai.imageBaseUrl === 'string' ? ai.imageBaseUrl : undefined,
      imageModel: typeof ai.imageModel === 'string' ? ai.imageModel : undefined,
      summaryConnection: normConnection(ai.summaryConnection),
      assetSelector: ['main', 'custom', 'local'].includes(ai.assetSelector?.source)
        ? { source: ai.assetSelector.source, customApi: normConnection(ai.assetSelector.customApi) }
        : undefined,
      promptPreset: ai.promptPreset && typeof ai.promptPreset === 'object' ? ai.promptPreset : undefined,
    },
    memoryConfig: {
      summaryEveryN: num(mem.summaryEveryN, 30),
      summaryPrompt: typeof mem.summaryPrompt === 'string' ? mem.summaryPrompt : undefined,
      summaryMaxTokens:
        typeof mem.summaryMaxTokens === 'number' && mem.summaryMaxTokens >= 1000
          ? Math.min(32000, Math.round(mem.summaryMaxTokens))
          : 8000,
      minorEventsLimit:
        typeof mem.minorEventsLimit === 'number' ? clamp(Math.round(mem.minorEventsLimit), 3, 40) : 10,
      vectorization: vecSet.has(mem.vectorization) ? mem.vectorization : 'off',
      embeddingsConnection: normConnection(mem.embeddingsConnection),
    },
    audioMoods,
    playerTheme: raw?.playerTheme ? normalizePlayerTheme(raw.playerTheme) : undefined,
    imageGen: raw?.imageGen ? normalizeImageGen(raw.imageGen) : undefined,
    randomEvents: raw?.randomEvents ? normalizeRandomEvents(raw.randomEvents) : undefined,
    randomSms: raw?.randomSms ? normalizeRandomSms(raw.randomSms) : undefined,
    phone: raw?.phone ? normalizePhoneConfig(raw.phone) : undefined,
    finance: raw?.finance ? normalizeFinanceConfig(raw.finance) : undefined,
  };
}

export function initialMemory(): MemoryState {
  return {
    chronicle: [],
    storyState: '',
    storyStateAtTurn: 0,
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
  // Стартовый капитал телефона/финансов (Batch 8 §III.1): баланс — виртуальный стат.
  if (project.finance) statValues[PHONE_BALANCE_STAT] = project.finance.startingBalance;

  // Живые значения отношений — из стартовых значений персонажей.
  const relationship: Record<string, RelationshipStats> = {};
  for (const c of project.characters) relationship[c.id] = { ...c.relationship };

  // Имя героя берём из карточки протагониста (CR v2 §B.5) — отдельного экрана нет.
  const protagonist = project.characters.find((c) => c.role === 'protagonist');
  const name = protagonistName ?? protagonist?.name ?? '';

  const gm = initialGameMaster(project);
  // Стартовая внутриигровая дата (Batch 8 §II.2) — источник для начислений финансов.
  if (project.finance?.startDate) gm.clock.date = project.finance.startDate;

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
    authorNotes: [],
    turnsSinceLastEvent: 999, // «давно не было» → случайное событие может сработать сразу
    turnsSinceLastSms: 999,
    phone: initialPhoneState(),
    inventory: [],
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
    // Миграция: старое единичное authorNote (строка) → одна запись списка.
    authorNotes: Array.isArray(raw.authorNotes)
      ? raw.authorNotes
          .filter((n: any) => n && typeof n.text === 'string')
          .map((n: any) => ({ id: typeof n.id === 'string' ? n.id : uid('note'), text: n.text }))
      : str(raw.authorNote).trim()
        ? [{ id: uid('note'), text: str(raw.authorNote) }]
        : [],
    turnsSinceLastEvent: num(raw.turnsSinceLastEvent, fresh.turnsSinceLastEvent ?? 999),
    turnsSinceLastSms: num(raw.turnsSinceLastSms, fresh.turnsSinceLastSms ?? 999),
    // Телефон (Batch 7): сохраняем контакты/переписки/транзакции/заказы при загрузке.
    phone: normalizePhoneState(raw.phone, project.characters.find((c) => c.role === 'protagonist')?.id),
    // Инвентарь (Batch 8): из RuntimeState.inventory; миграция со старого phone.inventory.
    inventory: normalizeInventory(
      Array.isArray(raw.inventory) ? raw.inventory : raw?.phone?.inventory
    ),
  };
}

// Нормализация рантайм-состояния телефона из сейва (старые сейвы без phone → fresh;
// переименование shopCache→deliveryCache; добавление activeOrders — миграция).
function normalizePhoneState(raw: any, protagonistId?: string): PhoneState {
  const fresh = initialPhoneState();
  if (!raw || typeof raw !== 'object') return fresh;
  const a = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  const conv: Record<string, any[]> = {};
  if (raw.conversations && typeof raw.conversations === 'object') {
    for (const [k, v] of Object.entries(raw.conversations)) {
      if (Array.isArray(v)) conv[k] = v.filter((m: any) => m && typeof m.text === 'string');
    }
  }
  // Контакты: у старых записей id не было — берём characterId, чтобы ссылки в чатах
  // и переписке остались валидными.
  const contacts = a<any>(raw.contacts)
    .filter((c) => c && (typeof c.characterId === 'string' || typeof c.id === 'string'))
    .map((c) => ({
      id: typeof c.id === 'string' && c.id ? c.id : c.characterId,
      characterId: typeof c.characterId === 'string' ? c.characterId : undefined,
      registryId: typeof c.registryId === 'string' ? c.registryId : undefined,
      name: typeof c.name === 'string' ? c.name : undefined,
      avatarAssetId: typeof c.avatarAssetId === 'string' ? c.avatarAssetId : undefined,
      chattiness: typeof c.chattiness === 'number' ? Math.max(0, Math.min(100, c.chattiness)) : undefined,
      hidden: !!c.hidden,
    }));

  // Чаты: берём новые, если есть; иначе разворачиваем старые conversations в личные
  // чаты (одна ветка = один чат с этим контактом). Переписка не теряется.
  const unread = a<any>(raw.unreadFrom).filter((x) => typeof x === 'string');
  const normMsgs = (v: unknown, peerId?: string) =>
    a<any>(v)
      .filter((m) => m && typeof m.text === 'string')
      .map((m) => ({
        // id обязателен: без него нельзя удалить конкретное сообщение.
        id: typeof m.id === 'string' && m.id ? m.id : uid('msg'),
        from: m.from === 'protagonist' ? ('protagonist' as const) : ('contact' as const),
        senderId: typeof m.senderId === 'string' ? m.senderId : m.from === 'contact' ? peerId : undefined,
        text: m.text,
        attachedAssetId: typeof m.attachedAssetId === 'string' ? m.attachedAssetId : undefined,
        photoPrompt: typeof m.photoPrompt === 'string' ? m.photoPrompt : undefined,
        // Незавершённая генерация из прошлой сессии не «висит» вечно: при загрузке
        // сейва помечаем её как неудавшуюся — из UI её можно перезапустить.
        pendingPhoto: false,
        photoFailed: !!m.photoFailed || (!!m.pendingPhoto && !m.attachedAssetId),
        at: typeof m.at === 'number' ? m.at : Date.now(),
      }));
  let chats = a<any>(raw.chats)
    .filter((c) => c && typeof c.id === 'string')
    .map((c) => ({
      id: c.id,
      kind: c.kind === 'group' ? ('group' as const) : ('direct' as const),
      title: typeof c.title === 'string' ? c.title : undefined,
      avatarAssetId: typeof c.avatarAssetId === 'string' ? c.avatarAssetId : undefined,
      participantIds: a<any>(c.participantIds).filter((x) => typeof x === 'string'),
      messages: normMsgs(c.messages, a<any>(c.participantIds)[0]),
      unread: !!c.unread,
      groupActivity: typeof c.groupActivity === 'number' ? Math.max(0, Math.min(100, c.groupActivity)) : undefined,
      topic: typeof c.topic === 'string' ? c.topic : undefined,
      archived: !!c.archived,
    }));
  if (!chats.length) {
    chats = Object.entries(conv).map(([peer, msgs]) => ({
      id: peer,
      kind: 'direct' as const,
      title: undefined,
      avatarAssetId: undefined,
      participantIds: [peer],
      messages: normMsgs(msgs, peer),
      unread: unread.includes(peer),
      groupActivity: undefined,
      topic: undefined,
      archived: false,
    }));
  }

  // ФИКС старых сейвов: раньше протагонист попадал в контакты, и в мессенджере
  // висел его чат с самим собой. Себе не пишут — вычищаем при загрузке.
  const selfIds = new Set([protagonistId].filter(Boolean) as string[]);
  const cleanContacts = contacts.filter((c) => !selfIds.has(c.id) && !selfIds.has(c.characterId || ''));
  const cleanChats = chats
    .map((c) => ({ ...c, participantIds: c.participantIds.filter((id) => !selfIds.has(id)) }))
    .filter((c) => c.kind === 'group' || c.participantIds.length > 0);

  return {
    transactions: a<any>(raw.transactions).filter((t) => t && typeof t.amount === 'number'),
    contacts: cleanContacts,
    chats: cleanChats,
    conversations: conv,
    unreadFrom: unread.filter((id) => !selfIds.has(id)),
    gallery: a<any>(raw.gallery).filter((x) => typeof x === 'string'),
    inventory: a<any>(raw.inventory).filter((it) => it && typeof it.name === 'string'),
    // Переименование: старое поле shopCache → deliveryCache.
    deliveryCache: a<any>(raw.deliveryCache ?? raw.shopCache).filter((it) => it && typeof it.name === 'string'),
    activeOrders: a<any>(raw.activeOrders).filter((o) => o && typeof o.itemId === 'string'),
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
    locations: arr<any>(raw.locations)
      .filter((l) => l && typeof l.name === 'string')
      .map((l) => ({
        id: typeof l.id === 'string' ? l.id : uid('loc'),
        name: l.name,
        description: str(l.description),
        tags: strArr(l.tags),
        source: l.source === 'manual' ? 'manual' : 'auto',
      })),
    // Реестр персонажей (patch character-registry) — из сейва; пустой строится в движке.
    registry: arr<any>(raw.registry)
      .filter((e) => e && typeof e.id === 'string' && typeof e.canonicalName === 'string')
      .map((e) => ({
        id: e.id,
        canonicalName: e.canonicalName,
        aliases: strArr(e.aliases).length ? strArr(e.aliases) : [e.canonicalName],
        role: ['protagonist', 'love_interest', 'important_character', 'npc'].includes(e.role) ? e.role : 'npc',
        status: str(e.status),
        statusLog: arr<any>(e.statusLog)
          .filter((s) => s && typeof s.status === 'string')
          .map((s) => ({ status: s.status, date: str(s.date) || undefined })),
        firstSeenDate: str(e.firstSeenDate) || undefined,
        lastSeenDate: str(e.lastSeenDate) || undefined,
        sheetId: str(e.sheetId) || undefined,
        contactId: str(e.contactId) || undefined,
        merged: strArr(e.merged),
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
    storyState: str(raw?.storyState),
    storyStateAtTurn: typeof raw?.storyStateAtTurn === 'number' ? raw.storyStateAtTurn : 0,
    foldedMsgCount: num(raw?.foldedMsgCount, 0),
    liveSummary,
    facts,
    memorybook,
    messagesSinceSummary: num(raw?.messagesSinceSummary, 0),
    rawArchive,
  };
}
