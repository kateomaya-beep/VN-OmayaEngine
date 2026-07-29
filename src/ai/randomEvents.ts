import type { Project, RuntimeState, RandomEventType } from '../shared/types';
import { logEvent } from '../shared/logStore';

// Случайные события (Batch 6 §3): движок с заданной вероятностью подмешивает в ход
// СКРЫТУЮ директиву-событие (игрок её не видит). ИИ вплетает событие в обычный ответ.

// Настроения, считающиеся «напряжённой/интимной/кульминационной» сценой — по ним
// СЮЖЕТНОЕ событие откладывается, если canInterruptTenseScenes выключен.
const TENSE_MOODS = new Set(['tense', 'scary', 'dangerous', 'romantic', 'epic']);

// Для ВХОДЯЩЕГО СМС список у́же: жужжание телефона — не полноценное вторжение в сцену,
// а в романтической/эпической сцене оно даже работает на драму. Раньше здесь
// использовался общий список, куда входят romantic и epic, — в романтической новелле
// настроение почти всегда romantic, и СМС блокировались практически каждый ход
// (симптом: «триггер включён, а сообщения не приходят»).
const SMS_BLOCKING_MOODS = new Set(['tense', 'scary', 'dangerous']);

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
  // Диагностика: почему СМС не пришло — видно в панели логов, а не гадаем.
  const skip = (why: string): RandomSmsRoll => {
    logEvent('info', 'sms', `Случайное СМС не сработало: ${why}`);
    return none;
  };
  const cfg = project.randomSms;
  if (!cfg || !cfg.enabled) return none; // выключено — молчим, это норма
  if (!project.phone?.enabled) return skip('расширение «Телефон» выключено');

  // Кандидаты: контакты телефона, а если их ещё нет — знакомые персонажи проекта
  // (ЛИ/важные). Иначе фича молчала до первой реплики, добавляющей контакт, и юзер
  // видел «триггер включён, а сообщений нет».
  const contactIds = (state.phone?.contacts || []).filter((c) => !c.hidden).map((c) => c.characterId);
  const candidates = contactIds.length
    ? contactIds
    : project.characters
        .filter((c) => c.role === 'love_interest' || c.role === 'important_character')
        .map((c) => c.id);
  if (!candidates.length) return skip('нет контактов и подходящих персонажей — некому писать');

  const since = state.turnsSinceLastSms ?? 999;
  const cd = Math.max(0, cfg.cooldownTurns);
  if (since < cd) return skip(`кулдаун (${since} из ${cd} ходов)`);
  if (
    !cfg.canInterruptTenseScenes &&
    state.currentMusicMood &&
    SMS_BLOCKING_MOODS.has(state.currentMusicMood)
  ) {
    return skip(`напряжённая сцена (настроение «${state.currentMusicMood}»)`);
  }
  if (Math.random() * 100 >= cfg.chancePercent) return skip(`не выпал шанс (${cfg.chancePercent}%)`);

  const ids = candidates.map((id) => {
    const nm = project.characters.find((x) => x.id === id)?.name || id;
    return `${nm} (${id})`;
  });

  const directive = `[RANDOM SMS TRIGGERED — REQUIRED THIS TURN]
Someone the hero knows texts them out of the blue. You MUST include a control beat
{"type":"sms_incoming","characterId":"<id>","text":"<short in-character message>"} in this turn's beats.
Use the EXACT characterId from this list: ${ids.join(', ')}. Pick whoever fits the current moment.
The hero may notice the phone buzz in the narration, but the message text itself MUST go through the sms_incoming beat.
Do NOT mention that it was a random event.`;

  return { fired: true, directive };
}
