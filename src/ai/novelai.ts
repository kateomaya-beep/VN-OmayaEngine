import JSZip from 'jszip';
import type { ImageAspectRatio, ImageSizeTier } from '../shared/types';

// NOVELAI (картинки). Отдельный провайдер, потому что модель другая по устройству:
// ей нужны не фразы, а теги Danbooru, сцена и персонажи разными промптами, свои
// теги качества и пресеты «нежелательного». Источники:
//  • docs.novelai.net/en/image/* — модели, теги, веса, несколько персонажей,
//    Precise Reference, теги качества, пресеты нежелательного, текст в картинке;
//  • код живых клиентов: SillyTavern (src/endpoints/novelai.js) — формат запроса
//    V4/V4.5; novelai-python 0.9.2 (повторяет веб-клиент) — формат V5, рефы,
//    цены, ответ о подписке.
//
// Вход — постоянный токен из настроек аккаунта NovelAI (pst-…), заголовок
// Authorization: Bearer. Ответ генерации — zip с PNG внутри.

export const NAI_BASE = 'https://image.novelai.net';

export interface NaiModel {
  id: string;
  label: string;
  /** Семейство: формат запроса, лимиты, теги. */
  family: 'v5' | 'v45' | 'v4' | 'v3';
  /** Curated — «безопасная», NSFW не рисует. */
  curated?: boolean;
  /** Быстрая V5 Medium: веб-клиент жёстко ставит 14 шагов. */
  medium?: boolean;
}

export const NAI_MODELS: NaiModel[] = [
  { id: 'nai-diffusion-5-full', label: 'V5 Full', family: 'v5' },
  { id: 'nai-diffusion-5-full-medium', label: 'V5 Full Medium (быстрая)', family: 'v5', medium: true },
  { id: 'nai-diffusion-5-curated', label: 'V5 Curated (без NSFW)', family: 'v5', curated: true },
  { id: 'nai-diffusion-4-5-full', label: 'V4.5 Full', family: 'v45' },
  { id: 'nai-diffusion-4-5-curated', label: 'V4.5 Curated (без NSFW)', family: 'v45', curated: true },
  { id: 'nai-diffusion-4-full', label: 'V4 Full', family: 'v4' },
  { id: 'nai-diffusion-4-curated-preview', label: 'V4 Curated (без NSFW)', family: 'v4', curated: true },
  { id: 'nai-diffusion-3', label: 'Anime V3', family: 'v3' },
];

export const DEFAULT_NAI_MODEL = 'nai-diffusion-4-5-full';

export function naiModel(id: string | undefined): NaiModel {
  return NAI_MODELS.find((m) => m.id === id) ?? NAI_MODELS.find((m) => m.id === DEFAULT_NAI_MODEL)!;
}

/** Сколько персонажей модель различает отдельными промптами (docs: V5 — 22, V4/V4.5 — 6). */
export function naiMaxCharacters(m: NaiModel): number {
  return m.family === 'v5' ? 22 : m.family === 'v3' ? 0 : 6;
}

/** Реф персонажа (Precise Reference) — только V4.5 (docs.novelai.net/en/image/precisereference). */
export function naiSupportsRefs(m: NaiModel): boolean {
  return m.family === 'v45';
}

// Теги качества — дословно со страницы «Add Quality Tags»: дописываются в конец
// общего промпта (перед «Text:»), как это делает веб-клиент.
export function naiQualitySuffix(m: NaiModel): string {
  switch (m.id) {
    case 'nai-diffusion-5-full':
    case 'nai-diffusion-5-full-medium':
    case 'nai-diffusion-5-curated':
      return 'very aesthetic, masterpiece, no text';
    case 'nai-diffusion-4-5-full':
      return 'location, very aesthetic, masterpiece, no text';
    case 'nai-diffusion-4-5-curated':
      return 'location, masterpiece, no text, -0.8::feet::, rating:general';
    case 'nai-diffusion-4-full':
      return 'no text, best quality, very aesthetic, absurdres';
    case 'nai-diffusion-4-curated-preview':
      return 'rating:general, amazing quality, very aesthetic, absurdres';
    default:
      return 'best quality, amazing quality, very aesthetic, absurdres';
  }
}

