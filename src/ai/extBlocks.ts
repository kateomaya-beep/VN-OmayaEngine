import { create } from 'zustand';
import type { ImageAspectRatio, ImageGenConfig, Project, RuntimeState } from '../shared/types';
import { IMAGE_ASPECT_RATIOS, defaultNaiConfig } from '../shared/types';
import { uid } from '../shared/utils';
import { expandMacros } from './macros';
import { describePerson, nameHit, personsInText, resolvePerson, type Person } from './characterRegistry';
import { stripStateBlock, stripThinkingBlocks } from './rpResponse';
import { studioCompletion } from './studioConnection';
import { withPreset } from './presetPassThrough';
import { imageGenFor } from './imageConnection';
import { joinNaiPrompt, naiMaxCharacters, naiModel, splitNaiPrompt } from './novelai';
import { effectiveImageModel } from './imageProvider';
import { appearanceTagsOf, ensureAppearance } from './novelaiPrompt';
import { BUILTIN_EXT_BLOCKS } from './extBlocksBuiltin';

// ВНЕШНИЕ БЛОКИ (extBlocks из SillyTavern) — режимы картинки. Блок — это
// отдельный запрос к модели: инструкция (prompt) + контекст (последние сообщения,
// прошлый вывод этого же блока, текст с макросами). Модель отвечает тегом
//   <img data-iig-instruction='{"prompt":…,"aspect_ratio":…,"image_size":…}' src="[IMG:GEN]">
// — из него берутся промпт и кадр, а дальше обычная отрисовка студии: стиль,
// «нежелательное», рефы, теги внешности, нормализатор NovelAI. Блоки заменяют
// встроенные воркеры: «По сцене», иллюстрации в игре и «Проиллюстрировать» идут
// через активный блок (свой для NovelAI, свой для остальных провайдеров).
//
// Блок вставляется из Таверны как есть (JSON) и выгружается обратно в том же
// формате. Из полей Таверны используются: name, prompt, template, context
// (last_messages / previous_block / text), period. Остальные хранятся как были —
// чтобы выгрузка вернула блок без потерь.

/** Блок в формате Таверны (что лежит в её JSON). */
export interface TavernExtBlock {
  id?: string;
  name: string;
  prompt: string;
  template?: string;
  period?: number;
  context?: TavernCtx[];
  [k: string]: unknown;
}

export interface TavernCtx {
  id?: string;
  name?: string;
  role?: 'user' | 'system' | 'assistant' | string;
  type: 'last_messages' | 'previous_block' | 'text' | string;
  disabled?: boolean;
  messages_count?: number;
  messages_offset?: number;
  messages_separator?: string;
  user_prefix?: string;
  user_suffix?: string;
  char_prefix?: string;
  char_suffix?: string;
  block_count?: number;
  text?: string;
  [k: string]: unknown;
}

export interface ExtBlock {
  id: string;
  /** Имя для людей. */
  title: string;
  /** Под какой провайдер пишет: теги NovelAI («сцена | персонаж») или описание. */
  target: 'nai' | 'text';
  /** Встроенный блок (ключ) — его можно вернуть к исходному тексту. */
  builtin?: string;
  raw: TavernExtBlock;
}

const LS_KEY = 'nf_ext_blocks_v1';

