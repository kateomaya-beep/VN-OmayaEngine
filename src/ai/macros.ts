import type { Project, RuntimeState } from '../shared/types';

// Narrow text-substitution macros (see доработка §9). NOT a scripting language —
// just deterministic string replacement done at context-assembly time.
//   {{protagonist}}      -> имя героя (введённое игроком) или имя protagonist-персонажа
//   {{loveInterest}}     -> имя первого персонажа-ЛИ
//   {{char:Имя}}         -> оставляет имя как есть (валидация/утилита для будущего)
//   {{stat:Имя}}         -> текущее значение стата по имени
//   {{scene}}            -> название текущего фона

export interface MacroContext {
  project: Project;
  state?: RuntimeState | null;
  protagonistName?: string;
}

export function expandMacros(text: string, ctx: MacroContext): string {
  if (!text || text.indexOf('{{') === -1) return text;
  const { project, state } = ctx;

  const protagonistChar = project.characters.find((c) => c.role === 'protagonist');
  const protagonist =
    ctx.protagonistName?.trim() ||
    state?.protagonistName?.trim() ||
    protagonistChar?.name ||
    'Герой';

  const loveInterest = project.characters.find((c) => c.role === 'love_interest')?.name || '';

  const sceneName =
    project.assets.find((a) => a.id === state?.currentBackgroundId)?.name || '';

  return text
    .replace(/\{\{\s*protagonist\s*\}\}/gi, protagonist)
    .replace(/\{\{\s*loveInterest\s*\}\}/gi, loveInterest)
    .replace(/\{\{\s*scene\s*\}\}/gi, sceneName)
    .replace(/\{\{\s*char:\s*([^}]+?)\s*\}\}/gi, (_m, name: string) => {
      const c = project.characters.find(
        (c) => c.name.toLowerCase() === name.trim().toLowerCase()
      );
      return c ? c.name : name.trim();
    })
    .replace(/\{\{\s*stat:\s*([^}]+?)\s*\}\}/gi, (_m, name: string) => {
      const stat = project.stats.find(
        (s) => s.name.toLowerCase() === name.trim().toLowerCase()
      );
      if (!stat) return name.trim();
      const v = state?.statValues[stat.id] ?? stat.initial;
      return String(v);
    });
}
