import type { Project } from '../../shared/types';

// Простой парсер слэш-команд в стиле Таверны (см. CR v2 §B.3).
export type SlashResult =
  | { kind: 'regen' }
  | { kind: 'mute' }
  | { kind: 'setBackground'; assetId: string }
  | { kind: 'move'; text: string } // отправить как ход (OOC или дословно)
  | { kind: 'help' }
  | { kind: 'none' }; // не команда

export const SLASH_HELP =
  '/bg <теги> — сменить фон · /ooc <текст> — ремарка вне сюжета · /regen — перегенерировать · /mute — звук · /help';

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
        : { kind: 'move', text: `[OOC] Смени фон на: ${arg}` };
    }
    default:
      // Неизвестная команда — трактуем как OOC-ремарку.
      return { kind: 'move', text: `[OOC] ${text.slice(1)}` };
  }
}