interface Library {
  blocks: ExtBlock[];
  activeNai: string;
  activeText: string;
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

export function builtinBlocks(): ExtBlock[] {
  return BUILTIN_EXT_BLOCKS.map((b) => ({ id: `ext_${b.key}`, title: b.title, target: b.target, builtin: b.key, raw: clone(b.raw) }));
}

function defaultLibrary(): Library {
  return { blocks: builtinBlocks(), activeNai: 'ext_image_lite', activeText: 'ext_image' };
}

/** Под какой провайдер блок: по тексту инструкции. */
export function guessTarget(raw: TavernExtBlock): 'nai' | 'text' {
  const p = `${raw.prompt || ''}\n${raw.template || ''}`;
  return /danbooru|novelai|\|\s*\[character|"\|"|source#|girl", or "other"|"boy", "girl"/i.test(p) ? 'nai' : 'text';
}

function validRaw(v: any): v is TavernExtBlock {
  return !!v && typeof v === 'object' && typeof v.prompt === 'string' && v.prompt.trim().length > 0;
}

/** Разобрать вставленный JSON: один блок, массив блоков или выгрузка Таверны с полем blocks. */
export function parseTavernBlocks(text: string): { blocks: TavernExtBlock[]; error?: string } {
  let v: any;
  try {
    v = JSON.parse(text.trim().replace(/^﻿/, ''));
  } catch (e) {
    return { blocks: [], error: `Это не JSON: ${(e as Error).message}` };
  }
  const list: any[] = Array.isArray(v) ? v : Array.isArray(v?.blocks) ? v.blocks : Array.isArray(v?.extBlocks) ? v.extBlocks : [v];
  const blocks = list.filter(validRaw);
  if (!blocks.length) return { blocks: [], error: 'В JSON нет блока с полем «prompt».' };
  return { blocks };
}

function loadLibrary(): Library {
  const d = defaultLibrary();
  try {
    const v = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    if (!v || !Array.isArray(v.blocks)) return d;
    const blocks: ExtBlock[] = v.blocks
      .filter((b: any) => b && typeof b.id === 'string' && validRaw(b.raw))
      .map((b: any) => ({
        id: b.id,
        title: typeof b.title === 'string' && b.title.trim() ? b.title : b.raw.name || 'Блок',
        target: b.target === 'nai' ? 'nai' : 'text',
        ...(typeof b.builtin === 'string' ? { builtin: b.builtin } : {}),
        raw: b.raw,
      }));
    // Встроенные, которых в сохранении нет (появились позже), — добавляем.
    for (const bb of d.blocks) if (!blocks.some((b) => b.builtin === bb.builtin)) blocks.push(bb);
    const has = (id: unknown) => blocks.some((b) => b.id === id);
    return {
      blocks,
      activeNai: has(v.activeNai) ? v.activeNai : d.activeNai,
      activeText: has(v.activeText) ? v.activeText : d.activeText,
    };
  } catch {
    return d;
  }
}

interface ExtStore extends Library {
  add: (raw: TavernExtBlock, target?: 'nai' | 'text') => ExtBlock;
  update: (id: string, patch: Partial<Omit<ExtBlock, 'id'>>) => void;
  remove: (id: string) => void;
  reset: (id: string) => void;
  setActive: (target: 'nai' | 'text', id: string) => void;
}

export const useExtBlocks = create<ExtStore>((set, get) => {
  const save = (lib: Library) => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(lib));
    } catch {
      /* ignore */
    }
    set(lib);
  };
  const lib = () => ({ blocks: get().blocks, activeNai: get().activeNai, activeText: get().activeText });
  return {
    ...loadLibrary(),
    add(raw, target) {
      const b: ExtBlock = { id: uid('ext'), title: String(raw.name || 'Блок'), target: target ?? guessTarget(raw), raw: clone(raw) };
      save({ ...lib(), blocks: [...get().blocks, b] });
      return b;
    },
    update(id, patch) {
      save({ ...lib(), blocks: get().blocks.map((b) => (b.id === id ? { ...b, ...patch } : b)) });
    },
    remove(id) {
      const blocks = get().blocks.filter((b) => b.id !== id || !!b.builtin);
      const first = (t: 'nai' | 'text') => blocks.find((b) => b.target === t)?.id || '';
      const l = lib();
      save({
        blocks,
        activeNai: blocks.some((b) => b.id === l.activeNai) ? l.activeNai : first('nai'),
        activeText: blocks.some((b) => b.id === l.activeText) ? l.activeText : first('text'),
      });
    },
    reset(id) {
      const b = get().blocks.find((x) => x.id === id);
      const src = b?.builtin ? builtinBlocks().find((x) => x.builtin === b.builtin) : undefined;
      if (src) save({ ...lib(), blocks: get().blocks.map((x) => (x.id === id ? { ...src, id } : x)) });
    },
    setActive(target, id) {
      save({ ...lib(), ...(target === 'nai' ? { activeNai: id } : { activeText: id }) });
    },
  };
});

export function isBuiltinModified(b: ExtBlock): boolean {
  if (!b.builtin) return false;
  const src = BUILTIN_EXT_BLOCKS.find((x) => x.key === b.builtin);
  return !!src && (JSON.stringify(src.raw) !== JSON.stringify(b.raw) || src.title !== b.title);
}

