import type { InventoryItem } from '../shared/types';
import { normName } from './characterRegistry';

// ОПОЗНАНИЕ ВЕЩИ. Ровно та же болезнь, что была с людьми, только про предметы:
// движок сверял названия строкой в нижнем регистре, поэтому «платье», «Платье» и
// «платья» были тремя разными вещами, а «отдала ключи» при «ключи от машины» в
// инвентаре не делало НИЧЕГО и молча.
//
// Нормализация та же, что у людей (normName), а вот окончания свои: в названии
// вещи есть прилагательное («красное платье» → «платья красного»), которого у
// имени не бывает. Списывать их в один список с именами нельзя — «Григорий» и
// «Григория» разъехались бы. Порядок слов не важен, служебные слова выброшены.
const ITEM_ENDINGS = [
  'ыми', 'ими', 'ого', 'ему', 'ому', 'ами', 'ах', 'ях', 'ый', 'ий', 'ой', 'ая', 'яя', 'ое', 'ее',
  'ые', 'ие', 'ых', 'их', 'ым', 'им', 'ом', 'ем', 'ей', 'а', 'я', 'у', 'ю', 'е', 'и', 'ы', 'о',
];
const MIN_STEM = 3;

// Слова, которые ничего не говорят о том, ЧТО это за вещь.
const STOP_WORDS = new Set([
  'и', 'с', 'со', 'от', 'для', 'из', 'в', 'на', 'по', 'the', 'a', 'an', 'of', 'with', 'for',
]);

function stem(word: string): string {
  const w = normName(word);
  if (w.length < MIN_STEM + 1) return w;
  // Самое длинное подходящее окончание: «красного» → «красн», а не «красног».
  for (const end of ITEM_ENDINGS) {
    if (w.length - end.length >= MIN_STEM && w.endsWith(end)) return w.slice(0, -end.length);
  }
  return w;
}

/** Значимые слова названия, каждое без окончания, по алфавиту. */
function words(name: string): string[] {
  return (name || '')
    // Ведущий эмодзи/пунктуация: модель иногда пишет название вместе со значком.
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .split(/[^\p{L}\p{N}-]+/u)
    .map((w) => stem(w))
    .filter((w) => w && !STOP_WORDS.has(w))
    .sort();
}

/** Ключ вещи: «Красное платье», «платье красное», «красного платья» — один ключ. */
export function itemKey(name: string): string {
  return words(name).join(' ');
}

/**
 * Куда класть добавленное. Сверка СТРОГАЯ (полное совпадение ключа): «красное
 * платье» и «платье» — разные вещи, и складывать их в одну кучу нельзя.
 * Совпадают только написания одной и той же вещи.
 */
export function findItemForAdd(inventory: InventoryItem[], name: string): InventoryItem | undefined {
  const k = itemKey(name);
  if (!k) return undefined;
  return inventory.find((it) => itemKey(it.name) === k);
}

/**
 * Что убирать. Сверка ТЕРПИМАЯ, но не гадающая: «ключи» находят «ключи от
 * машины», если такой предмет один. Если подходит несколько — не трогаем ничего
 * (снять не ту вещь хуже, чем не снять никакую) и говорим об этом вызывающему.
 */
export function findItemForRemove(
  inventory: InventoryItem[],
  name: string
): { item?: InventoryItem; ambiguous: boolean } {
  const q = words(name);
  if (!q.length) return { ambiguous: false };
  const key = q.join(' ');

  const exact = inventory.find((it) => itemKey(it.name) === key);
  if (exact) return { item: exact, ambiguous: false };

  const qs = new Set(q);
  const partial = inventory.filter((it) => {
    const s = new Set(words(it.name));
    if (!s.size) return false;
    const qInItem = [...qs].every((w) => s.has(w));
    const itemInQ = [...s].every((w) => qs.has(w));
    return qInItem || itemInQ;
  });
  if (partial.length === 1) return { item: partial[0], ambiguous: false };
  return { ambiguous: partial.length > 1 };
}
