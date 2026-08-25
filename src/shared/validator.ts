import type { Project } from './types';
import { normalizeNarrativeMode } from './types';

export interface ValidationIssue {
  level: 'error' | 'warning';
  message: string;
}

// Project validator run before play (see ТЗ §5.6).
// Sprites are optional for every role now (единое правило отрисовки: нет спрайта →
// имя+текст), so missing sprites are warnings, never errors.
// В режиме классического РП половина проверок бессмысленна: там нет ни сцены со
// спрайтами, ни фонов, ни музыки — и «нет ни одного фона» блокировало бы запуск
// текстовой истории, которой фон не нужен вовсе.
export function validateProject(project: Project): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const rp = normalizeNarrativeMode(project.mode) === 'rp';

  if (!project.lore.openingScene.trim()) {
    issues.push({ level: 'error', message: 'Не задана стартовая сцена (Лор → Стартовая сцена).' });
  }
  if (!project.lore.worldDescription.trim()) {
    issues.push({ level: 'warning', message: 'Пустое описание мира — ИИ будет импровизировать.' });
  }

  const backgrounds = project.assets.filter((a) => a.type === 'background');
  if (!rp && backgrounds.length === 0) {
    issues.push({ level: 'error', message: 'Нет ни одного фона.' });
  }

  // Персонаж, у которого есть хоть какие-то спрайты, должен иметь neutral (fallback).
  for (const c of rp ? [] : project.characters) {
    const emotions = Object.keys(c.sprites);
    if (emotions.length > 0 && !c.sprites.neutral) {
      issues.push({
        level: 'warning',
        message: `У «${c.name}» есть спрайты, но нет neutral (используется как fallback).`,
      });
    }
    // Доп. наряд со спрайтами без своего neutral — подстрахуется дефолтным нарядом,
    // но лучше залить (Batch 5.3).
    for (const o of c.outfits || []) {
      const es = Object.keys(o.sprites);
      if (es.length > 0 && !o.sprites.neutral) {
        issues.push({
          level: 'warning',
          message: `У наряда «${o.outfit}» персонажа «${c.name}» нет neutral (откат на дефолтный наряд).`,
        });
      }
    }
  }

  const loveInterests = rp ? [] : project.characters.filter((c) => c.role === 'love_interest');
  for (const li of loveInterests) {
    if (Object.keys(li.sprites).length === 0) {
      issues.push({
        level: 'warning',
        message: `У ЛИ «${li.name}» нет спрайтов — реплики будут рендериться как имя + текст.`,
      });
    }
  }

  if (project.characters.length === 0) {
    issues.push({ level: 'warning', message: 'В проекте нет персонажей.' });
  }

  // Untagged backgrounds/CG matter (ИИ выбирает их по тегам); музыка — по настроению.
  const untagged = rp
    ? []
    : project.assets.filter(
        (a) => (a.type === 'background' || a.type === 'cg') && (!a.tags || a.tags.length === 0)
      );
  if (untagged.length) {
    issues.push({
      level: 'warning',
      message: `${untagged.length} фон(ов)/CG без тегов — ИИ не сможет их осознанно выбрать.`,
    });
  }

  const musicNoMood = rp ? [] : project.assets.filter((a) => a.type === 'music' && !a.audioMood);
  if (musicNoMood.length) {
    issues.push({
      level: 'warning',
      message: `${musicNoMood.length} трек(ов) без настроения — ИИ не сможет их подобрать.`,
    });
  }

  if (!rp && project.stats.length === 0) {
    issues.push({ level: 'warning', message: 'Нет статов — механики влияния выборов отключены.' });
  }

  return issues;
}