/** Активный блок для провайдера картинок (NovelAI — свой, остальные — свой). */
export function activeExtBlock(ig: ImageGenConfig): ExtBlock | null {
  const s = useExtBlocks.getState();
  const target = ig.providerKind === 'novelai' ? 'nai' : 'text';
  const id = target === 'nai' ? s.activeNai : s.activeText;
  return s.blocks.find((b) => b.id === id && b.target === target) || s.blocks.find((b) => b.target === target) || null;
}

/** Выгрузка в формате Таверны. */
export function toTavernJson(b: ExtBlock): string {
  return JSON.stringify({ ...b.raw, name: b.raw.name || b.title }, null, 4);
}

// ── Запуск ───────────────────────────────────────────────────────────────────

export interface ExtRunOpts {
  /** Текст сообщения, к которому рисуем (иллюстрация к конкретному ответу). */
  recent?: string;
  /** Что именно в кадре (метка рассказчика / просьба игрока). */
  moment?: string;
  people?: Person[];
  onlyCharacterIds?: string[];
}

export interface ExtRunResult {
  prompt: string;
  aspectRatio?: ImageAspectRatio;
  cast?: string[];
  /** Вывод блока как есть (без размышления) — для «прошлого вывода» в следующий раз. */
  output: string;
}

const SEPARATORS: Record<string, string> = { double_newline: '\n\n', newline: '\n', space: ' ', none: '' };

/** Последние сообщения истории — до того, к которому рисуем (если задан). */
function lastMessages(state: RuntimeState, c: TavernCtx, recent?: string): string {
  const hist = state.history.filter((m) => m.role === 'user' || m.role === 'assistant');
  let end = hist.length;
  if (recent) {
    const target = stripStateBlock(recent).trim();
    for (let i = hist.length - 1; i >= 0; i--) {
      if (hist[i].content === recent || stripStateBlock(hist[i].content).trim() === target) {
        end = i + 1;
        break;
      }
    }
  }
  const offset = Math.max(0, Number(c.messages_offset) || 0);
  const count = Math.max(1, Number(c.messages_count) || 2);
  const slice = hist.slice(Math.max(0, end - offset - count), Math.max(0, end - offset));
  const sep = SEPARATORS[String(c.messages_separator || 'double_newline')] ?? '\n\n';
  return slice
    .map((m) => {
      const text = stripThinkingBlocks(stripStateBlock(m.content));
      return m.role === 'user'
        ? `${c.user_prefix || ''}${text}${c.user_suffix || ''}`
        : `${c.char_prefix || ''}${text}${c.char_suffix || ''}`;
    })
    .filter((t) => t.trim())
    .join(sep);
}

/** Люди сцены — наша добавка к контексту блока: внешность всех, а не только {{char}}. */
function peopleNote(project: Project, ig: ImageGenConfig, people: Person[], onlyIds?: string[]): string {
  if (!people.length) return '';
  const nai = ig.nai ?? defaultNaiConfig();
  const lines = people.map((p) => {
    const tags = ig.providerKind === 'novelai' ? appearanceTagsOf(nai, p) : '';
    const look = describePerson(p).slice(0, 500);
    return `- ${p.name}${p.aliases.length ? ` (also: ${p.aliases.slice(0, 3).join(', ')})` : ''}${tags ? `\n  appearance tags (copy verbatim into this person's section): ${tags}` : ''}${look ? `\n  appearance: ${look}` : ''}`;
  });
  void project;
  return `Characters of the story who may be in this image${onlyIds ? ' (ONLY these may appear)' : ''}:\n${lines.join('\n')}`;
}

export function blockMessages(
  project: Project,
  state: RuntimeState,
  block: ExtBlock,
  outputs: string[],
  opts: ExtRunOpts,
  people: Person[]
): { system: string; messages: { role: 'user' | 'assistant'; content: string }[] } {
  const ig = imageGenFor(project);
  const ctx = { project, state, vars: new Map<string, string>() };
  const sys: string[] = [expandMacros(block.raw.prompt, ctx)];
  const msgs: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const c of block.raw.context || []) {
    if (c.disabled) continue;
    let text = '';
    if (c.type === 'last_messages') text = lastMessages(state, c, opts.recent);
    else if (c.type === 'previous_block') {
      const n = Math.max(1, Number(c.block_count) || 1);
      text = outputs.slice(-n).join('\n\n');
      if (text) text = `Your previous output for this block (keep continuity — clothing, injuries, positions — where still valid):\n${text}`;
    } else if (c.type === 'text') text = expandMacros(String(c.text || ''), ctx);
    if (!text.trim()) continue;
    if (c.role === 'system') sys.push(text);
    else msgs.push({ role: c.role === 'assistant' ? 'assistant' : 'user', content: text });
  }
  const extra = [
    peopleNote(project, ig, people, opts.onlyCharacterIds),
    opts.moment ? `THE MOMENT TO DRAW (frame exactly this): ${opts.moment}` : '',
  ].filter(Boolean);
  if (extra.length || !msgs.length || msgs[msgs.length - 1].role !== 'user') {
    msgs.push({ role: 'user', content: extra.join('\n\n') || 'Generate the block now.' });
  }
  // Две реплики одной роли подряд некоторые API не принимают — склеиваем.
  const merged: typeof msgs = [];
  for (const m of msgs) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === m.role) prev.content += `\n\n${m.content}`;
    else merged.push({ ...m });
  }
  return { system: sys.join('\n\n'), messages: merged };
}

