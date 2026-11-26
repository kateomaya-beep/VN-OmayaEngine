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

/**
 * Реф персонажа (Precise Reference): V4.5 и V5 (сверено с novelai-python —
 * страница документации говорит только о V4.5, но веб-клиент давно умеет и V5).
 * V5 Medium с рефом сайт сам переключает на V5 Full — так же делаем и мы.
 */
export function naiSupportsRefs(m: NaiModel): boolean {
  return m.family === 'v45' || m.family === 'v5';
}

/** «Точность» рефа (Fidelity) есть только у V4.5. */
export function naiRefHasFidelity(m: NaiModel): boolean {
  return m.family === 'v45';
}

/** Сколько рефов принимает модель: V5 — до 16 (как веб-клиент), V4.5 — сливает несколько в одного, шлём один. */
export function naiMaxRefs(m: NaiModel): number {
  return m.family === 'v5' ? 16 : m.family === 'v45' ? 1 : 0;
}

/** С рефом V5 Medium не работает — веб-клиент переключает на V5 Full. */
export function naiModelForRefs(m: NaiModel): NaiModel {
  return m.family === 'v5' && m.medium ? naiModel('nai-diffusion-5-full') : m;
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

// ── NSFW ─────────────────────────────────────────────────────────────────────
// Как у сайта NovelAI (novelai-python повторяет веб-клиент): пресеты
// «нежелательного» у Full-моделей начинаются с «nsfw», и «nsfw» убирается из
// них, только когда он есть в самом промпте. Без «nsfw» в промпте модель рисует
// откровенное «прилично» (грудь без сосков), с «nsfw» в «нежелательном» — тем
// более. Поэтому: явные теги в промпте → «nsfw» в промпт кодом, не надеясь на
// модель-писателя; иначе «nsfw» в «нежелательное», чтобы не «сексуализировать»
// обычные сцены.

const EXPLICIT_RE =
  /\b(nsfw|explicit|uncensored|nude|naked|completely nude|topless|bottomless|nipples?|areolae?|pussy|vagina|vulva|clitoris|penis|testicles|erection|sex|sex from behind|vaginal|anal|oral|fellatio|cunnilingus|paizuri|handjob|footjob|fingering|masturbation|penetration|cum|cum in \w+|after sex|ejaculation|pubic hair|cameltoe)\b/i;

export function isExplicitPrompt(text: string): boolean {
  return EXPLICIT_RE.test(text.replace(/\bText:[\s\S]*$/, ''));
}

/** Есть ли «nsfw» тегом (не внутри слова). */
export const hasNsfwTag = (text: string) => /(^|[,|]\s*|\d::\s*)nsfw\s*(?=,|$|\||\.|::)/i.test(text.trim());

/**
 * «Нежелательное» с правилом сайта для «nsfw»: мода 'story' — «nsfw» в
 * «нежелательном», пока сцена не откровенная; 'never' — всегда.
 * Curated-модели NSFW не рисуют вовсе — им «nsfw» не добавляем (у их пресетов его нет).
 */
export function naiNegativeWithNsfw(m: NaiModel, negative: string, positiveExplicit: boolean, mode: 'story' | 'never'): string {
  const tags = negative.split(',').map((t) => t.trim()).filter(Boolean).filter((t) => t.toLowerCase() !== 'nsfw');
  const block = mode === 'never' || !positiveExplicit;
  return (block && !m.curated ? ['nsfw', ...tags] : tags).join(', ');
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

export function naiScale(m: NaiModel): number {
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
): { base: string; characters: string[]; notes: string[] } {
  const ascii = model.family !== 'v5';
  // Теги без единой латинской буквы (имена кириллицей и т. п.) модель не знает —
  // это шум и на V5, хоть он и понимает юникод. Текст реплик («Text:») не трогаем.
  const noForeignTags = (s: string) =>
    s
      .split(',')
      .filter((t) => !(/\p{L}/u.test(t) && !/[A-Za-z]/.test(t)))
      .join(',');
  const fix = (s: string) => (ascii ? asciiOnly(unscore(noForeignTags(s))) : unscore(noForeignTags(s)));
  const notes: string[] = [];
  let dropped = 0;
  // Текст в картинке — отдельно от тегов: делить по запятым и чистить его нельзя.
  // «Text:» бывает и в конце раздела персонажа (реплика этого персонажа — так
  // пишут комикс-блоки). V4/V4.5 рисуют текст только латиницей: русская реплика
  // там выйдет кашей — убираем её и говорим об этом.
  const splitText = (s: string): [string, string] => {
    const at = s.search(/\bText:/);
    return at >= 0 ? [s.slice(0, at).replace(/[\s,.]+$/, ''), s.slice(at).trim()] : [s, ''];
  };
  const keepText = (t: string): string => {
    if (!t || !ascii) return t;
    if (/[^\x00-\x7F]/.test(t.replace(/[«»“”„‘’—–…]/g, ''))) {
      dropped++;
      return '';
    }
    return asciiOnly(t);
  };
  // Один к одному со входом: к персонажу привязаны его «нежелательное» и место в кадре.
  const characters = scene.characters.map((c) => {
    const [head, t] = splitText(c);
    const text = keepText(t);
    return normalizeCharacterPrompt(fix(head)) + (text ? `. ${text}` : '');
  });
  const [baseHead, baseText] = splitText(scene.base);
  let tags = splitTags(fix(baseHead).replace(/[.\s]+$/, ''));
  if (opts.quality) tags = tags.filter((t) => !QUALITY_TAGS.has(t.toLowerCase()));
  if (characters.length) {
    tags = tags.filter((t) => !COUNT_TAG.test(t));
    tags = [...countTags(characters), ...tags];
  }
  const text = keepText(baseText);
  const base = dedupe(tags).join(', ') + (text ? `. ${text}` : '');
  if (dropped) notes.push(`реплики не на латинице убраны (${dropped}): ${model.label} рисует текст только по-английски — русские реплики получатся на V5`);
  return { base, characters, notes };
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
  /** PNG base64, уже подготовленный под модель (V4.5 — холст с полями, V5 — корзина ~1 Мп). */
  b64: string;
  type: 'character' | 'character&style' | 'style';
  strength: number;
  fidelity: number;
}

/**
 * 97 размеров V5 (как веб-клиент, novelai-python: _director_buckets): для каждой
 * высоты от 4096 до 1024 шагом 64 — самая широкая ширина, кратная 64, в пределах
 * 1 Мп; потом те же, повёрнутые набок.
 */
export const V5_DIRECTOR_BUCKETS: [number, number][] = (() => {
  const portrait: [number, number][] = [];
  for (let h = 4096; h >= 1024; h -= 64) portrait.push([Math.floor(1048576 / (h * 64)) * 64, h]);
  return [...portrait, ...portrait.slice(0, -1).reverse().map(([w, h]) => [h, w] as [number, number])];
})();

/** Ближайшая по соотношению сторон корзина (по логарифму, как веб-клиент). */
export function v5Bucket(width: number, height: number): [number, number] {
  const la = Math.log(width / height);
  let best = V5_DIRECTOR_BUCKETS[0];
  for (const b of V5_DIRECTOR_BUCKETS) if (Math.abs(la - Math.log(b[0] / b[1])) < Math.abs(la - Math.log(best[0] / best[1]))) best = b;
  return best;
}

/** V5: растянуть, чтобы покрыть корзину, и обрезать по центру (cover + center crop). */
export async function bucketDirectorRef(b64: string, mime: string): Promise<string> {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return b64;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const bmp = await createImageBitmap(new Blob([bytes], { type: mime }));
  const [W, H] = v5Bucket(bmp.width, bmp.height);
  if (bmp.width === W && bmp.height === H && mime === 'image/png') {
    bmp.close?.();
    return b64;
  }
  const k = Math.max(W / bmp.width, H / bmp.height);
  const rw = Math.max(Math.floor(bmp.width * k + 0.5), W);
  const rh = Math.max(Math.floor(bmp.height * k + 0.5), H);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, -Math.floor((rw - W) / 2), -Math.floor((rh - H) / 2), rw, rh);
  bmp.close?.();
  const out = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
  if (!out) return b64;
  const buf = new Uint8Array(await out.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Подготовить реф под модель: V5 — корзина, V4.5 — холст директора с чёрными полями. */
export function prepareDirectorRef(m: NaiModel, b64: string, mime: string): Promise<string> {
  return m.family === 'v5' ? bucketDirectorRef(b64, mime) : padDirectorRef(b64, mime);
}

/** Поля director_reference_* (кроме самих картинок). У V5 «точности» нет — вторичная сила 0. */
function refFields(m: NaiModel, refs: NaiRef[]) {
  return {
    director_reference_descriptions: refs.map((r) => ({ caption: { base_caption: r.type, char_captions: [] }, legacy_uc: false })),
    director_reference_information_extracted: refs.map(() => 1),
    director_reference_strength_values: refs.map((r) => r.strength),
    director_reference_secondary_strength_values: refs.map((r) => (naiRefHasFidelity(m) ? Math.round((1 - r.fidelity) * 10000) / 10000 : 0)),
  };
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
  refs?: NaiRef[];
  seed?: number;
  /** Своё; нет — по умолчанию модели. */
  scale?: number;
  cfgRescale?: number;
  sampler?: string;
  noiseSchedule?: string;
  /** Variety+: значение skip_cfg_above_sigma (null — выключено). */
  skipCfgAboveSigma?: number | null;
}

/** Значения по умолчанию, как у сайта NovelAI (см. novelai-python: get_default_params). */
export function naiDefaults(m: NaiModel): { steps: number; scale: number; sampler: string; noiseSchedule: string } {
  return { steps: naiSteps(m), scale: naiScale(m), sampler: 'k_euler_ancestral', noiseSchedule: 'karras' };
}

/**
 * Variety+ — формула SillyTavern: √(пикселей / 832·1216) × 58 для V4.5, × 19 для
 * прочих. У V5 этого параметра нет (novelai-python его убирает).
 */
export function naiVarietySigma(m: NaiModel, width: number, height: number): number | null {
  if (m.family === 'v5') return null;
  return Math.round(Math.sqrt((width * height) / 1011712) * (m.family === 'v45' ? 58 : 19) * 1e6) / 1e6;
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
    scale: r.scale ?? naiScale(r.model),
    sampler: r.sampler ?? 'k_euler_ancestral',
    noise_schedule: r.noiseSchedule ?? 'karras',
    steps: r.steps,
    n_samples: 1,
    seed,
    negative_prompt: r.scene.negative,
    ucPreset: 0,
    qualityToggle: false,
    prefer_brownian: true,
    cfg_rescale: r.cfgRescale ?? 0,
    sm: false,
    sm_dyn: false,
    dynamic_thresholding: false,
    legacy: false,
    legacy_v3_extend: false,
    deliberate_euler_ancestral_bug: false,
    add_original_image: false,
    controlnet_strength: 1,
    skip_cfg_above_sigma: r.skipCfgAboveSigma ?? null,
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
  if (r.refs?.length) {
    Object.assign(params, { director_reference_images: r.refs.map((x) => x.b64), ...refFields(r.model, r.refs) });
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
    scale: r.scale ?? naiScale(r.model),
    sampler: r.sampler ?? 'k_euler_ancestral',
    noise_schedule: r.noiseSchedule ?? 'karras',
    steps: r.steps,
    n_samples: 1,
    seed,
    negative_prompt: r.scene.negative,
    ucPresetId: r.ucPreset,
    qualityPresetId: r.quality ? 'standard' : 'none',
    prefer_brownian: true,
    cfg_rescale: r.cfgRescale ?? 0,
    dynamic_thresholding: false,
    legacy: false,
    legacy_uc: false,
    legacy_v3_extend: false,
    deliberate_euler_ancestral_bug: false,
    add_original_image: true,
    controlnet_strength: 1,
    autoSmea: false,
    skip_cfg_above_sigma: r.skipCfgAboveSigma ?? null,
    image_format: 'png',
    // Как веб-клиент (novelai-python, params_version 4): подсказки модели и прочие
    // поля, которые сайт шлёт всегда. tag_hint_* — константы и у V4.5, и у V5;
    // straight_alpha — только V5.
    tag_hint_qt: 1,
    tag_hint_uc_preset: 2,
    ...(r.model.family === 'v5' ? { straight_alpha: true } : {}),
    inpaintImg2ImgStrength: 1,
    normalize_reference_strength_multiple: true,
    use_coords: c.useCoords,
    characterPrompts: c.characterPrompts,
    v4_prompt: c.v4_prompt,
    v4_negative_prompt: c.v4_negative_prompt,
  };
  const form = new FormData();
  if (r.refs?.length) {
    // Каждая картинка — своей частью director_ref_N, в JSON — ссылки на них (как веб-клиент).
    params.director_reference_images_cached = r.refs.map((x, i) => ({
      cache_secret_key: Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join(''),
      data: `director_ref_${i}`,
    }));
    Object.assign(params, refFields(r.model, r.refs));
    r.refs.forEach((x, i) => {
      const bin = atob(x.b64);
      const bytes = new Uint8Array(bin.length);
      for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
      form.append(`director_ref_${i}`, new Blob([bytes], { type: 'image/png' }), 'blob');
    });
  }
  const json = JSON.stringify({ input: r.scene.base, model: r.model.id, action: 'generate', parameters: params, use_new_shared_trial: false });
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
