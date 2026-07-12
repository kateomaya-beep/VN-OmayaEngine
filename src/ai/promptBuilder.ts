import type { Project, RuntimeState, LlmMessage } from '../shared/types';
import { AUDIO_MOODS } from '../shared/types';
import { FORMAT_REMINDER } from './directorPrompt';
import { normalizePreset, type DynamicSource } from './promptPreset';
import { matchLorebook } from './lorebookEngine';
import { formatClock } from './gameMaster';
import { expandMacros, type MacroContext } from './macros';
import { retrieveRelevant } from './vectorEngine';
import { estimateTokens } from '../shared/utils';

// Builds the full request as a system string (layered core → style → jailbreak →
// dynamic context) plus the live-window history and the player's move.

function assetManifest(project: Project): string {
  const line = (a: { id: string; name: string; tags?: string[] }) =>
    `  - ${a.id} "${a.name}" [${(a.tags || []).join(', ')}]`;
  const sections: string[] = [];
  const bg = project.assets.filter((a) => a.type === 'background');
  const cg = project.assets.filter((a) => a.type === 'cg');
  const sfx = project.assets.filter((a) => a.type === 'sfx');
  if (bg.length) sections.push(`Backgrounds (pick backgroundId by tags):\n${bg.map(line).join('\n')}`);
  if (cg.length) sections.push(`CG (cutscenes):\n${cg.map(line).join('\n')}`);
  if (sfx.length) sections.push(`SFX (sfxId):\n${sfx.map(line).join('\n')}`);

  // Аудио-настроения: базовые + кастомные проекта (см. CR v2 §N.2), помечая
  // какие реально доступны (есть трек).
  const availableMoods = new Set<string>();
  for (const a of project.assets) if (a.type === 'music' && a.audioMood) availableMoods.add(a.audioMood);
  const allMoods = [...AUDIO_MOODS, ...project.audioMoods];
  const moodLine = allMoods
    .map((m) => `${m}${availableMoods.has(m) ? '' : ' (no track — do not pick)'}`)
    .join(', ');
  sections.push(`Audio moods (musicMood): ${moodLine}`);

  return sections.join('\n') || '  (no assets)';
}

function characterBlocks(
  project: Project,
  onScreenIds: string[],
  ctx: MacroContext
): string {
  const roleLabel: Record<string, string> = {
    protagonist: "PLAYER'S HERO",
    love_interest: 'love interest',
    important_character: 'important character',
    npc: 'minor',
  };
  const rels = ctx.state?.relationship || {};
  const relLine = (c: (typeof project.characters)[number]) => {
    if (c.role === 'protagonist') return '';
    const r = rels[c.id] || c.relationship;
    return `\nRelationship toward the hero (ids for statChanges): ❤️ rel:${c.id}:affection=${r.affection}, 🔥 rel:${c.id}:passion_stat=${r.passion_stat}, 🍀 rel:${c.id}:friendship=${r.friendship} (range -100..100)`;
  };
  const desc = (c: (typeof project.characters)[number]) => {
    const emotions = Object.keys(c.sprites);
    const emo = emotions.length ? emotions.join(', ') : '(no sprites — render as name + text)';
    return `### ${c.name} (id: ${c.id}, role: ${roleLabel[c.role] || c.role})
Appearance: ${expandMacros(c.card.appearance, ctx)}
Personality: ${expandMacros(c.card.personality, ctx)}
Backstory: ${expandMacros(c.card.backstory, ctx)}
Speech style: ${expandMacros(c.card.speechStyle, ctx)}${
      c.card.relationshipArc ? `\nRelationship arc: ${expandMacros(c.card.relationshipArc, ctx)}` : ''
    }${relLine(c)}
Available emotions: ${emo}`;
  };

  const present = project.characters.filter((c) => onScreenIds.includes(c.id));
  const protagonist = project.characters.find(
    (c) => c.role === 'protagonist' && !present.includes(c)
  );
  const fullList = protagonist ? [protagonist, ...present] : present;
  const others = project.characters.filter(
    (c) => !fullList.includes(c)
  );

  let out = '';
  if (fullList.length) out += `Characters in focus (full cards):\n${fullList.map(desc).join('\n\n')}\n`;
  if (others.length) {
    out += `\nOther characters (brief):\n${others
      .map((c) => `- ${c.name} (id: ${c.id}, ${c.role}): ${c.card.personality.slice(0, 80)}`)
      .join('\n')}`;
  }
  if (!fullList.length && !others.length) {
    out = '(no predefined characters — introduce NPCs via name)';
  }
  return out;
}

function statsState(project: Project, values: Record<string, number>): string {
  if (!project.stats.length) return '(no stats)';
  return project.stats
    .map((s) => {
      const v = values[s.id] ?? s.initial;
      return `- ${s.id} "${s.name}" = ${v} (${s.min}..${s.max})${
        s.visible ? '' : ' [hidden]'
      }: ${s.description}`;
    })
    .join('\n');
}