const decodeEntities = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** Ответ блока → промпт и кадр. */
export function parseBlockOutput(raw: string): { prompt: string; aspect?: ImageAspectRatio; size?: string; output: string } {
  // Размышление вон: закрытое — целиком; незакрытое — всё до начала вывода.
  let text = stripThinkingBlocks(raw.replace(/^```[a-z]*\n?|```\s*$/gim, ''));
  const open = text.search(/<think(?:ing)?>/i);
  if (open >= 0) {
    const tag = text.slice(open).search(/<(image|img|naicom|image_lite)\b/i);
    text = tag >= 0 ? text.slice(0, open) + text.slice(open + tag) : text.slice(0, open);
  }
  text = text.trim();
  const attr = /data-iig-instruction\s*=\s*(?:'([\s\S]*?)'(?=\s*(?:src|\/?>|\n))|"([\s\S]*?)"(?=\s*(?:src|\/?>|\n)))/i.exec(text);
  const json = attr ? decodeEntities(attr[1] ?? attr[2] ?? '') : (/\{[\s\S]*"prompt"[\s\S]*\}/.exec(text)?.[0] ?? '');
  let prompt = '';
  let aspect: string | undefined;
  let size: string | undefined;
  if (json) {
    try {
      const d = JSON.parse(json);
      if (typeof d.prompt === 'string') prompt = d.prompt;
      if (typeof d.aspect_ratio === 'string') aspect = d.aspect_ratio;
      if (typeof d.image_size === 'string') size = d.image_size;
    } catch {
      // Битый JSON (кавычка внутри промпта и т. п.) — достаём поля по отдельности.
      prompt = /"prompt"\s*:\s*"([\s\S]*?)"\s*,\s*"(?:aspect_ratio|image_size)"/.exec(json)?.[1] ?? /"prompt"\s*:\s*"([\s\S]*)"/.exec(json)?.[1] ?? '';
      aspect = /"aspect_ratio"\s*:\s*"([^"]+)"/.exec(json)?.[1];
      size = /"image_size"\s*:\s*"([^"]+)"/.exec(json)?.[1];
      prompt = prompt.replace(/\\"/g, '"').replace(/\\n/g, ' ');
    }
  }
  if (!prompt && !attr) prompt = text.replace(/<[^>]+>/g, ' ');
  prompt = prompt.replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
  const a = aspect?.trim();
  return {
    prompt,
    aspect: a && (IMAGE_ASPECT_RATIOS as readonly string[]).includes(a) ? (a as ImageAspectRatio) : undefined,
    size,
    output: text,
  };
}

const normName = (s: string) => s.toLowerCase().replace(/ё/g, 'е');

