import { uid } from '../shared/utils';
import type { PromptBlock, PromptPreset } from './promptPreset';
import type { PresetSlot } from './presetSettings';

// АССИСТЕНТ И ПРЕСЕТ ПРОМПТА. Ассистент видит активный пресет режима (тот, что
// реально уходит в запрос: альтернативный, профиль модели или стандартный) и
// правит его операциями — как панель: текст и имя блока, вкл/выкл, свой блок,
// удаление своего, перестановка. Правки одного ответа откатываются кнопкой
// целиком: перед ними запоминается снимок пресета.

const MAX_BLOCK_CHARS = 4000;
const MAX_TOTAL_CHARS = 60000;

export function presetDigest(preset: PromptPreset, slotLabel: string): string {
  let budget = MAX_TOTAL_CHARS;
  const lines = preset.blocks.map((b) => {
    const kind = b.dynamic
      ? `engine block: ${b.dynamic} (content filled by the engine; you may move or toggle it)`
      : b.builtinKey
        ? `built-in "${b.builtinKey}"`
        : 'custom';
    const where = b.injectDepth !== undefined ? `; injected at depth ${b.injectDepth}` : '';
    const role = b.role && b.role !== 'system' ? `; role ${b.role}` : '';
    const head = `- #${b.id} [${b.enabled ? 'ON' : 'off'}] «${b.name}» (${kind}${role}${where})`;
    if (b.dynamic || !b.content.trim()) return head + (b.dynamic ? '' : ' — empty');
    let body = b.content.trim();
    const cap = Math.min(MAX_BLOCK_CHARS, Math.max(300, budget));
    if (body.length > cap) body = body.slice(0, cap) + '\n[…truncated — ask the author before replacing this block whole]';
    budget -= body.length;
    return `${head}\n<<<\n${body}\n>>>`;
  });
  return (
    `== ACTIVE PROMPT PRESET «${preset.name}» (${slotLabel}; ${preset.blocks.length} blocks, top to bottom = order in the request; ` +
    `blocks below «💬 История переписки»/history go after the chat) ==\n${lines.join('\n')}`
  );
}

export const PRESET_PROTOCOL = `PROMPT PRESET (the narrator's instructions above) — you may view and edit it when the author asks:
- { "op": "preset.block.update", "id": "<block id>", "name": "...", "content": "...", "enabled": true }  — changed fields only; content replaces the whole text
- { "op": "preset.block.add", "name": "...", "content": "...", "after": "<block id>" }  — a new custom block (after = position; omit → at the end, before the chat history)
- { "op": "preset.block.delete", "id": "<block id>" }  — custom blocks only; built-in and engine blocks are switched off instead
- { "op": "preset.block.move", "id": "<block id>", "after": "<block id>" }  (or "before")
Preset rules: write block text in English unless the author asks otherwise (the narrator reads English instructions best); one set of rules per block; do not duplicate a rule another enabled block already has — edit that block; never touch engine blocks' content.`;

export function hasPresetOps(ops: any[]): boolean {
  return ops.some((o) => typeof o?.op === 'string' && o.op.startsWith('preset.'));
}

export interface PresetOpsResult {
  preset: PromptPreset;
  labels: string[];
}

export function applyAssistantPresetOps(preset: PromptPreset, ops: any[]): PresetOpsResult {
  let blocks: PromptBlock[] = preset.blocks.map((b) => ({ ...b }));
  const labels: string[] = [];
  const find = (id: unknown) => blocks.findIndex((b) => b.id === id);
  const historyIdx = () => blocks.findIndex((b) => b.dynamic === 'history');
  for (const o of ops) {
    const op = typeof o?.op === 'string' ? o.op : '';
    if (!op.startsWith('preset.')) continue;
    if (op === 'preset.block.update') {
      const i = find(o.id);
      if (i < 0) continue;
      const b = blocks[i];
      const next = { ...b };
      const what: string[] = [];
      if (typeof o.name === 'string' && o.name.trim() && o.name !== b.name) {
        next.name = o.name.trim();
        what.push('имя');
      }
      if (typeof o.content === 'string' && !b.dynamic && o.content !== b.content) {
        next.content = o.content;
        what.push('текст');
      }
      if (typeof o.enabled === 'boolean' && o.enabled !== b.enabled) {
        next.enabled = o.enabled;
        what.push(o.enabled ? 'включён' : 'выключен');
      }
      if (!what.length) continue;
      blocks[i] = next;
      labels.push(`Пресет: «${next.name}» — ${what.join(', ')}`);
    } else if (op === 'preset.block.add') {
      const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim() : 'Новый блок';
      const content = typeof o.content === 'string' ? o.content : '';
      if (!content.trim()) continue;
      const block: PromptBlock = { id: uid('blk'), name, enabled: true, content, role: 'system' };
      const after = find(o.after);
      const at = after >= 0 ? after + 1 : historyIdx() >= 0 ? historyIdx() : blocks.length;
      blocks.splice(at, 0, block);
      labels.push(`Пресет: новый блок «${name}»`);
    } else if (op === 'preset.block.delete') {
      const i = find(o.id);
      if (i < 0) continue;
      const b = blocks[i];
      if (b.builtinKey || b.dynamic) {
        if (b.enabled) {
          blocks[i] = { ...b, enabled: false };
          labels.push(`Пресет: «${b.name}» выключен (встроенный — не удаляется)`);
        }
        continue;
      }
      blocks = blocks.filter((_, k) => k !== i);
      labels.push(`Пресет: удалён блок «${b.name}»`);
    } else if (op === 'preset.block.move') {
      const i = find(o.id);
      const ref = find(o.after ?? o.before);
      if (i < 0 || ref < 0 || i === ref) continue;
      const [b] = blocks.splice(i, 1);
      const r = blocks.findIndex((x) => x.id === (o.after ?? o.before));
      blocks.splice(o.after !== undefined ? r + 1 : r, 0, b);
      labels.push(`Пресет: «${b.name}» переставлен`);
    }
  }
  return { preset: { ...preset, blocks }, labels };
}

/** Откат правок пресета: снимок до них и куда его вернуть. */
export interface PresetRevert {
  kind: 'restorePreset';
  slot: PresetSlot;
  before: PromptPreset;
}
