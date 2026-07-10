import type { Project } from './types';

export interface ValidationIssue {
  level: 'error' | 'warning';
  message: string;
}

// Project validator run before play (see ТЗ §5.6).
export function validateProject(project: Project): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!project.lore.openingScene.trim()) {
    issues.push({ level: 'error', message: 'Не задана стартовая сцена (Лор → Стартовая сцена).' });
  }
  if (!project.lore.worldDescription.trim()) {
    issues.push({ level: 'warning', message: 'Пустое описание мира — ИИ будет импровизировать.' });
  }

  const backgrounds = project.assets.filter((a) => a.type === 'background');
  if (backgrounds.length === 0) {
    issues.push({ level: 'error', message: 'Нет ни одного фона.' });
  }

  const loveInterests = project.characters.filter((c) => c.role === 'love_interest');
  for (const li of loveInterests) {
    if (li.sprites.length === 0) {
      issues.push({ level: 'error', message: `У ЛИ «${li.name}» нет спрайтов.` });
    } else if (!li.sprites.some((s) => s.emotion === 'neutral')) {
      issues.push({
        level: 'warning',
        message: `У «${li.name}» нет спрайта neutral (используется как fallback).`,
      });
    }
  }

  if (project.characters.length === 0) {
    issues.push({ level: 'warning', message: 'В проекте нет персонажей.' });
  }

  const untagged = project.assets.filter((a) => a.tags.length === 0);
  if (untagged.length) {
    issues.push({
      level: 'warning',
      message: `${untagged.length} ассет(ов) без тегов — ИИ не сможет их осознанно выбрать.`,
    });
  }

  if (project.stats.length === 0) {
    issues.push({ level: 'warning', message: 'Нет статов — механики влияния выборов отключены.' });
  }

  return issues;
}