export type NaiUcPreset = 'heavy' | 'light' | 'human' | 'none';

// Пресеты «нежелательного» — дословно со страницы «Undesired Content». Веб-клиент
// ещё ставит перед каждым «nsfw»; мы — нет: что рисовать, решает сцена, а не пресет.
const UC: Record<NaiModel['family'] | 'v45c' | 'v4c', Partial<Record<NaiUcPreset, string>>> = {
  v5: {
    heavy:
      'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page',
    light: 'lowres, bad hands, bad anatomy, artistic error, sepia, white haze, worst quality, very displeasing, jpeg artifacts, 0::ai-generated::',
    human:
      'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page, @_@, mismatched pupils, glowing eyes, bad anatomy',
  },
  v45: {
    heavy:
      'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page',
    light:
      'lowres, artistic error, scan artifacts, worst quality, bad quality, jpeg artifacts, multiple views, very displeasing, too many watermarks, negative space, blank page',
    human:
      'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page, @_@, mismatched pupils, glowing eyes, bad anatomy',
  },
  v45c: {
    heavy:
      'blurry, lowres, upscaled, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, halftone, multiple views, logo, too many watermarks, negative space, blank page',
    light: 'blurry, lowres, upscaled, artistic error, scan artifacts, jpeg artifacts, logo, too many watermarks, negative space, blank page',
    human:
      'blurry, lowres, upscaled, artistic error, film grain, scan artifacts, bad anatomy, bad hands, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, halftone, multiple views, logo, too many watermarks, @_@, mismatched pupils, glowing eyes, negative space, blank page',
  },
  v4: {
    heavy:
      'blurry, lowres, error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, multiple views, logo, too many watermarks',
    light: 'blurry, lowres, error, worst quality, bad quality, jpeg artifacts, very displeasing',
  },
  v4c: {
    heavy:
      'blurry, lowres, error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, logo, dated, signature, multiple views, gigantic breasts',
    light: 'blurry, lowres, error, worst quality, bad quality, jpeg artifacts, very displeasing, logo, dated, signature',
  },
  v3: {
    heavy:
      'lowres, {bad}, error, fewer, extra, missing, worst quality, jpeg artifacts, bad quality, watermark, unfinished, displeasing, chromatic aberration, signature, extra digits, artistic error, username, scan, [abstract]',
    light: 'lowres, jpeg artifacts, worst quality, watermark, blurry, very displeasing',
    human:
      'lowres, {bad}, error, fewer, extra, missing, worst quality, jpeg artifacts, bad quality, watermark, unfinished, displeasing, chromatic aberration, signature, extra digits, artistic error, username, scan, [abstract], bad anatomy, bad hands, @_@, mismatched pupils, heart-shaped pupils, glowing eyes',
  },
};

export function naiUcPresetText(m: NaiModel, preset: NaiUcPreset): string {
  if (preset === 'none') return '';
  const key = m.family === 'v45' && m.curated ? 'v45c' : m.family === 'v4' && m.curated ? 'v4c' : m.family;
  const set = UC[key];
  // Пресета нет у модели (Human Focus у V4) — ближайший: Heavy.
  return set[preset] ?? set.heavy ?? '';
}

// ── Размер кадра ──────────────────────────────────────────────────────────────
// Бесплатно на Opus: до 1 048 576 пикселей и до 28 шагов, по одной картинке
// (docs: basics). Стороны кратны 64. Таблица — канонические размеры под ~1 Мп.
const FREE_SIZES: Record<ImageAspectRatio, [number, number]> = {
  '1:1': [1024, 1024],
  '2:3': [832, 1216],
  '3:2': [1216, 832],
  '3:4': [896, 1152],
  '4:3': [1152, 896],
  '9:16': [768, 1344],
  '16:9': [1344, 768],
  '21:9': [1536, 640],
};

