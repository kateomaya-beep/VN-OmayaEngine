import type { Project, RandomEventType } from '../../shared/types';

// Простой парсер слэш-команд в стиле Таверны (см. CR v2 §B.3).
export type SlashResult =
  | { kind: 'regen' }
  | { kind: 'mute' }
  | { kind: 'setBackground'; assetId: string }
  | { kind: 'move'; text: string } // отправить как ход (OOC или дословно)
  // Событие по требованию: ход генерируется сразу и с гарантированным событием.
  // text — ход игрока; пусто = просто продолжить сцену.
  | { kind: 'event'; type?: RandomEventType; text: string }
  | { kind: 'help' }
  | { kind: 'none' }; // не команда

export const SLASH_HELP =
  '/event [тип] [ваш ход] — событие прямо сейчас (типы: npc, место, секрет, драма, поворот) · ' +
  '/bg <теги> — сменить фон · /ooc <текст> — ремарка вне сюжета · /regen — перегенерировать · /mute — звук · /help';

// Синонимы типов события — по-русски и по-английски: команду набирают на бегу, и
// заставлять вспоминать внутренний идентификатор (new_npc) незачем.
const EVENT_ALIASES: Record<string, RandomEventType> = {
  npc: 'new_npc', перс: 'new_npc', персонаж: 'new_npc', человек: 'new_npc', new_npc: 'new_npc',
  место: 'new_location', локация: 'new_location', location: 'new_location', new_location: 'new_location',
  секрет: 'secret_reveal', тайна: 'secret_reveal', secret: 'secret_reveal', secret_reveal: 'secret_reveal',
  драма: 'dramatic_event', drama: 'dramatic_event', dramatic_event: 'dramatic_event',
  поворот: 'unexpected_twist', твист: 'unexpected_twist', twist: 'unexpected_twist',
  unexpected_twist: 'unexpected_twist',
};

export function parseSlash(input: string, project: Project): SlashResult {
  const text = input.trim();
  if (!text.startsWith('/')) return { kind: 'none' };

  const sp = text.indexOf(' ');
  const cmd = (sp === -1 ? text.slice(1) : text.slice(1, sp)).toLowerCase();
  const arg = sp === -1 ? '' : text.slice(sp + 1).trim();

  switch (cmd) {
    case 'regen':
    case 'regenerate':
      return { kind: 'regen' };
    case 'mute':
      return { kind: 'mute' };
    case 'help':
    case '?':
      return { kind: 'help' };
    // СОБЫТИЕ ПО ТРЕБОВАНИЮ. Первое слово после команды может быть типом события —
    // тогда оно не считается частью хода. Остаток (или пустота) уходит ходом:
    // «/event» — просто продолжить сцену с событием, «/event драма выхожу на улицу»
    // — событие вплетается в этот самый ход игрока.
    case 'event':
    case 'событие':
    case 'ивент': {
      const words = arg.split(/\s+/).filter(Boolean);
      const first = words[0]?.toLowerCase();
      const type = first ? EVENT_ALIASES[first] : undefined;
      const text = (type ? words.slice(1) : words).join(' ');
      return { kind: 'event', type, text };
    }
    case 'ooc':
      return arg ? { kind: 'move', text: `[OOC] ${arg}` } : { kind: 'help' };
    case 'bg':
    case 'background': {
      if (!arg) return { kind: 'help' };
      // Ищем фон по тегам/имени; нашли — переключаем локально, нет — просим ИИ через OOC.
      const q = arg.toLowerCase();
      const bg = project.assets.find(
        (a) =>
          a.type === 'background' &&
          (a.name.toLowerCase().includes(q) ||
            (a.tags || []).some((t) => t.toLowerCase().includes(q)))
      );
      return bg
        ? { kind: 'setBackground', assetId: bg.id }
        : { kind: 'move', text: `[OOC] Change the background to: ${arg}` };
    }
    default:
      // Неизвестная команда — трактуем как OOC-ремарку.
      return { kind: 'move', text: `[OOC] ${text.slice(1)}` };
  }
}
