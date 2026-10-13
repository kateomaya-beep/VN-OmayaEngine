import type { Choice, ChoiceModeConfig, Project } from '../shared/types';
import { PHONE_BALANCE_STAT, normalizeNarrativeMode } from '../shared/types';
import type { RawChoice } from './rpResponse';
import { uid } from '../shared/utils';

// РЕЖИМ ВЫБОРА В ТЕКСТОВОМ РП. Подключается по проекту (вкладка «Выборы» в Game
// Master). Ответ остаётся прозой, а в конце модель добавляет блок <choices> с
// вариантами — они становятся кнопками под ответом. Нажатая кнопка уходит ходом
// [CHOICE]: это единственный случай, когда модель пишет действие героя сама, —
// ровно то, что выбрано, и дальше реакцию мира. Своё можно написать как обычно.

/** Включён ли режим выбора у проекта (и проект — текстовый РП). */
export function choiceModeOf(project: Project): ChoiceModeConfig | null {
  const cfg = project.choiceMode;
  return cfg?.enabled && normalizeNarrativeMode(project.mode) === 'rp' ? cfg : null;
}

/** Ресурсы, за которые можно сделать платный вариант: статы проекта и баланс телефона. */
export function payableResources(project: Project): { id: string; name: string }[] {
  const out = project.stats.map((s) => ({ id: s.id, name: s.name }));
  if (project.phone?.enabled) out.push({ id: PHONE_BALANCE_STAT, name: project.phone.currencyName || '$' });
  return out;
}

/** Варианты модели → кнопки: не больше заданного числа, цена только за известный ресурс. */
export function validateChoices(raw: RawChoice[], project: Project, cfg: ChoiceModeConfig): Choice[] {
  const res = payableResources(project);
  const byId = new Map(res.map((r) => [r.id.toLowerCase(), r.id]));
  const byName = new Map(res.map((r) => [r.name.toLowerCase(), r.id]));
  return raw.slice(0, cfg.count).map((c) => {
    let cost: Choice['cost'] = null;
    if (cfg.paid && c.cost && c.cost.amount > 0) {
      const key = c.cost.statId.toLowerCase();
      const id = byId.get(key) ?? byName.get(key);
      if (id) cost = { statId: id, amount: c.cost.amount };
    }
    return { id: uid('ch'), text: c.text.slice(0, 200), cost };
  });
}

/** Инструкция модели — в системную часть, когда режим включён. */
export function choiceModeDirective(project: Project, cfg: ChoiceModeConfig): string {
  const res = payableResources(project);
  const paid =
    cfg.paid && res.length
      ? `\n- Now and then (not every turn) make ONE option premium: a bolder or better outcome for a price. End that line with " | cost: <id> <amount>", using only: ${res
          .map((r) => `${r.id} (${r.name})`)
          .join(', ')}.`
      : '';
  return (
    `CHOICE MODE: after the story, before the status block, add exactly ${cfg.count} options for what {{user}} could do next:\n` +
    `<choices>\n${Array.from({ length: cfg.count }, (_, i) => `${i + 1}. <option>`).join('\n')}\n</choices>\n` +
    '- Each option: one short action or line from {{user}}\'s side, in the story language, up to ~15 words. Options differ in intent or tone, not wording; at least one moves the plot forward.' +
    paid +
    '\n- Options live ONLY in this block: the story itself never lists options or asks the player what to do.' +
    '\n- A move tagged [CHOICE] … is an option the player picked: write {{user}} doing exactly that (briefly, as chosen), then the world\'s response. It is the only case where you write {{user}}\'s action.'
  );
}
