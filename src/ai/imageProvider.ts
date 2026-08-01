import type { ImageGenConfig, ImageAspectRatio, ImageSizeTier } from '../shared/types';
import { getApiKey } from './keys';
import { getConnection } from './connection';
import { netFetch } from './providers';

// Генерация изображений для CG-студии. Три бэкенда (выбор в CG-студии):
//  • gemini      — родной Google generateContent («Nano Banana»): принимает РЕФЕРЕНСЫ
//    (инлайн-картинки) → консистентные персонажи. Модель напр. gemini-2.5-flash-image.
//  • openai      — OpenAI-совместимый /images/generations (текст→картинка, без рефов).
//  • openai_chat — OpenAI-совместимый /chat/completions с картинкой В ОТВЕТЕ: так
//    устроены роутеры-агрегаторы (OpenRouter и клоны), где ручки /images/generations
//    нет вовсе, а рисует модель вида google/gemini-…-image. Рефы работают.
// Запросы идут через локальный прокси (netFetch) — без CORS, как остальной ИИ.
// Ключ — только в localStorage (роль 'image').

const DEFAULT_GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash-image';
const DEFAULT_OPENAI_MODEL = 'gpt-image-1';
const DEFAULT_CHAT_MODEL = 'google/gemini-2.5-flash-image-preview';

export interface ImageRef {
  mime: string;
  b64: string; // base64 без префикса data:
}

export interface ImageGenInput {
  prompt: string; // финальный текст (воркер-промпт + стиль)
  references?: ImageRef[]; // gemini и openai_chat
  // Переопределение кадра для конкретного вызова: фон просим горизонтальным,
  // селфи — вертикальным, независимо от настройки проекта.
  aspectRatio?: ImageAspectRatio;
  size?: string; // явный WxH (побеждает расчёт по соотношению) — редко нужен
  signal?: AbortSignal;
}

// Кадр запроса: соотношение из вызова → из настроек проекта → 16:9.
function frame(cfg: ImageGenConfig, input: ImageGenInput): { ratio: ImageAspectRatio; tier: ImageSizeTier } {
  return {
    ratio: input.aspectRatio || cfg.aspectRatio || '16:9',
    tier: cfg.imageSize || '1K',
  };
}

// Пиксели для /images/generations. У OpenAI список размеров закрытый (три варианта),
// поэтому на 1K отдаём канонические значения; выше — считаем по соотношению и
// округляем до кратного 64 (так принимают шлюзы с произвольными размерами).
function pixelSize(ratio: ImageAspectRatio, tier: ImageSizeTier): string {
  if (tier === '1K') {
    const [w, h] = ratio.split(':').map(Number);
    if (w === h) return '1024x1024';
    return w > h ? '1536x1024' : '1024x1536';
  }
  const base = tier === '4K' ? 4096 : 2048;
  const [rw, rh] = ratio.split(':').map(Number);
  const round64 = (n: number) => Math.max(256, Math.round(n / 64) * 64);
  return rw >= rh
    ? `${round64(base)}x${round64((base * rh) / rw)}`
    : `${round64((base * rw) / rh)}x${round64(base)}`;
}

// Эффективный Base URL. ВАЖНО: у openai-пути пустое поле раньше молча подставляло
// адрес ОСНОВНОГО (текстового) подключения — обычный LLM-шлюз, который /images/
// generations не умеет и отвечает 404. Теперь адрес виден в UI и в тексте ошибки.
export function effectiveImageBase(cfg: ImageGenConfig): string {
  const raw = (cfg.baseUrl || '').trim().replace(/\/+$/, '');
  if (cfg.providerKind === 'gemini') {
    if (!raw) return DEFAULT_GEMINI_BASE;
    // Частая опечатка: адрес Google без версии — тогда любой путь даёт 404.
    if (/generativelanguage\.googleapis\.com$/i.test(raw)) return `${raw}/v1beta`;
    return raw;
  }
  return raw || getConnection().baseUrl?.replace(/\/+$/, '') || 'https://api.openai.com/v1';
}