export function naiSize(ratio: ImageAspectRatio, freeOnly: boolean, tier: ImageSizeTier = '1K'): { width: number; height: number } {
  const [w, h] = FREE_SIZES[ratio] ?? FREE_SIZES['2:3'];
  if (freeOnly || tier === '1K') return { width: w, height: h };
  const k = tier === '4K' ? 1.5 : 1.25;
  const r64 = (n: number) => Math.round((n * k) / 64) * 64;
  return { width: r64(w), height: r64(h) };
}

export function naiSteps(m: NaiModel): number {
  if (m.medium) return 14;
  return m.family === 'v45' ? 28 : 23;
}

function naiScale(m: NaiModel): number {
  return m.family === 'v5' ? 7 : m.family === 'v4' ? 5.5 : 5;
}

// ── Промпт ────────────────────────────────────────────────────────────────────

export interface NaiCharacter {
  prompt: string;
  uc?: string;
  /** Центр персонажа в кадре, 0.1…0.9; нет — на усмотрение модели. */
  center?: { x: number; y: number };
}

export interface NaiScene {
  base: string;
  characters: NaiCharacter[];
  negative: string;
}

/**
 * Промпт в синтаксисе NovelAI «сцена | персонаж | персонаж» (docs: multiple
 * characters, «|»-синтаксис). В нём промпт и хранится, и показывается, и правится
 * руками — а в запрос уходит уже разобранным на base и char_captions.
 * «||» — экранированная черта, не разделитель.
 */
export function splitNaiPrompt(text: string): { base: string; characters: string[] } {
  const ESC = '\u0001';
  const parts = text.replace(/\|\|/g, ESC).split('|').map((p) => p.replace(new RegExp(ESC, 'g'), '||').trim());
  return { base: parts[0] || '', characters: parts.slice(1).filter(Boolean) };
}

export function joinNaiPrompt(base: string, characters: string[]): string {
  return [base, ...characters].map((s) => s.trim()).filter(Boolean).join(' | ');
}

/** Дописать теги качества в конец общего промпта — перед «Text:», который должен идти последним. */
export function withQuality(base: string, m: NaiModel): string {
  const q = naiQualitySuffix(m);
  if (!q || base.includes(q)) return base;
  const at = base.search(/\s*\bText:/);
  if (at < 0) return `${base.replace(/[\s,]+$/, '')}, ${q}`;
  return `${base.slice(0, at).replace(/[\s,.]+$/, '')}, ${q}. ${base.slice(at).trim()}`;
}

/**
 * Вставить теги стиля в общий промпт — СРАЗУ ЗА тегами количества: «art style
 * tags close to the start of the prompt, which is where they're more likely to
 * have a greater effect» (docs: tutorial-artstyles), а порядок «1boy, 1girl,
 * characters, series, everything else» (docs: tags).
 */
export function withStyle(base: string, style: string): string {
  const s = style.trim().replace(/^[,\s]+|[,\s]+$/g, '');
  if (!s) return base;
  const at = base.search(/\bText:/);
  const tags = (at >= 0 ? base.slice(0, at) : base).replace(/[\s,.]+$/, '');
  const text = at >= 0 ? base.slice(at).trim() : '';
  const parts = tags.split(',');
  let i = 0;
  while (i < parts.length && COUNT_TAG.test(parts[i].trim())) i++;
  const head = parts.slice(0, i).map((t) => t.trim());
  const rest = parts.slice(i).join(',').trim();
  return [...head, s, rest].filter(Boolean).join(', ') + (text ? `. ${text}` : '');
}

// ── Нормализация промпта ──────────────────────────────────────────────────────
// Правила NovelAI, которые выполняет КОД, а не модель-воркер: она может их забыть,
// а от них зависит, сколько людей будет на картинке и кто есть кто.

const COUNT_TAG = /^(\d+\+?(girl|boy|other)s?|multiple (girls|boys|others)|solo|no humans)$/i;
const QUALITY_TAGS = new Set(['masterpiece', 'best quality', 'amazing quality', 'great quality', 'high quality', 'very aesthetic', 'absurdres', 'highres']);

const splitTags = (s: string) => s.split(',').map((t) => t.trim()).filter(Boolean);

