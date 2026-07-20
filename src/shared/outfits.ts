import type { Character, Emotion, OutfitSprites } from './types';

// Наряды (Batch 5.3) — открытая ось «внешний вид/костюм», независимая от закрытого
// словаря эмоций. Дефолтный набор спрайтов лежит в `character.sprites`, его тег —
// `character.defaultOutfit` (по умолчанию 'base'). Дополнительные наряды — в
// `character.outfits[]`. Все резолвы наряд+эмоция → спрайт проходят через
// resolveSprite() с fallback-цепочкой, поэтому UI/движок никогда не крашатся.

export const DEFAULT_OUTFIT = 'base';

// Тег дефолтного наряда персонажа (не пустой).
export function defaultOutfitTag(c: Character): string {
  return (c.defaultOutfit || '').trim() || DEFAULT_OUTFIT;
}

// Все теги нарядов персонажа: дефолтный первым, затем доп. (без дублей, без пустых).
export function characterOutfits(c: Character): string[] {
  const dflt = defaultOutfitTag(c);
  const extra = (c.outfits || [])
    .map((o) => (o.outfit || '').trim())
    .filter((t) => t && t !== dflt);
  return [dflt, ...Array.from(new Set(extra))];
}

// Есть ли у персонажа наряды сверх дефолтного (влияет на манифест/UI).
export function hasExtraOutfits(c: Character): boolean {
  return characterOutfits(c).length > 1;
}

// Набор спрайтов (emotion→assetId) для тега наряда. Невалидный/неизвестный тег →
// дефолтный набор (первое звено fallback-цепочки).
export function outfitSpriteMap(
  c: Character,
  outfit?: string | null
): Partial<Record<Emotion, string>> {
  const tag = (outfit || '').trim();
  if (!tag || tag === defaultOutfitTag(c)) return c.sprites;
  const found = c.outfits?.find((o) => o.outfit === tag);
  return found ? found.sprites : c.sprites; // невалидный наряд → дефолтный
}

// Fallback-цепочка (наряд ПЕРВИЧЕН): сначала полностью исчерпываем набор выбранного
// наряда, и лишь затем падаем в дефолтный. Так неполный наряд (напр. underwear без
// какой-то эмоции) всё равно показывается СВОИМ спрайтом, а не «прыгает» в дефолтную
// одежду. Порядок:
//   наряд+эмоция → neutral наряда → любой спрайт наряда
//   → дефолт+эмоция → neutral дефолта → любой дефолтный.
// Возвращает assetId или undefined (нет спрайтов вообще → рендерим имя+текст). Не бросает.
export function resolveSprite(
  c: Character,
  outfit: string | null | undefined,
  emotion: string
): string | undefined {
  const map = outfitSpriteMap(c, outfit); // невалидный наряд уже свёрнут к дефолтному
  const dmap = c.sprites; // дефолтный набор
  return (
    map[emotion as Emotion] ||
    map.neutral ||
    Object.values(map)[0] ||
    dmap[emotion as Emotion] ||
    dmap.neutral ||
    Object.values(dmap)[0]
  );
}

// Утилита для конструктора: получить/создать изменяемый набор спрайтов наряда внутри
// мутатора update(). Дефолтный наряд отражается на c.sprites.
export function ensureOutfitMap(c: Character, outfit: string): Partial<Record<Emotion, string>> {
  if (outfit === defaultOutfitTag(c)) return c.sprites;
  c.outfits = c.outfits || [];
  let o: OutfitSprites | undefined = c.outfits.find((x) => x.outfit === outfit);
  if (!o) {
    o = { outfit, sprites: {} };
    c.outfits.push(o);
  }
  return o.sprites;
}
