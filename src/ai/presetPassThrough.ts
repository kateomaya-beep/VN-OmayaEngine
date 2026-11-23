import type { Project, RuntimeState } from '../shared/types';
import { normalizeNarrativeMode } from '../shared/types';
import { getPresetSettings, presetSlotFor, readPresetSlot } from './presetSettings';
import { expandMacros, type MacroContext } from './macros';
import type { PromptPreset } from './promptPreset';

// БЛОКИ ПРЕСЕТА — И АССИСТЕНТАМ. Ассистент-соавтор и ассистент картинок получают
// те же текстовые блоки активного пресета, что и рассказчик (правила, разрешения,
// тон — всё, что автор там держит), чтобы работать по тем же правилам. Берутся
// включённые блоки с текстом, макросы раскрываются как у рассказчика. Блоки
// движка (мир, память, история…) не берутся: у ассистентов свой контекст; блок
// JSON-контракта (помечен) — тоже: формат ответа у ассистентов свой.
// Положение сохраняется: выше «Истории переписки» — в начало запроса, ниже неё и
// «на глубине» — после переписки, перед ответом.

export interface PresetPass {
  /** Блоки до истории — в системную часть. */
  system: string;
  /** Блоки после истории — к последнему сообщению. */
  tail: string;
  /** id блоков, чей текст ушёл, — чтобы не слать его второй раз (сводка пресета у ассистента). */
  sentIds: Set<string>;
  presetName: string;
}

const HEAD = (name: string) =>
  `== THE AUTHOR'S STORY PRESET «${name}» (the same instructions the narrator gets) ==
Follow its permissions, content rules and tone — they apply to you as well. Parts that describe how the NARRATOR writes story turns (turn length, prose format, point of view, reply structure, output format) are for the narrator: your own task and output format, given separately, take priority over them.`;

export function activePresetFor(project: Project): PromptPreset | null {
  const ps = getPresetSettings();
  return readPresetSlot(ps, presetSlotFor(ps, normalizeNarrativeMode(project.mode)));
}

export function presetPassThrough(project: Project, state?: RuntimeState | null, preset = activePresetFor(project)): PresetPass | null {
  if (!preset) return null;
  const ctx: MacroContext = { project, state, vars: new Map() };
  const hasHistory = preset.blocks.some((b) => b.enabled && b.dynamic === 'history');
  let afterHistory = false;
  const before: string[] = [];
  const after: string[] = [];
  const sentIds = new Set<string>();
  for (const b of preset.blocks) {
    if (!b.enabled) continue;
    if (b.dynamic === 'history') {
      afterHistory = true;
      continue;
    }
    if (b.dynamic || b.flagged) continue;
    // Макросы раскрываются и у пустых на вид блоков: {{setvar}} нужен блокам ниже.
    let text: string;
    try {
      text = expandMacros(b.content, ctx).trim();
    } catch {
      text = b.content.trim();
    }
    if (!text) continue;
    sentIds.add(b.id);
    if ((hasHistory && afterHistory) || b.injectDepth !== undefined) after.push(text);
    else before.push(text);
  }
  if (!before.length && !after.length) return null;
  return {
    system: before.length ? `${HEAD(preset.name)}\n\n${before.join('\n\n')}` : '',
    tail: after.length
      ? `[The author's preset instructions that follow the conversation:]\n${after.join('\n\n')}\n[End of preset instructions — now answer the request above in your own required format.]`
      : '',
    sentIds,
    presetName: preset.name,
  };
}

/** Дописать хвост пресета к последнему сообщению пользователя (или отдельным, если его нет). */
export function withPresetTail<M extends { role: string; content: string }>(messages: M[], tail: string): M[] {
  if (!tail) return messages;
  const out = messages.map((m) => ({ ...m }));
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role === 'user') {
      out[i].content = `${out[i].content}\n\n${tail}`;
      return out;
    }
  }
  return [...out, { role: 'user', content: tail } as M];
}

/**
 * Запрос промпт-задачи студии с блоками пресета: начало — в системную часть
 * перед задачей, хвост — к последнему сообщению. enabled=false — как есть.
 */
export function withPreset<R extends { system: string; messages: { role: any; content: string }[] }>(
  req: R,
  project: Project,
  state: RuntimeState | null | undefined,
  enabled: boolean
): R {
  if (!enabled) return req;
  const pass = presetPassThrough(project, state);
  if (!pass) return req;
  return {
    ...req,
    system: [pass.system, req.system].filter(Boolean).join('\n\n---\n\n'),
    messages: withPresetTail(req.messages, pass.tail),
  };
}