/** Подчёркивания Danbooru → пробелы (в NovelAI теги пишутся через пробел). */
function unscore(s: string): string {
  return s.replace(/([\p{L}\p{N}])_(?=[\p{L}\p{N}(])/gu, '$1 ');
}

function dedupe(tags: string[]): string[] {
  const seen = new Set<string>();
  return tags.filter((t) => {
    const k = t.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** V4/V4.5 — токенайзер T5, V3 — CLIP: «most Unicode characters … are not supported» (docs: models). */
function asciiOnly(s: string): string {
  return s
    .replace(/[«»“”„]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[—–]/g, '-')
    .replace(/…/g, '...')
    .replace(/[^\x20-\x7E\n]/g, '')
    .replace(/ {2,}/g, ' ');
}

type Subject = 'girl' | 'boy' | 'other';

function subjectOf(prompt: string): Subject {
  const tags = splitTags(prompt.toLowerCase());
  const first = (tags[0] || '').replace(/^\d+\+?/, '').replace(/s$/, '');
  if (first === 'girl' || first === 'boy' || first === 'other') return first;
  const all = ` ${tags.join(' ')} `;
  if (/\b(\d*girls?|woman|female|lady|maid)\b/.test(all)) return 'girl';
  if (/\b(\d*boys?|man|male|guy)\b/.test(all)) return 'boy';
  return 'other';
}

/** Промпт персонажа: первым — girl / boy / other без числа (docs: multiple characters). */
export function normalizeCharacterPrompt(prompt: string): string {
  const subject = subjectOf(prompt);
  const tags = splitTags(unscore(prompt)).filter((t) => !COUNT_TAG.test(t) && !/^(girl|boy|other)$/i.test(t));
  return [subject, ...dedupe(tags)].join(', ');
}

/** Теги количества по составу: 2girls, 1boy… (+ solo для одного) — в общий промпт. */
export function countTags(characters: string[]): string[] {
  const n = { girl: 0, boy: 0, other: 0 };
  for (const c of characters) n[subjectOf(c)]++;
  const out: string[] = [];
  for (const k of ['girl', 'boy', 'other'] as const) {
    const v = n[k];
    if (!v) continue;
    out.push(v >= 6 ? `6+${k}s` : `${v}${k}${v > 1 ? 's' : ''}`);
  }
  if (characters.length === 1) out.push('solo');
  return out;
}

/**
 * Привести сцену к правилам NovelAI перед отправкой:
 *  • персонажи — girl/boy/other первым, без чисел, без дублей;
 *  • теги количества в общем промпте пересчитаны по персонажам и стоят первыми
 *    («These tags should always go into the base prompt», docs: multiple characters);
 *  • теги качества модели — не дублировать (их добавит галочка);
 *  • «Text:» — последним (docs: text rendering);
 *  • V3/V4/V4.5 — без символов, которых не знает их токенайзер.
 */
export function normalizeNaiScene(
  scene: { base: string; characters: string[] },
  model: NaiModel,
  opts: { quality: boolean }
): { base: string; characters: string[] } {
  const ascii = model.family !== 'v5';
  const fix = (s: string) => (ascii ? asciiOnly(unscore(s)) : unscore(s));
  // Один к одному со входом: к персонажу привязаны его «нежелательное» и место в кадре.
  const characters = scene.characters.map((c) => normalizeCharacterPrompt(fix(c)));
  // Текст в картинке — отдельно: он не теги, и делить его по запятым нельзя.
  const tAt = scene.base.search(/\bText:/);
  const text = tAt >= 0 ? scene.base.slice(tAt).trim() : '';
  let tags = splitTags(fix(tAt >= 0 ? scene.base.slice(0, tAt) : scene.base).replace(/[.\s]+$/, ''));
  if (opts.quality) tags = tags.filter((t) => !QUALITY_TAGS.has(t.toLowerCase()));
  if (characters.length) {
    tags = tags.filter((t) => !COUNT_TAG.test(t));
    tags = [...countTags(characters), ...tags];
  }
  const base = dedupe(tags).join(', ') + (text ? `. ${ascii ? asciiOnly(text) : text}` : '');
  return { base, characters };
}

// ── Реф персонажа (V4.5) ──────────────────────────────────────────────────────
// Картинка всегда вписывается в один из трёх размеров (docs: precise reference) —
// по ближайшему соотношению, по центру, на чёрном.
const DIRECTOR_SIZES: [number, number][] = [
  [1024, 1536],
  [1536, 1024],
  [1472, 1472],
];

export async function padDirectorRef(b64: string, mime: string): Promise<string> {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return b64;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const bmp = await createImageBitmap(new Blob([bytes], { type: mime }));
  const aspect = bmp.width / bmp.height;
  const [W, H] = DIRECTOR_SIZES.reduce((best, s) => (Math.abs(s[0] / s[1] - aspect) < Math.abs(best[0] / best[1] - aspect) ? s : best));
  const k = Math.min(W / bmp.width, H / bmp.height);
  const w = Math.max(1, Math.round(bmp.width * k));
  const h = Math.max(1, Math.round(bmp.height * k));
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(bmp, Math.round((W - w) / 2), Math.round((H - h) / 2), w, h);
  bmp.close?.();
  const out = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
  if (!out) return b64;
  const buf = new Uint8Array(await out.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

export interface NaiRef {
  /** PNG base64, уже вписанный в размер директора. */
  b64: string;
  type: 'character' | 'character&style';
  strength: number;
  fidelity: number;
}

// ── Тело запроса ──────────────────────────────────────────────────────────────

export interface NaiRequest {
  model: NaiModel;
  scene: NaiScene;
  width: number;
  height: number;
  steps: number;
  ucPreset: NaiUcPreset;
  quality: boolean;
  ref?: NaiRef;
  seed?: number;
}

function captions(scene: NaiScene) {
  const centered = scene.characters.some((c) => c.center);
  // Без позиции — (0, 0): так веб-клиент пишет «на усмотрение модели» (AI's Choice).
  const center = (c: NaiCharacter) => [c.center ?? { x: 0, y: 0 }];
  return {
    useCoords: centered,
    characterPrompts: scene.characters.map((c) => ({ prompt: c.prompt, uc: c.uc ?? '', center: c.center ?? { x: 0, y: 0 }, enabled: true })),
    v4_prompt: {
      caption: { base_caption: scene.base, char_captions: scene.characters.map((c) => ({ char_caption: c.prompt, centers: center(c) })) },
      use_coords: centered,
      use_order: true,
    },
    v4_negative_prompt: {
      caption: { base_caption: scene.negative, char_captions: scene.characters.map((c) => ({ char_caption: c.uc ?? '', centers: center(c) })) },
      legacy_uc: false,
    },
  };
}

/** Формат 3 (JSON): так рисуют V4/V4.5 в SillyTavern; V3 — без полей V4. */
export function naiBodyV3(r: NaiRequest): Record<string, unknown> {
  const seed = r.seed ?? Math.floor(Math.random() * 4294967295);
  const params: Record<string, unknown> = {
    params_version: 3,
    width: r.width,
    height: r.height,
    scale: naiScale(r.model),
    sampler: 'k_euler_ancestral',
    noise_schedule: 'karras',
    steps: r.steps,
    n_samples: 1,
    seed,
    negative_prompt: r.scene.negative,
    ucPreset: 0,
    qualityToggle: false,
    prefer_brownian: true,
    cfg_rescale: 0,
    sm: false,
    sm_dyn: false,
    dynamic_thresholding: false,
    legacy: false,
    legacy_v3_extend: false,
    deliberate_euler_ancestral_bug: false,
    add_original_image: false,
    controlnet_strength: 1,
    skip_cfg_above_sigma: null,
  };
  if (r.model.family !== 'v3') {
    const c = captions(r.scene);
    Object.assign(params, {
      use_coords: c.useCoords,
      characterPrompts: c.characterPrompts,
      v4_prompt: c.v4_prompt,
      v4_negative_prompt: c.v4_negative_prompt,
    });
  }
  if (r.ref) {
    Object.assign(params, {
      director_reference_images: [r.ref.b64],
      director_reference_descriptions: [{ caption: { base_caption: r.ref.type, char_captions: [] }, legacy_uc: false }],
      director_reference_information_extracted: [1],
      director_reference_strength_values: [r.ref.strength],
      director_reference_secondary_strength_values: [Math.round((1 - r.ref.fidelity) * 10000) / 10000],
    });
  }
  const input = r.model.family === 'v3' ? joinNaiPrompt(r.scene.base, r.scene.characters.map((c) => c.prompt)) : r.scene.base;
  return { input, model: r.model.id, action: 'generate', parameters: params };
}

/**
 * Формат 4 (multipart): так шлёт нынешний веб-клиент, V5 принимает только его.
 * JSON — частью «request», картинки (реф) — отдельными частями, на которые
 * ссылаются поля *_cached.
 */
export function naiBodyV4(r: NaiRequest): FormData {
  const seed = r.seed ?? Math.floor(Math.random() * 4294967295);
  const c = captions(r.scene);
  const params: Record<string, unknown> = {
    params_version: 4,
    width: r.width,
    height: r.height,
    scale: naiScale(r.model),
    sampler: 'k_euler_ancestral',
    noise_schedule: 'karras',
    steps: r.steps,
    n_samples: 1,
    seed,
    negative_prompt: r.scene.negative,
    ucPresetId: r.ucPreset,
    qualityPresetId: r.quality ? 'standard' : 'none',
    prefer_brownian: true,
    cfg_rescale: 0,
    dynamic_thresholding: false,
    legacy: false,
    legacy_uc: false,
    legacy_v3_extend: false,
    deliberate_euler_ancestral_bug: false,
    add_original_image: false,
    controlnet_strength: 1,
    autoSmea: false,
    skip_cfg_above_sigma: null,
    image_format: 'png',
    use_coords: c.useCoords,
    characterPrompts: c.characterPrompts,
    v4_prompt: c.v4_prompt,
    v4_negative_prompt: c.v4_negative_prompt,
  };
  const form = new FormData();
  if (r.ref) {
    const key = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
    params.director_reference_images_cached = [{ cache_secret_key: key, data: 'director_ref_0' }];
    params.director_reference_descriptions = [{ caption: { base_caption: r.ref.type, char_captions: [] }, legacy_uc: false }];
    params.director_reference_information_extracted = [1];
    params.director_reference_strength_values = [r.ref.strength];
    params.director_reference_secondary_strength_values = [Math.round((1 - r.ref.fidelity) * 10000) / 10000];
    const bin = atob(r.ref.b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    form.append('director_ref_0', new Blob([bytes], { type: 'image/png' }), 'blob');
  }
  const json = JSON.stringify({ input: r.scene.base, model: r.model.id, action: 'generate', parameters: params });
  form.append('request', new Blob([json], { type: 'application/json' }), 'blob');
  return form;
}

// ── Ответ ─────────────────────────────────────────────────────────────────────

/** zip с картинкой (обычно image_0.png) или голая картинка. */
export async function naiImageFromResponse(buf: ArrayBuffer): Promise<Blob> {
  const b = new Uint8Array(buf);
  const isZip = b[0] === 0x50 && b[1] === 0x4b;
  if (!isZip) {
    const png = b[0] === 0x89 && b[1] === 0x50;
    const jpg = b[0] === 0xff && b[1] === 0xd8;
    const webp = b[8] === 0x57 && b[9] === 0x45;
    if (png || jpg || webp) return new Blob([buf], { type: png ? 'image/png' : jpg ? 'image/jpeg' : 'image/webp' });
    throw new Error('NovelAI прислал не картинку: ' + new TextDecoder().decode(b.slice(0, 300)));
  }
  const zip = await JSZip.loadAsync(buf);
  const name = Object.keys(zip.files).find((n) => /\.(png|webp|jpe?g)$/i.test(n));
  if (!name) throw new Error('В ответе NovelAI нет картинки');
  const data = await zip.files[name].async('arraybuffer');
  const mime = /\.png$/i.test(name) ? 'image/png' : /\.webp$/i.test(name) ? 'image/webp' : 'image/jpeg';
  return new Blob([data], { type: mime });
}

// ── Подписка ──────────────────────────────────────────────────────────────────

export interface NaiAccount {
  tier: number;
  tierName: string;
  active: boolean;
  anlas: number;
  /** Полоса лимита V5 у Opus ниже нуля — V5 сейчас за Anlas. */
  v5UsageNegative?: boolean;
  v5UsagePercent?: number;
  /** /user/information: аккаунт на пробном доступе (картинки — только с капчей на сайте). */
  trialActivated?: boolean;
  trialImagesLeft?: number;
}

/** Дополнить сведениями /user/information (пробный доступ) — если сервер их отдал. */
export function withNaiInformation(a: NaiAccount, info: any): NaiAccount {
  if (!info || typeof info !== 'object') return a;
  return {
    ...a,
    ...(typeof info.trialActivated === 'boolean' ? { trialActivated: info.trialActivated } : {}),
    ...(typeof info.trialImagesLeft === 'number' ? { trialImagesLeft: info.trialImagesLeft } : {}),
  };
}

/** Ответ NovelAI «нужна капча для пробной генерации»: аккаунт токена без подписки. */
export function isNaiTrialError(text: string): boolean {
  return /recaptcha|trial generation/i.test(text);
}

const TIER_NAMES = ['Paper (бесплатный)', 'Tablet', 'Scroll', 'Opus'];

export function parseNaiAccount(d: any): NaiAccount {
  const steps = d?.trainingStepsLeft || {};
  return {
    tier: Number(d?.tier ?? 0),
    tierName: TIER_NAMES[Number(d?.tier ?? 0)] ?? String(d?.tier),
    active: !!d?.active,
    anlas: Number(steps.fixedTrainingStepsLeft ?? 0) + Number(steps.purchasedTrainingSteps ?? 0),
    v5UsageNegative: d?.usage ? !!d.usage.isNegative : undefined,
    v5UsagePercent: d?.usage ? Number(d.usage.percent ?? 0) : undefined,
  };
}

// ── Веса ─────────────────────────────────────────────────────────────────────
// Синтаксис NovelAI (docs: strengthening-weakening): «1.5::rain, night ::» —
// числом (V4+), «-1::hat ::» — отрицательный (V4.5+), {…} ×1.05, […] ÷1.05.
// Модели-помощники часто пишут по привычке Stable Diffusion: «(tag:1.3)» — это
// NovelAI не поймёт, переводим. А что модель не умеет — убираем с пометкой.

export interface WeightFix {
  text: string;
  /** Что пришлось убрать или переделать — сказать человеку. */
  notes: string[];
}

const braces = (w: number, body: string) => {
  const n = Math.min(8, Math.max(1, Math.round(Math.abs(Math.log(w) / Math.log(1.05)))));
  return w >= 1 ? `${'{'.repeat(n)}${body}${'}'.repeat(n)}` : `${'['.repeat(n)}${body}${']'.repeat(n)}`;
};

export function fixNaiWeights(text: string, m: NaiModel): WeightFix {
  const notes: string[] = [];
  // (tag:1.3) / (tag) — синтаксис SD.
  let t = text.replace(/\(([^()]+?):\s*(-?\d+(?:\.\d+)?)\)/g, (_all, body: string, w: string) => `${Number(w)}::${body.trim()}::`);
  const numeric = /(-?\d+(?:\.\d+)?)::((?:(?!::).)*?)\s*::/g;
  if (m.family === 'v3') {
    t = t.replace(numeric, (_a, w: string, body: string) => {
      const v = Number(w);
      if (v <= 0) {
        notes.push(`«${body.trim()}» с отрицательным весом убран — у Anime V3 его нет, перенесите в «нежелательное»`);
        return '';
      }
      return braces(v, body.trim());
    });
  } else if (m.family === 'v4') {
    t = t.replace(numeric, (all, w: string, body: string) => {
      if (Number(w) >= 0) return all;
      notes.push(`«${body.trim()}» с отрицательным весом убран — он работает только с V4.5, перенесите в «нежелательное»`);
      return '';
    });
  }
  t = t
    .replace(/\s*,\s*(,\s*)+/g, ', ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,]+|[\s,]+$/g, '');
  return { text: t, notes };
}