async function memoryBlock(
  project: Project,
  state: RuntimeState,
  playerMove: string,
  skipVector?: boolean
): Promise<string> {
  const m = state.memory;
  const parts: string[] = [];
  if (m.chronicle.length) {
    parts.push(`CHRONICLE (compressed past events):\n${m.chronicle.map((c, i) => `[${i + 1}] ${c.text}`).join('\n')}`);
  }
  if (m.liveSummary.trim()) {
    parts.push(`CURRENT ARC NOTE (from the author):\n${m.liveSummary}`);
  }
  if (m.facts.length) {
    const facts = m.facts
      .slice(-40)
      .map((f) => `[turn ${f.turn}] ${f.text}`)
      .join('; ');
    parts.push(`KEY DECISIONS AND FACTS (canon — do not distort):\n${facts}`);
  }

  // Меморибук: закреплённые записи всегда, остальные — последние по времени.
  const pinned = m.memorybook.filter((e) => e.pinned);
  const recent = m.memorybook.filter((e) => !e.pinned).slice(-10);
  const mb = [...pinned, ...recent];
  if (mb.length) {
    parts.push(`MEMORYBOOK (important events so far):\n${mb.map((e) => `- ${e.text}`).join('\n')}`);
  }

  // Векторный подсос релевантного из свёрнутого сырого архива (см. §E3).
  if (!skipVector && project.memoryConfig.vectorization !== 'off' && m.rawArchive.length) {
    const corpus = m.rawArchive.map((r, i) => ({ id: String(i), text: r.text }));
    const hits = await retrieveRelevant(project, playerMove, corpus, 3);
    if (hits.length) {
      parts.push(
        `RELEVANT FROM THE PAST (matched to the player move):\n${hits
          .map((h) => `- ${h.text.slice(0, 400)}`)
          .join('\n')}`
      );
    }
  }

  return parts.join('\n\n') || '(memory is empty — this is the start of the story)';
}

// Компактный дамп состояния Game Master для контекста ИИ (Horae-подобная память):
// часы, досье персонажей тегами, сетка отношений, открытые задачи, последние события.
function gameMasterBlock(state: RuntimeState): string {
  const gm = state.gm;
  const parts: string[] = [];
  const clockStr = formatClock(gm.clock);
  if (clockStr) parts.push(`Now: ${clockStr}`);
  if (gm.characters.length) {
    const lines = gm.characters.map((c) => {
      const bits = [
        c.roleToHero && `to hero: ${c.roleToHero}`,
        c.status && `status: ${c.status}`,
        c.mood && `mood: ${c.mood}`,
        c.outfit && `outfit: ${c.outfit}`,
        c.location && `at: ${c.location}`,
      ].filter(Boolean);
      const tags = c.tags.length ? ` [${c.tags.join(', ')}]` : '';
      const dossier = c.dossier ? ` — ${c.dossier}` : '';
      return `- ${c.name}${dossier}${bits.length ? ` (${bits.join('; ')})` : ''}${tags}`;
    });
    parts.push(`Characters (dossiers):\n${lines.join('\n')}`);
  }
  if (gm.relations.length) {
    parts.push(
      `Relationship grid:\n${gm.relations.map((r) => `- ${r.from} → ${r.to}: ${r.label}`).join('\n')}`
    );
  }
  const openTasks = gm.agenda.filter((t) => !t.done);
  if (openTasks.length) {
    parts.push(`Open agenda:\n${openTasks.map((t) => `- ${t.text}`).join('\n')}`);
  }
  if (gm.events.length) {
    const recent = gm.events.slice(-6);
    parts.push(
      `Recent events (chronological):\n${recent
        .map((e) => `- ${e.date ? `[${e.date}] ` : `[t${e.turn}] `}${e.summary}${e.chars.length ? ` (${e.chars.join(', ')})` : ''}`)
        .join('\n')}`
    );
  }
  return parts.length
    ? parts.join('\n\n')
    : '(no game-master state yet — establish it via worldState this turn)';
}

export interface BuiltRequest {
  system: string;
  messages: LlmMessage[];
  prefill?: string;
}