export function effectiveImageModel(cfg: ImageGenConfig): string {
  const m = (cfg.model || '').trim();
  if (m) return m;
  if (cfg.providerKind === 'gemini') return DEFAULT_GEMINI_MODEL;
  return cfg.providerKind === 'openai_chat' ? DEFAULT_CHAT_MODEL : DEFAULT_OPENAI_MODEL;
}

// Ошибка image-API с точным адресом, по которому мы стучались: 404 почти всегда
// значит «этот адрес не умеет картинки» (вписан текстовый шлюз) или опечатку в пути.
function imageHttpError(status: number, url: string, body: string, cfg?: ImageGenConfig): Error {
  const detail = cleanErr(body);
  // Самая частая причина 404 — выбран не тот ПРОТОКОЛ для этого шлюза. Родной путь
  // Google на OpenAI-совместимом шлюзе (и наоборот) не существует — отсюда 404,
  // хотя ключ рабочий и список моделей тот же адрес отдаёт без проблем.
  const googleBase = /generativelanguage\.googleapis\.com/i.test(url);
  const protocolHint =
    cfg?.providerKind === 'gemini' && !googleBase
      ? 'выбран родной протокол Google, но адрес — сторонний шлюз (он такого пути не знает). Переключите провайдер на «OpenAI-совместимый чат» — так рисуют роутеры вроде OpenRouter.'
      : cfg?.providerKind === 'openai'
        ? 'у этого шлюза нет ручки /images/generations. Если он роутер (модели вида google/…, openai/…), выберите «OpenAI-совместимый чат».'
        : '';
  const hint =
    status === 404
      ? protocolHint ||
        'адрес не найден. Обычно это значит, что в Base URL вписан текстовый LLM-шлюз, который генерацию картинок не поддерживает, либо неверный путь/модель.'
      : status === 401 || status === 403
        ? 'ключ не принят (неверный, не тот провайдер или нет доступа к image-модели).'
        : status === 429
          ? 'лимит запросов у провайдера — подождите и повторите.'
          : '';
  return new Error(
    `Image-провайдер вернул ${status}${hint ? `: ${hint}` : ''}\nЗапрос: ${url}${detail ? `\nОтвет: ${detail}` : ''}`
  );
}

function b64ToBlob(b64: string, mime = 'image/png'): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export async function generateImage(cfg: ImageGenConfig, input: ImageGenInput): Promise<Blob> {
  if (cfg.providerKind === 'gemini') return generateGemini(cfg, input);
  if (cfg.providerKind === 'openai_chat') return generateOpenAiChat(cfg, input);
  return generateOpenAI(cfg, input);
}

// Рефы поддерживают родной Gemini и чат-путь (картинка уходит частью сообщения).
export function supportsReferences(cfg: ImageGenConfig): boolean {
  return cfg.providerKind === 'gemini' || cfg.providerKind === 'openai_chat';
}

// ---- Gemini (Nano Banana) ----
async function generateGemini(cfg: ImageGenConfig, input: ImageGenInput): Promise<Blob> {
  const key = getApiKey('image');
  const base = effectiveImageBase(cfg);
  const model = effectiveImageModel(cfg);

  const parts: any[] = [{ text: input.prompt }];
  for (const r of input.references || []) {
    parts.push({ inline_data: { mime_type: r.mime, data: r.b64 } });
  }

  // Кадр — родными параметрами Nano Banana: imageConfig.aspectRatio + imageSize
  // (2K/4K умеет только Pro-модель, поэтому на отказ повторяем без размера).
  const { ratio, tier } = frame(cfg, input);
  const url = `${base}/models/${model}:generateContent`;
  const send = (imageConfig: Record<string, unknown>) =>
    netFetch(url, {
      method: 'POST',
      signal: input.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { 'x-goog-api-key': key } : {}),
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: { responseModalities: ['IMAGE'], imageConfig },
      }),
    });

  let res = await send(tier === '1K' ? { aspectRatio: ratio } : { aspectRatio: ratio, imageSize: tier });
  if (res.status === 400 && tier !== '1K') {
    const errText = await res.text().catch(() => '');
    if (!/imageSize|image_size/i.test(errText)) throw imageHttpError(400, url, errText, cfg);
    res = await send({ aspectRatio: ratio }); // модель не умеет 2K/4K — рисуем в 1K
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw imageHttpError(res.status, url, text, cfg);
  }
  const data = await res.json();
  const cand = data?.candidates?.[0];
  const outParts: any[] = cand?.content?.parts || [];
  for (const p of outParts) {
    const inline = p.inline_data || p.inlineData;
    if (inline?.data) return b64ToBlob(inline.data, inline.mime_type || inline.mimeType || 'image/png');
  }
  // Модель могла вернуть только текст (напр. отказ) — покажем его.
  const txt = outParts.find((p) => typeof p.text === 'string')?.text;
  throw new Error(`Image-провайдер не вернул картинку${txt ? `: ${txt.slice(0, 200)}` : ''}`);
}

