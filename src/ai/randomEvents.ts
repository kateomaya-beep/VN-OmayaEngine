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

// Случайное входящее СМС (Batch 8-fix): отдельная от событий система — свой тумблер,
// шанс и кулдаун. Требует включённого телефона и хотя бы одного видимого контакта.
export interface RandomSmsRoll {
  fired: boolean;
  directive: string;
}
export function rollRandomSms(project: Project, state: RuntimeState): RandomSmsRoll {
  const none: RandomSmsRoll = { fired: false, directive: '' };
  const cfg = project.randomSms;
  if (!cfg || !cfg.enabled) return none;
  if (!project.phone?.enabled) return none;

  const contacts = (state.phone?.contacts || []).filter((c) => !c.hidden);
  if (!contacts.length) return none; // некому писать

  const since = state.turnsSinceLastSms ?? 999;
  if (since < Math.max(0, cfg.cooldownTurns)) return none;
  if (!cfg.canInterruptTenseScenes && state.currentMusicMood && TENSE_MOODS.has(state.currentMusicMood)) {
    return none;
  }
  if (Math.random() * 100 >= cfg.chancePercent) return none;

  const ids = contacts.map((c) => {
    const nm = project.characters.find((x) => x.id === c.characterId)?.name || c.characterId;
    return `${nm} (${c.characterId})`;
  });

  const directive = `[RANDOM SMS TRIGGERED]
One of the hero's saved phone contacts texts them out of the blue. Emit an "sms_incoming" beat with that contact's characterId and a short in-character message. Optionally have the hero notice/react in the scene, but the text itself must go through the sms_incoming beat.
Saved contacts who could text: ${ids.join(', ')}. Pick one that fits the current moment.
Do NOT mention that it was a random event.`;

  return { fired: true, directive };
}
