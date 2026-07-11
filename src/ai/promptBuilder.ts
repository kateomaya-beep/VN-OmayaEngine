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
  const desc = (c: (typeof project.characters)[number]) => {
    const emotions = Object.keys(c.sprites);
    const emo = emotions.length ? emotions.join(', ') : '(спрайтов нет — рендер как имя+текст)';
    return `### ${c.name} (id: ${c.id}, роль: ${roleLabel[c.role] || c.role})
Внешность: ${expandMacros(c.card.appearance, ctx)}
Характер: ${expandMacros(c.card.personality, ctx)}
Предыстория: ${expandMacros(c.card.backstory, ctx)}
Манера речи: ${expandMacros(c.card.speechStyle, ctx)}${
      c.card.relationshipArc ? `\nАрка отношений: ${expandMacros(c.card.relationshipArc, ctx)}` : ''
    }
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

function memoryBlock(state: RuntimeState): string {
  const m = state.memory;
  const parts: string[] = [];
  if (m.chronicle.length) {
    parts.push(
      `ХРОНИКА (прошлые главы):\n${m.chronicle.map((c, i) => `[гл.${i + 1}] ${c}`).join('\n')}`
    );
  }
  if (m.currentChapterSummary.trim()) {
    parts.push(`ТЕКУЩАЯ ГЛАВА (начало, кратко):\n${m.currentChapterSummary}`);
  }
  if (m.facts.length) {
    const facts = m.facts.map((f) => `[гл.${f.chapter}] ${f.text}`).join('; ');
    parts.push(`КЛЮЧЕВЫЕ РЕШЕНИЯ И ФАКТЫ (канон, не искажать):\n${facts}`);
  }
  return parts.join('\n\n') || '(память пуста — это начало истории)';
}

export interface BuiltRequest {
  system: string;
  messages: LlmMessage[];
  prefill?: string;
}

export function buildRequest(
  project: Project,
  state: RuntimeState,
  playerMove: string
): BuiltRequest {
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
    `== ПАМЯТЬ ==\n${memoryBlock(state)}`,
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
