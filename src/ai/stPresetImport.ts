import { uid } from '../shared/utils';
import type { DynamicSource, PromptBlock, PromptPreset } from './promptPreset';
import { defaultRpPreset } from './rpPreset';
import type { RegexRule } from './regexRules';
import type { AltRpPreset } from './altPresets';

// ИМПОРТ ПРЕСЕТА SILLYTAVERN (Chat Completion) как альтернативного пресета РП.
//
// Переносится всё, что влияет на запрос:
//  - блоки prompts в порядке prompt_order (как в Таверне — по персонажу 100001,
//    иначе по первому порядку), с ролями и включённостью;
//  - блоки с injection_position = 1 и всё, что стоит ПОСЛЕ «Chat History», —
//    внутрь истории на свою глубину (в Таверне история включает и ход игрока,
//    поэтому блок после неё читается моделью после хода);
//  - маркеры Таверны → наши динамические блоки: World Info → мир и лорбук, Chat
//    Examples → образцы речи, Char Description → карточки персонажей, Scenario →
//    сюжетная арка;
//  - регулярки из extensions.regex_scripts — с глубиной и HTML-виджетами;
//  - выборка (temperature, top_p, штрафы, потолок ответа).
// Макросы ({{setvar}}, {{getvar}}, {{user}}, {{char}}, {{summary}}…) остаются в
// тексте как есть — их раскрывает наш движок макросов на каждом запросе.
//
// Сверху добавляется связка с движком: пометки хода игрока ([CONTINUE], [OOC]…)
// и служебная сводка состояния — без них не работают часы, досье, память и Game
// Master. Обе — обычные блоки: можно выключить.

const MARKERS: Record<string, DynamicSource | 'characters' | 'persona' | 'skip'> = {
  chatHistory: 'history',
  worldInfoBefore: 'world',
  worldInfoAfter: 'lorebook',
  dialogueExamples: 'voice',
  scenario: 'plot',
  charDescription: 'characters',
  charPersonality: 'characters',
  personaDescription: 'persona',
};

const NAMES: Partial<Record<DynamicSource | 'persona', string>> = {
  history: '💬 История переписки',
  world: '↳ Мир и правила (World Info before)',
  lorebook: '↳ Лорбук (World Info after)',
  voice: '↳ Примеры реплик (Chat Examples)',
  plot: '↳ Сюжетная арка (Scenario)',
  characters: '↳ Персонажи (Char Description)',
  persona: '↳ Герой игрока (Persona)',
  state: '↳ Текущее состояние',
  gamemaster: '↳ Game Master',
  memory: '↳ Память движка (summary)',
  memorybook: '↳ Меморибук',
};

export interface StImportOptions {
  /** Имя в списке пресетов; нет — из файла или «Импорт SillyTavern». */
  name?: string;
  source?: AltRpPreset['source'];
  /** Язык повествования: для ru включаются русские варианты тумблеров и виджетов, где они есть. */
  lang?: 'ru' | 'en';
}

export function isSillyTavernPreset(raw: unknown): boolean {
  const r = raw as any;
  return !!r && Array.isArray(r.prompts) && Array.isArray(r.prompt_order);
}

