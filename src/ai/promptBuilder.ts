import type { Project, RuntimeState, LlmMessage, AudioMood } from '../shared/types';
import { AUDIO_MOODS } from '../shared/types';
import {
  CORE_PROMPT,
  buildStyleLayer,
  DEFAULT_JAILBREAK,
  FORMAT_REMINDER,
} from './directorPrompt';
import { matchLorebook } from './lorebookEngine';
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
  if (bg.length) sections.push(`Фоны (выбирай backgroundId по тегам):\n${bg.map(line).join('\n')}`);
  if (cg.length) sections.push(`CG (кат-сцены):\n${cg.map(line).join('\n')}`);
  if (sfx.length) sections.push(`Звуки (sfxId):\n${sfx.map(line).join('\n')}`);

  // Аудио-настроения: перечисляем словарь, помечая какие реально доступны (есть трек).
  const availableMoods = new Set<AudioMood>();
  for (const a of project.assets) if (a.type === 'music' && a.audioMood) availableMoods.add(a.audioMood);
  const moodLine = AUDIO_MOODS.map(
    (m) => `${m}${availableMoods.has(m) ? '' : ' (нет трека — не выбирать)'}`
  ).join(', ');
  sections.push(`Аудио-настроения (musicMood): ${moodLine}`);

  return sections.join('\n') || '  (нет ассетов)';
}