// ---- OpenAI-совместимый ЧАТ с картинкой в ответе ----
// Так рисуют роутеры-агрегаторы (OpenRouter и его клоны): ручки /images/generations
// у них нет, картинка приходит в ответе /chat/completions от модели вида
// google/gemini-…-image. Референсы уходят частями сообщения (data-URL), как в чате.
async function generateOpenAiChat(cfg: ImageGenConfig, input: ImageGenInput): Promise<Blob> {
  const key = getApiKey('image');
  const base = effectiveImageBase(cfg);
  const model = effectiveImageModel(cfg);

  // Единого поля кадра у роутеров нет: просим соотношение и текстом (модель его
  // понимает), и полем image_config — а если шлюз поля не знает, повторяем без него.
  const { ratio, tier } = frame(cfg, input);
  const parts: any[] = [
    { type: 'text', text: `${input.prompt}\n\nOutput image aspect ratio: ${ratio} (${tier} resolution).` },
  ];
  for (const r of input.references || []) {
    parts.push({ type: 'image_url', image_url: { url: `data:${r.mime};base64,${r.b64}` } });
  }
  const url = `${base}/chat/completions`;
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: 'user', content: parts }],
    modalities: ['image', 'text'],
    image_config: { aspect_ratio: ratio },
  };
  const post = (b: Record<string, unknown>) =>
    netFetch(url, {
      method: 'POST',
      signal: input.signal,
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(b),
    });

  let res = await post(body);
  // Часть шлюзов не знает необязательных полей (modalities / image_config) и
  // отвечает 400 — повторяем без них: соотношение всё равно уйдёт текстом.
  if (res.status === 400) {
    const errText = await res.text().catch(() => '');
    if (!/modalit|image_config|unknown|unrecognized|unsupported|invalid.*(field|parameter)/i.test(errText)) {
      throw imageHttpError(400, url, errText, cfg);
    }
    const b2 = { ...body };
    delete b2.modalities;
    delete b2.image_config;
    res = await post(b2);
  }
  if (!res.ok) throw imageHttpError(res.status, url, await res.text().catch(() => ''), cfg);

  const data = await res.json();
  const msg = data?.choices?.[0]?.message;
  const blob = extractChatImage(msg);
  if (blob) return blob;
  const txt = typeof msg?.content === 'string' ? msg.content : '';
  throw new Error(
    `Модель не вернула картинку${txt ? `: ${txt.slice(0, 200)}` : ''}\n` +
      'Убедитесь, что выбрана ИМЕННО картиночная модель (напр. …-image / …-image-preview).'
  );
}

// Картинка в ответе чата приходит в разных формах — разбираем все известные:
// message.images[], message.content[] с image_url / b64_json, голый data-URL.
function extractChatImage(msg: any): Blob | null {
  const fromUrl = (u: unknown): Blob | null => {
    if (typeof u !== 'string') return null;
    const m = /^data:([^;]+);base64,(.+)$/i.exec(u.trim());
    return m ? b64ToBlob(m[2], m[1]) : null;
  };
  const fromPart = (p: any): Blob | null => {
    if (!p || typeof p !== 'object') return null;
    if (typeof p.b64_json === 'string') return b64ToBlob(p.b64_json);
    if (typeof p.data === 'string' && p.mime_type) return b64ToBlob(p.data, p.mime_type);
    const inline = p.inline_data || p.inlineData;
    if (inline?.data) return b64ToBlob(inline.data, inline.mime_type || inline.mimeType || 'image/png');
    return fromUrl(p.image_url?.url ?? p.url ?? p.image);
  };
  for (const p of Array.isArray(msg?.images) ? msg.images : []) {
    const b = fromPart(p);
    if (b) return b;
  }
  for (const p of Array.isArray(msg?.content) ? msg.content : []) {
    const b = fromPart(p);
    if (b) return b;
  }
  return fromUrl(msg?.content);
}