export function importSillyTavernPreset(raw: unknown, opts: StImportOptions = {}): AltRpPreset {
  if (!isSillyTavernPreset(raw)) throw new Error('Это не пресет SillyTavern: нет prompts и prompt_order');
  const r = raw as any;
  const byId = new Map<string, any>();
  for (const p of r.prompts) if (p && typeof p.identifier === 'string') byId.set(p.identifier, p);
  const orders: any[] = r.prompt_order.filter((o: any) => o && Array.isArray(o.order));
  const order: { identifier: string; enabled: boolean }[] = (
    orders.find((o) => o.character_id === 100001) ?? orders.reduce((a, b) => (b.order.length > (a?.order.length ?? 0) ? b : a), null)
  )?.order ?? [];
  if (!order.length) throw new Error('В пресете пустой prompt_order');

  const blocks: PromptBlock[] = [];
  const seenDynamic = new Set<string>();
  let afterHistory = false;
  let memoryAt = -1;
  for (const o of order) {
    const p = byId.get(o.identifier);
    if (!p) continue;
    const enabled = o.enabled !== false;
    const marker = MARKERS[o.identifier];
    const role = p.role === 'user' || p.role === 'assistant' ? p.role : undefined;
    const injected = p.injection_position === 1;
    const depth = injected ? Math.max(0, Math.floor(Number(p.injection_depth) || 0)) : afterHistory ? 0 : undefined;
    const base = { id: uid('blk'), enabled, ...(role ? { role } : {}), ...(depth !== undefined ? { injectDepth: depth } : {}) };

    if (marker && marker !== 'skip' && (p.marker || !p.content)) {
      if (marker === 'persona') {
        blocks.push({ ...base, name: NAMES.persona!, content: '{{persona}}' });
        continue;
      }
      // Выключенная карточка персонажа — у таких пресетов она приезжает макросами
      // ({{description}} в своём блоке). Наши карточки всё равно нужны (там все,
      // кто в сцене, с их состоянием) — их поставим сами, ниже.
      if (marker === 'characters' && !enabled) continue;
      if (seenDynamic.has(marker)) continue;
      seenDynamic.add(marker);
      if (marker === 'history') {
        blocks.push({ id: base.id, enabled: true, name: NAMES.history!, content: '', dynamic: 'history' });
        afterHistory = true;
        continue;
      }
      blocks.push({ id: base.id, enabled, name: NAMES[marker] || p.name, content: '', dynamic: marker });
      continue;
    }
    // Прочие маркеры без текста (main/nsfw/jailbreak пустые, enhanceDefinitions
    // без содержимого) — пустой блок ничего не шлёт, но место и имя сохраняем,
    // чтобы список совпадал с Таверной.
    const content = typeof p.content === 'string' ? p.content : '';
    const name = typeof p.name === 'string' && p.name.trim() ? p.name : o.identifier;
    // Блок со {{summary}} — место памяти. Наша память богаче таверновской сводки
    // (журнал глав, снапшот, факты), поэтому ставим её сюда, а сам блок оставляем
    // выключенным рядом — чтобы сводка не ехала дважды.
    if (/\{\{\s*summary\s*\}\}/i.test(content) && !seenDynamic.has('memory') && enabled && depth === undefined) {
      memoryAt = blocks.length;
      seenDynamic.add('memory');
      blocks.push({ id: uid('blk'), enabled: true, name: NAMES.memory!, content: '', dynamic: 'memory' });
      blocks.push({ ...base, name, content, enabled: false });
      continue;
    }
    blocks.push({ ...base, name, content });
  }

  // Наши динамические блоки, которых у Таверны нет. Ставим их туда, где они
  // читаются по смыслу: персонажи — перед блоком с карточкой {{char}} (у Dr. D
  // «✒char.»), иначе перед образцами речи, иначе перед историей;
  // состояние, Game Master и меморибук — перед памятью (или перед историей).
  const historyIdx = () => blocks.findIndex((b) => b.dynamic === 'history');
  const insertBefore = (idx: number, bl: PromptBlock[]) => blocks.splice(idx < 0 ? blocks.length : idx, 0, ...bl);
  const dyn = (d: DynamicSource): PromptBlock => ({ id: uid('blk'), enabled: true, name: NAMES[d] || d, content: '', dynamic: d });
  if (!seenDynamic.has('characters')) {
    const card = blocks.findIndex((b) => b.enabled && b.injectDepth === undefined && /\{\{\s*(description|personality)\s*\}\}/i.test(b.content));
    const voice = blocks.findIndex((b) => b.dynamic === 'voice' && b.injectDepth === undefined);
    insertBefore(card >= 0 ? card : voice >= 0 ? voice : historyIdx(), [dyn('characters')]);
  }
  const extra = (['state', 'gamemaster', 'memorybook'] as DynamicSource[]).filter((d) => !seenDynamic.has(d)).map(dyn);
  if (!seenDynamic.has('memory')) extra.push(dyn('memory'));
  const memIdx = blocks.findIndex((b) => b.dynamic === 'memory');
  insertBefore(memIdx >= 0 ? memIdx : memoryAt >= 0 ? memoryAt : historyIdx(), extra);
  if (historyIdx() < 0) blocks.push({ id: uid('blk'), enabled: true, name: NAMES.history!, content: '', dynamic: 'history' });

  // Связка с движком — первыми, до правил пресета.
  const rp = defaultRpPreset().blocks;
  const engine = (key: string, name: string, enabled: boolean): PromptBlock | null => {
    const b = rp.find((x) => x.builtinKey === key);
    return b ? { ...b, id: uid('blk'), name, enabled } : null;
  };
  const engineBlocks = [
    engine('rp_moves', '⚙ Движок: пометки хода игрока', true),
    engine('rp_state', '⚙ Движок: служебная сводка состояния', true),
    // У чужого пресета свои правила о том, кто пишет за героя, — наш запрет только
    // как опция.
    engine('rp_no_impersonation', '⚙ Движок: не писать за игрока', false),
  ].filter(Boolean) as PromptBlock[];
  blocks.unshift(...engineBlocks);

  const regexRules = importRegexScripts(r.extensions?.regex_scripts);
  if (opts.lang === 'ru') preferRussian(blocks, regexRules);

  const preset: PromptPreset = {
    id: uid('preset'),
    name: opts.name || (typeof r.name === 'string' && r.name) || 'Импорт SillyTavern',
    blocks,
    foreign: 'sillytavern',
  };
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  // Нули у штрафов — «выключено»: не шлём вовсе, как и наш дефолт.
  const nz = (v: unknown) => (n(v) ? n(v) : undefined);
  return {
    id: uid('alt'),
    name: preset.name,
    source: opts.source ?? 'sillytavern',
    preset,
    regexRules,
    sampling: {
      temperature: n(r.temperature),
      topP: n(r.top_p) && n(r.top_p)! < 1 ? n(r.top_p) : undefined,
      frequencyPenalty: nz(r.frequency_penalty),
      presencePenalty: nz(r.presence_penalty),
      maxTokens: n(r.openai_max_tokens) && n(r.openai_max_tokens)! > 0 ? Math.min(32000, n(r.openai_max_tokens)!) : undefined,
    },
    importedAt: Date.now(),
  };
}

