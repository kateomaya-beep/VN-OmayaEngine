import { uid } from '../shared/utils';
import { defaultPreset, OUTDATED_SIGNATURES, refreshBuiltins, type DynamicSource, type PromptBlock, type PromptPreset } from './promptPreset';
import { defaultRpPreset, RP_OUTDATED_SIGNATURES } from './rpPreset';

// БЛОКИ ДВИЖКА В ЧУЖОМ ПРЕСЕТЕ. Пресет из Таверны ничего не знает о наших
// плюшках: JSON-контракте новеллы, сводке состояния для Game Master, пометках хода,
// эмоциях спрайтов. Без них ход в новелле не разберётся вовсе, а в РП перестанут
// идти часы, досье и память. Поэтому у любого импортированного пресета эти блоки
// есть всегда:
//  - при импорте ставятся на свои места;
//  - при каждой загрузке настроек недостающие добавляются (появился у движка
//    новый блок — он доедет и до старых импортов);
//  - нетронутые обновляются вместе с движком, правленые остаются как есть.
// Это обычные блоки: их можно выключить, но не потерять.

export type EngineMode = 'rp' | 'vn';

interface EngineDef {
  key: string;
  name: string;
  enabled: boolean;
  /** start — в начало, до правил пресета; contract — последним перед историей. */
  at: 'start' | 'contract';
}

const RP_ENGINE: EngineDef[] = [
  { key: 'rp_moves', name: '⚙ Движок: пометки хода игрока', enabled: true, at: 'start' },
  { key: 'rp_state', name: '⚙ Движок: служебная сводка состояния', enabled: true, at: 'start' },
  // У чужого пресета свои правила о том, кто пишет за героя, и свой формат реплик —
  // наши только как опция.
  { key: 'rp_no_impersonation', name: '⚙ Движок: не писать за игрока', enabled: false, at: 'start' },
  { key: 'rp_format', name: '⚙ Движок: правила форматирования', enabled: false, at: 'start' },
];

const VN_ENGINE: EngineDef[] = [
  { key: 'roles', name: '⚙ Движок: роли и отрисовка', enabled: true, at: 'start' },
  { key: 'emotions', name: '⚙ Движок: эмоции спрайтов', enabled: true, at: 'start' },
  { key: 'audio', name: '⚙ Движок: музыка', enabled: true, at: 'start' },
  { key: 'relationships', name: '⚙ Движок: отношения (статы)', enabled: true, at: 'start' },
  { key: 'protagonist_voicing', name: '⚙ Движок: пометки хода игрока', enabled: true, at: 'start' },
  { key: 'rules', name: '⚙ Движок: правила хода и выборы', enabled: true, at: 'start' },
  // Контракт — последним перед историей: правила прозы у пресета свои, но ответ
  // обязан прийти JSON-объектом, и это модель должна прочесть ближе всего к ходу.
  { key: 'json_contract', name: '⚙ Движок: JSON-контракт ответа', enabled: true, at: 'contract' },
];

// Наши динамические блоки — без них нет мира, карточек, памяти и Game Master.
const DYNAMICS: Record<EngineMode, DynamicSource[]> = {
  rp: ['world', 'lorebook', 'characters', 'state', 'gamemaster', 'memorybook', 'memory'],
  vn: ['world', 'lorebook', 'characters', 'manifest', 'state', 'gamemaster', 'memorybook', 'memory'],
};

const DYN_NAMES: Partial<Record<DynamicSource, string>> = {
  world: '↳ Мир и правила',
  lorebook: '↳ Лорбук',
  characters: '↳ Персонажи',
  manifest: '↳ Ассеты (фоны, спрайты, музыка)',
  state: '↳ Текущее состояние',
  gamemaster: '↳ Game Master',
  memorybook: '↳ Меморибук',
  memory: '↳ Память движка',
  history: '💬 История переписки',
};

export function engineKeys(mode: EngineMode): string[] {
  return (mode === 'rp' ? RP_ENGINE : VN_ENGINE).map((d) => d.key);
}

/** Текст блока движка по ключу — для «↺ вернуть по умолчанию». */
export function engineBlockContent(mode: EngineMode, key: string): string | null {
  const src = mode === 'rp' ? defaultRpPreset().blocks : defaultPreset().blocks;
  return src.find((b) => b.builtinKey === key)?.content ?? null;
}

export function ensureEngineBlocks(preset: PromptPreset, mode: EngineMode): PromptPreset {
  const defs = mode === 'rp' ? RP_ENGINE : VN_ENGINE;
  const fresh = mode === 'rp' ? defaultRpPreset().blocks : defaultPreset().blocks;
  const blocks = [...preset.blocks];
  const have = new Set(blocks.map((b) => b.builtinKey).filter(Boolean));
  const make = (d: EngineDef): PromptBlock | null => {
    const b = fresh.find((x) => x.builtinKey === d.key);
    return b ? { ...b, id: uid('blk'), name: d.name, enabled: d.enabled } : null;
  };
  const historyIdx = () => blocks.findIndex((b) => b.dynamic === 'history');

  // В начало — после уже стоящих там блоков движка, в каноническом порядке.
  const startKeys = new Set(defs.filter((d) => d.at === 'start').map((d) => d.key));
  for (const d of defs) {
    if (have.has(d.key)) continue;
    const b = make(d);
    if (!b) continue;
    if (d.at === 'start') {
      let at = 0;
      while (at < blocks.length && blocks[at].builtinKey && startKeys.has(blocks[at].builtinKey!)) at++;
      blocks.splice(at, 0, b);
    } else {
      const h = historyIdx();
      blocks.splice(h < 0 ? blocks.length : h, 0, b);
    }
    have.add(d.key);
  }

  // Динамические: недостающие — перед памятью, иначе перед историей. Выключенные
  // автором есть в списке — их не трогаем.
  const dyn = new Set(blocks.map((b) => b.dynamic).filter(Boolean));
  for (const d of DYNAMICS[mode]) {
    if (dyn.has(d)) continue;
    const b: PromptBlock = { id: uid('blk'), name: DYN_NAMES[d] || d, enabled: true, content: '', dynamic: d };
    const mem = blocks.findIndex((x) => x.dynamic === 'memory');
    const target = d === 'memory' ? historyIdx() : mem >= 0 ? mem : historyIdx();
    blocks.splice(target < 0 ? blocks.length : target, 0, b);
    dyn.add(d);
  }
  if (historyIdx() < 0) blocks.push({ id: uid('blk'), name: DYN_NAMES.history!, enabled: true, content: '', dynamic: 'history' });

  const next = { ...preset, blocks };
  return refreshBuiltins(next, fresh, mode === 'rp' ? RP_OUTDATED_SIGNATURES : OUTDATED_SIGNATURES);
}
