import type { Project, RuntimeState } from '../shared/types';
import { resolvePerson } from './characterRegistry';

// Кто СЕЙЧАС физически рядом с героем — один источник правды на весь движок.
//
// Зачем отдельно: state.onScreen — не «кто в сцене», а «последние трое, кто подавал
// голос». Никто со сцены не уходит: запись вытесняется только четвёртым говорящим.
// Поэтому персонаж, с которым герой попрощался десять ходов назад, формально всё ещё
// «на сцене» — и случайное СМС приходило от того, кто стоит рядом (а иногда наоборот:
// тот, кто давно ушёл, считался присутствующим и молчал в трубку).
//
// Отметка atTurn ставится в момент реплики, так что «рядом» = говорил на этом ходу
// или на прошлом. Одного хода паузы достаточно: люди в разговоре не обязаны
// произносить реплику каждый ход, но и уйти незаметно на два хода тоже не могут.
const PRESENCE_WINDOW = 1;

// Все id (анкета/реестр/контакт) тех, кто сейчас в сцене. Идентичность — через
// resolvePerson, иначе контакт в телефоне и персонаж на сцене были бы разными людьми.
export function presentPersonIds(project: Project, state: RuntimeState): Set<string> {
  const out = new Set<string>();
  for (const os of state.onScreen) {
    // Старые сейвы без отметки: считаем присутствующим — так осторожнее (в худшем
    // случае человек лишний раз не напишет), и отметка появится с первой же репликой.
    if (os.atTurn !== undefined && state.turnCount - os.atTurn > PRESENCE_WINDOW) continue;
    const person = resolvePerson(project, state, { id: os.characterId });
    if (person) for (const id of person.ids) out.add(id);
    else out.add(os.characterId);
  }
  return out;
}

// Имена присутствующих — для диагностики и для промпта.
export function presentNames(project: Project, state: RuntimeState): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const os of state.onScreen) {
    if (os.atTurn !== undefined && state.turnCount - os.atTurn > PRESENCE_WINDOW) continue;
    const person = resolvePerson(project, state, { id: os.characterId });
    const name = person?.name || project.characters.find((c) => c.id === os.characterId)?.name;
    if (name && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}