// Регулярка Таверны записана как «/тело/флаги».
function parseFind(s: string): { find: string; flags: string } | null {
  const m = /^\/([\s\S]*)\/([a-z]*)$/.exec(s.trim());
  if (m) return { find: m[1], flags: m[2] };
  return s ? { find: s, flags: 'g' } : null;
}

// placement: 1 — ввод игрока, 2 — ответ ИИ (3 — слэш-команды, 5 — World Info,
// 6 — размышление: у нас таких мест нет). markdownOnly — только экран,
// promptOnly — только промпт, оба или ни одного — и там и там.
export function importRegexScripts(raw: unknown): RegexRule[] {
  if (!Array.isArray(raw)) return [];
  const out: RegexRule[] = [];
  for (const s of raw as any[]) {
    if (!s || typeof s.findRegex !== 'string') continue;
    const f = parseFind(s.findRegex);
    if (!f) continue;
    const pl: number[] = Array.isArray(s.placement) ? s.placement : [];
    const user = pl.includes(1);
    const ai = pl.includes(2);
    if (!user && !ai) continue;
    const md = !!s.markdownOnly;
    const po = !!s.promptOnly;
    const replace = typeof s.replaceString === 'string' ? s.replaceString : '';
    const depth = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined);
    const minDepth = depth(s.minDepth);
    const maxDepth = depth(s.maxDepth);
    out.push({
      id: uid('rx'),
      name: typeof s.scriptName === 'string' && s.scriptName ? s.scriptName : 'Регулярка',
      enabled: !s.disabled,
      find: f.find,
      flags: f.flags || 'g',
      replace,
      appliesTo: user && ai ? 'both' : user ? 'user' : 'ai',
      scope: md && !po ? 'display' : po && !md ? 'prompt' : 'both',
      ...(minDepth !== undefined ? { minDepth } : {}),
      ...(maxDepth !== undefined ? { maxDepth } : {}),
      ...(/<\s*(div|span|form|style|svg|table|details|img|p|ul|section|label|input)\b/i.test(replace) ? { html: true } : {}),
    });
  }
  return out;
}

// Русские варианты: в пресетах часто пары «… eng.» / «… rus.» (язык вывода, стоп-
// слова) и регулярки «notes.» / «notes: rus.». Включён английский — переключаем
// на русский; остальной выбор автора пресета не трогаем.
const norm = (s: string) => s.replace(/[.:]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

function preferRussian(blocks: PromptBlock[], rules: RegexRule[]): void {
  for (const b of blocks) {
    if (!/\beng\.\s*$/i.test(b.name) || !b.enabled) continue;
    const key = norm(b.name.replace(/\beng\.\s*$/i, ''));
    const ru = blocks.find((x) => /\brus\.\s*$/i.test(x.name) && norm(x.name.replace(/\brus\.\s*$/i, '')) === key);
    if (!ru) continue;
    b.enabled = false;
    ru.enabled = true;
  }
  for (const ru of rules) {
    if (!/\brus\./i.test(ru.name)) continue;
    const key = norm(ru.name.replace(/\brus\./i, ''));
    const base = rules.find((x) => x !== ru && !/\brus\./i.test(x.name) && norm(x.name) === key);
    if (!base || !base.enabled) continue;
    base.enabled = false;
    ru.enabled = true;
  }
}

// Встроенная копия Dr. D v3.5 — грузится лениво, только по кнопке «Добавить».
export async function loadDrD(lang: 'ru' | 'en'): Promise<AltRpPreset> {
  const mod = await import('../presets/drd-v3.5.json');
  return importSillyTavernPreset(mod.default, { name: 'Dr. D v3.5', source: 'drd', lang });
}