export async function buildRequest(
  project: Project,
  state: RuntimeState,
  playerMove: string,
  opts?: { skipVector?: boolean }
): Promise<BuiltRequest> {
  const cfg = project.aiConfig;
  const ctx: MacroContext = { project, state };
  const onScreenIds = state.onScreen.map((s) => s.characterId);

  const recentText =
    state.history
      .slice(-cfg.maxContextMessages)
      .map((m) => m.content)
      .join('\n') +
    '\n' +
    playerMove;
  const lore = matchLorebook(project.lorebook, recentText);
  const lorebookText = lore.length
    ? lore.map((e) => `[${e.title}] ${expandMacros(e.content, ctx)}`).join('\n')
    : '(no active entries)';

  const currentBg =
    project.assets.find((a) => a.id === state.currentBackgroundId)?.name || 'not set';

  const protagonistLine = state.protagonistName
    ? `The player's hero is named: ${state.protagonistName}.`
    : '';

  // Content generators for the preset's dynamic blocks.
  const dynamicContent: Record<DynamicSource, () => Promise<string> | string> = {
    world: () =>
      `== WORLD ==\n${expandMacros(project.lore.worldDescription, ctx)}\n\nNARRATIVE RULES:\n${expandMacros(
        project.lore.narrativeRules,
        ctx
      )}${protagonistLine ? `\n${protagonistLine}` : ''}`,
    plot: () =>
      project.lore.plotOutline ? `== PLOT ARC ==\n${expandMacros(project.lore.plotOutline, ctx)}` : '',
    lorebook: () => `== ACTIVE LOREBOOK ENTRIES ==\n${lorebookText}`,
    characters: () => `== CHARACTERS ==\n${characterBlocks(project, onScreenIds, ctx)}`,
    manifest: () => `== ASSET MANIFEST ==\n${assetManifest(project)}`,
    state: () =>
      `== CURRENT STATE ==\nStats:\n${statsState(project, state.statValues)}\nCurrent background: ${currentBg} (${
        state.currentBackgroundId ?? 'null'
      })\nMusic mood: ${state.currentMusicMood ?? 'none'}\nOn screen: ${
        onScreenIds.length ? onScreenIds.join(', ') : 'nobody'
      }`,
    memory: async () => `== MEMORY ==\n${await memoryBlock(project, state, playerMove, opts?.skipVector)}`,
    gamemaster: () => gameMasterBlock(state),
  };

  // Собираем промпт из редактируемого пресета (Batch 3 §8): по порядку, только
  // включённые блоки; статичные — их текст (с макросами), динамические — от движка.
  // Роль блока (как в Таверне): 'system' идёт в системный промпт; 'user'/'assistant'
  // становятся отдельными сообщениями ПЕРЕД живой историей.
  const preset = normalizePreset(cfg.promptPreset);
  const systemParts: string[] = [];
  const presetMessages: LlmMessage[] = [];
  for (const block of preset.blocks) {
    if (!block.enabled) continue;
    let text: string;
    if (block.dynamic) {
      const gen = dynamicContent[block.dynamic];
      text = gen ? await gen() : '';
    } else {
      text = expandMacros(block.content, ctx);
    }
    if (!text.trim()) continue;
    const role = block.role || 'system';
    if (role === 'system') systemParts.push(text);
    else presetMessages.push({ role, content: text });
  }
  const system = systemParts.join('\n\n');

  // Live window of verbatim history.
  const K = Math.max(2, cfg.liveWindow);
  const window = state.history.slice(-K * 2);

  const messages: LlmMessage[] = [...presetMessages, ...window];

  // Продвинутые кастомные вставки на заданной глубине от конца (author's note style).
  const blocks = (cfg.advancedBlocks || []).filter((b) => b.content.trim());
  const withMove: LlmMessage[] = [...messages, { role: 'user', content: playerMove }];
  for (const b of blocks) {
    const depth = Math.max(0, Math.floor(b.depth));
    const insertAt = Math.max(0, withMove.length - depth);
    withMove.splice(insertAt, 0, { role: 'user', content: expandMacros(b.content, ctx) });
  }

  // Заметка для ИИ (Author's Note, см. CR v2 §M) — тот же слот глубины 0, что и
  // кастомные вставки Блока F, но со своим UI. Пусто — ничего не инжектится.
  if (state.authorNote.trim()) {
    withMove.push({ role: 'user', content: `[AUTHOR NOTE] ${expandMacros(state.authorNote, ctx)}` });
  }

  // Ремайндер формата на глубине 0 (в самый конец).
  withMove.push({ role: 'user', content: FORMAT_REMINDER });

  return { system, messages: withMove, prefill: cfg.prefill?.trim() || undefined };
}

// Живой счётчик токенов/контекста (см. CR v2 §J) — считает по РЕАЛЬНО собранному
// промпту (без векторного подсоса, чтобы не гонять эмбеддинги ради индикатора).
export async function estimateContextTokens(
  project: Project,
  state: RuntimeState,
  playerMove: string
): Promise<number> {
  try {
    const req = await buildRequest(project, state, playerMove || '(next turn)', {
      skipVector: true,
    });
    const text = req.system + req.messages.map((m) => m.content).join('\n');
    return estimateTokens(text);
  } catch {
    return 0;
  }
}
