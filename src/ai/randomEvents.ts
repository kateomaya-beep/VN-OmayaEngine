import type { Project, RuntimeState, RandomEventType } from '../shared/types';

// Случайные события (Batch 6 §3): движок с заданной вероятностью подмешивает в ход
// СКРЫТУЮ директиву-событие (игрок её не видит). ИИ вплетает событие в обычный ответ.

// Настроения, считающиеся «напряжённой/интимной/кульминационной» сценой — по ним
// событие откладывается, если canInterruptTenseScenes выключен.
const TENSE_MOODS = new Set(['tense', 'scary', 'dangerous', 'romantic', 'epic']);

const EVENT_TEXT: Record<RandomEventType, string> = {
  new_npc: 'A new character enters the story.',
  new_location: 'The story moves to a new location.',
  secret_reveal:
    'A secret comes to light. Draw the secret from the existing unresolved plot hooks / lorebook — do not invent an unrelated one.',
  dramatic_event: 'Something dramatic or heavy happens.',
  unexpected_twist: 'An unexpected twist occurs.',
};

export interface RandomEventRoll {
  fired: boolean;
  directive: string; // скрытая директива для контекста хода (пусто, если не сработало)
  type?: RandomEventType;
}

// Решает, подмешивать ли событие в текущий ход. Чистая функция (кроме Math.random).
export function rollRandomEvent(project: Project, state: RuntimeState): RandomEventRoll {
  const cfg = project.randomEvents;
  const none: RandomEventRoll = { fired: false, directive: '' };
  if (!cfg || !cfg.enabled) return none;

  const since = state.turnsSinceLastEvent ?? 999;
  if (since < Math.max(0, cfg.cooldownTurns)) return none; // кулдаун

  // Не прерываем напряжённую/интимную/кульминационную сцену (по музыкальному настроению),
  // если это запрещено — откладываем до следующей проверки.
  if (!cfg.canInterruptTenseScenes && state.currentMusicMood && TENSE_MOODS.has(state.currentMusicMood)) {
    return none;
  }

  if (Math.random() * 100 >= cfg.chancePercent) return none; // не прокнуло

  const pool = cfg.types.filter((t) => t.enabled && t.weight > 0);
  if (!pool.length) return none;
  const total = pool.reduce((s, t) => s + t.weight, 0);
  let r = Math.random() * total;
  let picked = pool[0];
  for (const t of pool) {
    r -= t.weight;
    if (r <= 0) {
      picked = t;
      break;
    }
  }

  const directive = `[RANDOM EVENT TRIGGERED: ${picked.id}]
${EVENT_TEXT[picked.id]}
Weave this into your next response organically. It must fit the current story, tone and pacing — introduce it naturally as part of the narrative, never as a jarring interruption or a system announcement. Do NOT mention that it was a random event.`;

  return { fired: true, directive, type: picked.id };
}