/** NovelAI: в раздел персонажа, где назван человек истории, — его теги внешности. */
export function withAppearanceBySegment(prompt: string, people: Person[], ig: ImageGenConfig): { prompt: string; cast: string[] } {
  const nai = ig.nai ?? defaultNaiConfig();
  const sp = splitNaiPrompt(prompt);
  const cast: string[] = [];
  const chars = sp.characters.map((seg) => {
    const low = normName(seg);
    const who = people.find((p) => [p.name, ...p.aliases].some((n) => n && n.length > 1 && (low.includes(normName(n)) || nameHit(n, seg))));
    if (!who) return seg;
    if (!cast.includes(who.name)) cast.push(who.name);
    const tags = appearanceTagsOf(nai, who);
    // «Text:» раздела — его конец: теги внешности ставим до него.
    const at = seg.search(/\bText:/);
    const head = at >= 0 ? seg.slice(0, at).replace(/[\s,.]+$/, '') : seg;
    const tail = at >= 0 ? `. ${seg.slice(at).trim()}` : '';
    return tags ? ensureAppearance(head, tags) + tail : seg;
  });
  return { prompt: sp.characters.length ? joinNaiPrompt(sp.base, chars) : prompt, cast };
}

/** Кто в кадре: те, кто есть в сцене и назван в промпте или в тексте момента. */
function castOf(project: Project, state: RuntimeState, people: Person[], prompt: string, recent: string, named: string[]): string[] {
  const out = new Set(named);
  const hay = normName(`${prompt}\n${recent}`);
  for (const p of people) if ([p.name, ...p.aliases].some((n) => n && n.length > 1 && hay.includes(normName(n)))) out.add(p.name);
  for (const p of personsInText(project, state, prompt)) out.add(p.name);
  return [...out];
}

/** Запустить блок: запрос к модели → промпт картинки. Прошлый вывод запоминает вызывающий (saveBlockOutput). */
export async function runExtBlock(project: Project, state: RuntimeState, block: ExtBlock, opts: ExtRunOpts = {}): Promise<ExtRunResult> {
  const ig = imageGenFor(project);
  const manual = opts.onlyCharacterIds;
  const people = (opts.people?.length ? opts.people : collectPeople(project, state, opts.recent)).filter(
    (p) => !manual || p.ids.some((id) => manual.includes(id))
  );
  const outputs = ig.blockOutputs?.[block.id] || [];
  const { system, messages } = blockMessages(project, state, block, outputs, opts, people);
  const raw = await studioCompletion(
    withPreset(
      { system, messages, model: project.aiConfig.summarizerModel || undefined, temperature: 0.7, maxTokens: 4000 },
      project,
      state,
      ig.sendPreset !== false
    )
  );
  const parsed = parseBlockOutput(raw);
  if (!parsed.prompt) throw new Error(`Блок «${block.title}» не вернул промпт картинки. Ответ модели: ${raw.slice(0, 300)}`);
  let prompt = parsed.prompt;
  let named: string[] = [];
  if (block.target === 'nai' && ig.providerKind === 'novelai') {
    const max = naiMaxCharacters(naiModel(effectiveImageModel(ig)));
    const r = withAppearanceBySegment(prompt, people, ig);
    prompt = r.prompt;
    named = r.cast;
    if (max === 0) prompt = prompt.replace(/\s*\|\s*/g, ', ');
  }
  const recent = opts.recent || [...state.history].reverse().find((m) => m.role === 'assistant')?.content || '';
  return {
    prompt,
    aspectRatio: parsed.aspect,
    cast: castOf(project, state, people, prompt, stripStateBlock(recent), named),
    output: parsed.output,
  };
}

/** Кандидаты в кадр: кто в сцене + кто назван в тексте момента. */
function collectPeople(project: Project, state: RuntimeState, recent?: string): Person[] {
  const out: Person[] = [];
  const push = (p: Person | null | undefined) => {
    if (p && !out.some((x) => x.id === p.id)) out.push(p);
  };
  const text =
    recent ||
    state.history
      .filter((m) => m.role !== 'system')
      .slice(-2)
      .map((m) => m.content)
      .join('\n');
  for (const p of personsInText(project, state, stripStateBlock(text))) push(p);
  for (const o of state.onScreen || []) push(resolvePerson(project, state, { id: o.characterId }));
  for (const c of state.gm?.characters || []) if (c.updatedAtTurn === state.turnCount) push(resolvePerson(project, state, { id: c.charId || undefined, name: c.name }));
  return out.slice(0, 8);
}

/** Запомнить вывод блока в проекте (для «previous_block» в следующий раз). */
export function pushBlockOutput(ig: ImageGenConfig, blockId: string, output: string): ImageGenConfig {
  const map = { ...(ig.blockOutputs || {}) };
  map[blockId] = [...(map[blockId] || []), output].slice(-3);
  return { ...ig, blockOutputs: map };
}
