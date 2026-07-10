import type { Project, RuntimeState, LlmMessage } from '../shared/types';
import { buildDirectorPrompt } from './directorPrompt';
import { matchLorebook } from './lorebookEngine';

// Builds the full request (see ТЗ §6 & §10 ordering) as a system string plus
// the live-window history messages and the player's move.

function assetManifest(project: Project): string {
  const byType = (t: string) => project.assets.filter((a) => a.type === t);
  const line = (a: { id: string; name: string; tags: string[] }) =>
    `  - ${a.id} "${a.name}" [${a.tags.join(', ')}]`;
  const sections: string[] = [];
  const bg = byType('background');
  const mus = byType('music');
  const sfx = byType('sfx');
  const cg = byType('cg');
  if (bg.length) sections.push(`Фоны:\n${bg.map(line).join('\n')}`);
  if (mus.length) sections.push(`Музыка:\n${mus.map(line).join('\n')}`);
  if (sfx.length) sections.push(`Звуки:\n${sfx.map(line).join('\n')}`);
  if (cg.length) sections.push(`CG (кат-сцены):\n${cg.map(line).join('\n')}`);
  return sections.join('\n') || '  (нет ассетов)';
}

function characterBlocks(project: Project, onScreenIds: string[]): string {
  const present = project.characters.filter((c) => onScreenIds.includes(c.id));
  const others = project.characters.filter((c) => !onScreenIds.includes(c.id));

  const full = present.map((c) => {
    const emotions = c.sprites.map((s) => s.emotion);
    return `### ${c.name} (id: ${c.id}, роль: ${c.role})
Внешность: ${c.card.appearance}
Характер: ${c.card.personality}
Предыстория: ${c.card.backstory}
Манера речи: ${c.card.speechStyle}${c.card.relationshipArc ? `\nАрка отношений: ${c.card.relationshipArc}` : ''}
Доступные эмоции: ${emotions.length ? emotions.join(', ') : 'neutral'}`;
  });

  const brief = others.map(
    (c) => `- ${c.name} (id: ${c.id}, ${c.role}): ${c.card.personality.slice(0, 80)}`
  );

  let out = '';
  if (full.length) out += `Персонажи в сцене (полные карточки):\n${full.join('\n\n')}\n`;
  if (brief.length) out += `\nОстальные персонажи (кратко):\n${brief.join('\n')}`;
  if (!full.length && !brief.length) out = '(персонажей нет)';
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
    parts.push(`ХРОНИКА (прошлые главы):\n${m.chronicle.map((c, i) => `[гл.${i + 1}] ${c}`).join('\n')}`);
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
}

export function buildRequest(
  project: Project,
  state: RuntimeState,
  playerMove: string
): BuiltRequest {
  const onScreenIds = state.onScreen.map((s) => s.characterId);

  // Recent text for lorebook scan: last few history messages + the move.
  const recentText =
    state.history
      .slice(-project.aiConfig.maxContextMessages)
      .map((m) => m.content)
      .join('\n') +
    '\n' +
    playerMove;
  const lore = matchLorebook(project.lorebook, recentText);
  const lorebookText = lore.length
    ? lore.map((e) => `[${e.title}] ${e.content}`).join('\n')
    : '(нет активных записей)';

  const currentBg =
    project.assets.find((a) => a.id === state.currentBackgroundId)?.name || 'не задан';

  const contextBlocks = [
    `== МИР ==\n${project.lore.worldDescription}\n\nПРАВИЛА ПОВЕСТВОВАНИЯ:\n${project.lore.narrativeRules}`,
    project.lore.plotOutline ? `== АРКА СЮЖЕТА ==\n${project.lore.plotOutline}` : '',
    `== АКТИВНЫЕ ЗАПИСИ ЛОРБУКА ==\n${lorebookText}`,
    `== ПЕРСОНАЖИ ==\n${characterBlocks(project, onScreenIds)}`,
    `== МАНИФЕСТ АССЕТОВ (выбирай id по тегам) ==\n${assetManifest(project)}`,
    `== ТЕКУЩЕЕ СОСТОЯНИЕ ==\nСтаты:\n${statsState(project, state.statValues)}\nТекущий фон: ${currentBg} (${
      state.currentBackgroundId ?? 'null'
    })\nНа сцене: ${onScreenIds.length ? onScreenIds.join(', ') : 'никого'}`,
    `== ПАМЯТЬ ==\n${memoryBlock(state)}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const system = `${buildDirectorPrompt(project.aiConfig.customDirectorPrompt)}\n\n${contextBlocks}`;

  // Live window of verbatim history (see ТЗ §10 layer 3).
  const K = Math.max(2, project.aiConfig.liveWindow);
  const window = state.history.slice(-K * 2);

  const messages: LlmMessage[] = [...window, { role: 'user', content: playerMove }];

  return { system, messages };
}