// ---- OpenAI-совместимый /images/generations ----
async function generateOpenAI(cfg: ImageGenConfig, input: ImageGenInput): Promise<Blob> {
  const key = getApiKey('image');
  const base = effectiveImageBase(cfg);
  const model = effectiveImageModel(cfg);

  const url = `${base}/images/generations`;
  const res = await netFetch(url, {
    method: 'POST',
    signal: input.signal,
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({
      model,
      prompt: input.prompt,
      n: 1,
      // Здесь кадр задаётся только пикселями — пересчитываем соотношение в WxH.
      size: input.size || pixelSize(frame(cfg, input).ratio, frame(cfg, input).tier),
      response_format: 'b64_json',
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw imageHttpError(res.status, url, text, cfg);
  }
  const data = await res.json();
  const item = data?.data?.[0];
  if (item?.b64_json) return b64ToBlob(item.b64_json);
  if (item?.url) {
    const img = await netFetch(item.url, {});
    if (!img.ok) throw new Error('Не удалось загрузить сгенерированное изображение по URL');
    return img.blob();
  }
  throw new Error('Пустой ответ image-провайдера');
}

// Список моделей image-провайдера — как ⟳ у основного подключения.
//  • gemini — GET {base}/models (x-goog-api-key): у Google модели приходят как
//    "models/gemini-…"; оставляем только те, что умеют generateContent, и
//    поднимаем картиночные (image / imagen) наверх списка.
//  • openai — GET {base}/models (Bearer), терпимый разбор обёрток.
export async function listImageModels(cfg: ImageGenConfig, apiKey: string): Promise<string[]> {
  const base = effectiveImageBase(cfg);
  const url = `${base}/models`;
  const res = await netFetch(url, {
    headers:
      cfg.providerKind === 'gemini'
        ? apiKey
          ? { 'x-goog-api-key': apiKey }
          : {}
        : apiKey
          ? { Authorization: `Bearer ${apiKey}` }
          : {},
  });
  if (!res.ok) throw imageHttpError(res.status, url, await res.text().catch(() => ''), cfg);
  const data = await res.json();
  const list: any[] = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
  const ids = list
    .filter((m) => {
      if (cfg.providerKind !== 'gemini') return true;
      const methods = m?.supportedGenerationMethods;
      return !Array.isArray(methods) || methods.includes('generateContent');
    })
    .map((m) => (typeof m === 'string' ? m : m?.id || m?.name || m?.model || m?.slug))
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
    .map((id) => id.replace(/^models\//, ''));
  const uniq = Array.from(new Set(ids));
  // Картиночные модели — вперёд: их в общем списке легко не заметить.
  const isImage = (m: string) => /image|imagen|dall|flux|sd|diffusion/i.test(m);
  return [...uniq.filter(isImage).sort(), ...uniq.filter((m) => !isImage(m)).sort()];
}

export async function testImageConnection(
  cfg: ImageGenConfig,
  apiKey: string
): Promise<{ ok: boolean; message: string }> {
  try {
    const models = await listImageModels(cfg, apiKey);
    const model = effectiveImageModel(cfg);
    const known = models.includes(model);
    return {
      ok: true,
      message: `OK · ${models.length} моделей${known ? '' : ` · «${model}» в списке не найдена (возможно, провайдер отдаёт не всё)`}`,
    };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

function cleanErr(s: string): string {
  const t = (s || '').trim();
  const title = /<title[^>]*>([^<]+)<\/title>/i.exec(t)?.[1];
  if (title) return title.trim();
  return t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
}

// Blob картинки → base64-реф (без data:-префикса) для gemini.
export async function blobToRef(blob: Blob): Promise<ImageRef> {
  const b64: string = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
  return { mime: blob.type || 'image/png', b64 };
}
