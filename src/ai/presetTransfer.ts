import { uid } from '../shared/utils';
import type { NarrativeMode } from '../shared/types';
import type { PromptBlock, PromptPreset } from './promptPreset';
import type { AltRpPreset, CopyBase } from './altPresets';
import { MODEL_PROFILES, type PresetSettings, type PresetSlot } from './presetSettings';

// ПЕРЕНОС БЛОКА МЕЖДУ ПРЕСЕТАМИ И КОПИЯ ПРЕСЕТА.
//
// Блок переносится целиком — текст, роль, вкл/выкл, глубина вставки, ключ
// встроенного блока (по нему строится план размышления и работает «↺») — и
// встаёт на то же место ОТНОСИТЕЛЬНО ПОСТОЯННЫХ БЛОКОВ: блоков движка, «Истории
// переписки», встроенных модулей. Их порядок в пресетах свой, поэтому индекс
// «пятый сверху» ничего не значит; значат соседи. Ищем ближайший постоянный
// блок над переносимым и под ним, которые есть и в целевом пресете, и ставим
// блок между ними — ближе к тому, к которому он стоял ближе. Так блок, стоявший
// под историей, останется под историей, а стоявший сразу за «Миром», — за «Миром».

/** Постоянный блок: тот, что узнаётся в любом пресете (движок, история, встроенные). */
function anchorKey(b: PromptBlock): string | null {
  if (b.dynamic) return `dyn:${b.dynamic}`;
  if (b.builtinKey) return `bk:${b.builtinKey}`;
  return null;
}

/** Куда вставить блок из source в target, чтобы соседи остались теми же. */
export function placementIndex(source: PromptPreset, blockId: string, target: PromptPreset): number {
  const si = source.blocks.findIndex((b) => b.id === blockId);
  if (si < 0) return target.blocks.length;
  const where = new Map<string, number>();
  target.blocks.forEach((b, i) => {
    const k = anchorKey(b);
    if (k && !where.has(k)) where.set(k, i);
  });
  let up = -1;
  let upDist = 0;
  for (let i = si - 1; i >= 0; i--) {
    const k = anchorKey(source.blocks[i]);
    if (k && where.has(k)) {
      up = where.get(k)!;
      upDist = si - i;
      break;
    }
  }
  let down = -1;
  let downDist = 0;
  for (let i = si + 1; i < source.blocks.length; i++) {
    const k = anchorKey(source.blocks[i]);
    if (k && where.has(k)) {
      down = where.get(k)!;
      downDist = i - si;
      break;
    }
  }
  if (up >= 0 && down > up) return upDist <= downDist ? up + 1 : down;
  if (up >= 0) return up + 1;
  if (down >= 0) return down;
  return target.blocks.length;
}

/** Такой же встроенный блок в целевом пресете — с ним конфликт «заменить или копией». */
export function sameBlockIn(target: PromptPreset, block: PromptBlock): PromptBlock | undefined {
  return block.builtinKey ? target.blocks.find((b) => b.builtinKey === block.builtinKey) : undefined;
}

export type TransferResult = { preset: PromptPreset; how: 'added' | 'replaced' | 'copied' };

/**
 * Перенести блок. Если в целевом пресете уже есть такой же встроенный блок:
 * replace=true — заменить его (на его же месте), иначе добавить копией без ключа.
 */
export function transferBlock(source: PromptPreset, blockId: string, target: PromptPreset, replace = false): TransferResult {
  const block = source.blocks.find((b) => b.id === blockId);
  if (!block) return { preset: target, how: 'added' };
  const { id: _id, ...rest } = block;
  const twin = sameBlockIn(target, block);
  if (twin && replace) {
    return {
      preset: { ...target, blocks: target.blocks.map((b) => (b.id === twin.id ? { ...rest, id: twin.id } : b)) },
      how: 'replaced',
    };
  }
  const copy: PromptBlock = twin
    ? { ...rest, id: uid('blk'), name: `${block.name} (копия)`, builtinKey: undefined }
    : { ...rest, id: uid('blk') };
  if (!copy.builtinKey) delete copy.builtinKey;
  const at = placementIndex(source, blockId, target);
  const blocks = [...target.blocks];
  blocks.splice(at, 0, copy);
  return { preset: { ...target, blocks }, how: twin ? 'copied' : 'added' };
}

// ── Куда можно перенести ──────────────────────────────────────────────────────

export interface PresetTarget {
  slot: PresetSlot;
  label: string;
  preset: PromptPreset;
}

const slotEq = (a: PresetSlot, b: PresetSlot) => a.kind === b.kind && (a.kind !== 'alt' || (b.kind === 'alt' && a.id === b.id));

/** Все пресеты этого режима, кроме текущего: стандартные (по профилям) и альтернативные. */
export function presetTargets(s: PresetSettings, mode: NarrativeMode, current: PresetSlot): PresetTarget[] {
  const prof = (id: string) => MODEL_PROFILES.find((p) => p.id === id)?.label ?? id;
  const out: PresetTarget[] =
    mode === 'rp'
      ? [
          { slot: { kind: 'rp' }, label: `OmayaEngine — стандартный (${prof('universal')})`, preset: s.rpPreset },
          { slot: { kind: 'deepseek' }, label: `OmayaEngine — стандартный (${prof('deepseek')})`, preset: s.deepseekPreset },
          { slot: { kind: 'local' }, label: `OmayaEngine — стандартный (${prof('local')})`, preset: s.localPreset },
        ]
      : [{ slot: { kind: 'vn' }, label: 'OmayaEngine — стандартный', preset: s.preset }];
  for (const a of s.altRpPresets) {
    if (a.mode === (mode === 'rp' ? 'rp' : 'vn')) out.push({ slot: { kind: 'alt', id: a.id }, label: a.name, preset: a.preset });
  }
  return out.filter((t) => !slotEq(t.slot, current));
}

// ── Копия пресета ─────────────────────────────────────────────────────────────

/**
 * Новый альтернативный пресет на основе текущего. Копия стандартного — пресет
 * движка (как «Открытый мир»: своя выборка не подменяется, размышление работает);
 * копия альтернативного — со всей его выборкой, регулярками и префиллом.
 */
export function copyPreset(
  from: { alt: AltRpPreset | null; preset: PromptPreset; base: CopyBase; mode: NarrativeMode },
  name: string
): AltRpPreset {
  const clone = JSON.parse(JSON.stringify(from.preset)) as PromptPreset;
  const preset: PromptPreset = { ...clone, id: uid('preset'), name, blocks: clone.blocks.map((b) => ({ ...b, id: uid('blk') })) };
  if (from.alt) {
    const a = JSON.parse(JSON.stringify(from.alt)) as AltRpPreset;
    return { ...a, id: `alt_${uid('copy')}`, name, preset, copyOf: a.copyOf ?? a.source, importedAt: Date.now() };
  }
  delete preset.foreign;
  return {
    id: `alt_${uid('copy')}`,
    name,
    source: 'omaya',
    mode: from.mode === 'rp' ? 'rp' : 'vn',
    preset,
    regexRules: [],
    sampling: {},
    copyOf: from.base,
    importedAt: Date.now(),
  };
}