function characterBlocks(
  project: Project,
  onScreenIds: string[],
  ctx: MacroContext
): string {
  const roleLabel: Record<string, string> = {
    protagonist: 'ГЕРОЙ ИГРОКА',
    love_interest: 'любовный интерес',
    important_character: 'важный персонаж',
    npc: 'второстепенный',
  };
  const rels = ctx.state?.relationship || {};
  const relLine = (c: (typeof project.characters)[number]) => {
    if (c.role === 'protagonist') return '';
    const r = rels[c.id] || c.relationship;
    return `\nОтношения к ${c.name} (id для statChanges): ❤️ rel:${c.id}:affection=${r.affection}, 🔥 rel:${c.id}:passion_stat=${r.passion_stat}, 🍀 rel:${c.id}:friendship=${r.friendship} (диапазон -100..100)`;
  };
  const desc = (c: (typeof project.characters)[number]) => {
    const emotions = Object.keys(c.sprites);
    const emo = emotions.length ? emotions.join(', ') : '(спрайтов нет — рендер как имя+текст)';
    return `### ${c.name} (id: ${c.id}, роль: ${roleLabel[c.role] || c.role})
Внешность: ${expandMacros(c.card.appearance, ctx)}
Характер: ${expandMacros(c.card.personality, ctx)}
Предыстория: ${expandMacros(c.card.backstory, ctx)}
Манера речи: ${expandMacros(c.card.speechStyle, ctx)}${
      c.card.relationshipArc ? `\nАрка отношений: ${expandMacros(c.card.relationshipArc, ctx)}` : ''
    }${relLine(c)}
Доступные эмоции: ${emo}`;
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
  if (fullList.length) out += `Персонажи в фокусе (полные карточки):\n${fullList.map(desc).join('\n\n')}\n`;
  if (others.length) {
    out += `\nОстальные персонажи (кратко):\n${others
      .map((c) => `- ${c.name} (id: ${c.id}, ${c.role}): ${c.card.personality.slice(0, 80)}`)
      .join('\n')}`;
  }
  if (!fullList.length && !others.length) {
    out = '(заранее заданных персонажей нет — вводи NPC через name)';
  }
  return out;
}

function statsState(project: Project, values: Record<string, number>): string {
  if (!project.stats.length) return '(статов нет)';
  return project.stats
    .map((s) => {
      const v = values[s.id] ?? s.initial;
      return `- ${s.id} "${s.name}" = ${v} (${s.min}..${s.max})${
        s.visible ? '' : ' [скрытый]'
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
    parts.push(`ХРОНИКА (свёрнутые прошлые события):\n${m.chronicle.map((c, i) => `[${i + 1}] ${c}`).join('\n')}`);
  }
  if (m.liveSummary.trim()) {
    parts.push(`ЗАМЕТКА О ТЕКУЩЕЙ АРКЕ (от автора):\n${m.liveSummary}`);
  }
  if (m.facts.length) {
    const facts = m.facts
      .slice(-40)
      .map((f) => `[ход ${f.turn}] ${f.text}`)
      .join('; ');
    parts.push(`КЛЮЧЕВЫЕ РЕШЕНИЯ И ФАКТЫ (канон, не искажать):\n${facts}`);
  }

  // Меморибук: закреплённые записи всегда, остальные — последние по времени.
  const pinned = m.memorybook.filter((e) => e.pinned);
  const recent = m.memorybook.filter((e) => !e.pinned).slice(-10);
  const mb = [...pinned, ...recent];
  if (mb.length) {
    parts.push(`МЕМОРИБУК (важные события по ходу игры):\n${mb.map((e) => `- ${e.text}`).join('\n')}`);
  }

  // Векторный подсос релевантного из свёрнутого сырого архива (см. §E3).
  if (!skipVector && project.memoryConfig.vectorization !== 'off' && m.rawArchive.length) {
    const corpus = m.rawArchive.map((r, i) => ({ id: String(i), text: r.text }));
    const hits = await retrieveRelevant(project, playerMove, corpus, 3);
    if (hits.length) {
      parts.push(
        `РЕЛЕВАНТНОЕ ИЗ ПРОШЛОГО (найдено по смыслу хода игрока):\n${hits
          .map((h) => `- ${h.text.slice(0, 400)}`)
          .join('\n')}`
      );
    }
  }

  return parts.join('\n\n') || '(память пуста — это начало истории)';
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
    : '(нет активных записей)';

  const currentBg =
    project.assets.find((a) => a.id === state.currentBackgroundId)?.name || 'не задан';

  const protagonistLine = state.protagonistName
    ? `Имя героя игрока: ${state.protagonistName}.`
    : '';

  const dynamic = [
    `== МИР ==\n${expandMacros(project.lore.worldDescription, ctx)}\n\nПРАВИЛА ПОВЕСТВОВАНИЯ:\n${expandMacros(
      project.lore.narrativeRules,
      ctx
    )}${protagonistLine ? `\n${protagonistLine}` : ''}`,
    project.lore.plotOutline ? `== АРКА СЮЖЕТА ==\n${expandMacros(project.lore.plotOutline, ctx)}` : '',
    `== АКТИВНЫЕ ЗАПИСИ ЛОРБУКА ==\n${lorebookText}`,
    `== ПЕРСОНАЖИ ==\n${characterBlocks(project, onScreenIds, ctx)}`,
    `== МАНИФЕСТ АССЕТОВ ==\n${assetManifest(project)}`,
    `== ТЕКУЩЕЕ СОСТОЯНИЕ ==\nСтаты:\n${statsState(project, state.statValues)}\nТекущий фон: ${currentBg} (${
      state.currentBackgroundId ?? 'null'
    })\nНастроение музыки: ${state.currentMusicMood ?? 'нет'}\nНа сцене: ${
      onScreenIds.length ? onScreenIds.join(', ') : 'никого'
    }`,
    `== ПАМЯТЬ ==\n${await memoryBlock(project, state, playerMove, opts?.skipVector)}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  // Слой 1 (ядро) + Слой 2 (стиль) + Слой 3 (jailbreak, опц.) + динамика.
  const layers = [CORE_PROMPT, buildStyleLayer(cfg)];
  if (cfg.jailbreakEnabled) {
    layers.push(`РАЗРЕШЕНИЯ:\n${cfg.jailbreakPrompt?.trim() || DEFAULT_JAILBREAK}`);
  }
  layers.push(dynamic);
  const system = layers.join('\n\n');

  // Live window of verbatim history.
  const K = Math.max(2, cfg.liveWindow);
  const window = state.history.slice(-K * 2);

  const messages: LlmMessage[] = [...window];

  // Продвинутые кастомные вставки на заданной глубине от конца (author's note style).
  const blocks = (cfg.advancedBlocks || []).filter((b) => b.content.trim());
  const withMove: LlmMessage[] = [...messages, { role: 'user', content: playerMove }];
  for (const b of blocks) {
    const depth = Math.max(0, Math.floor(b.depth));
    const insertAt = Math.max(0, withMove.length - depth);
    withMove.splice(insertAt, 0, { role: 'user', content: expandMacros(b.content, ctx) });
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
    const req = await buildRequest(project, state, playerMove || '(следующий ход)', {
      skipVector: true,
    });
    const text = req.system + req.messages.map((m) => m.content).join('\n');
    return estimateTokens(text);
  } catch {
    return 0;
  }
}
