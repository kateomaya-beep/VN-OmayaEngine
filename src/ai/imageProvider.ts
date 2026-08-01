import type { ImageGenConfig } from '../shared/types';
import { getApiKey } from './keys';
import { getConnection } from './connection';
import { netFetch } from './providers';

// Генерация изображений для CG-студии. Два бэкенда (выбор в настройках проекта):
//  • gemini  — Google Gemini generateContent («Nano Banana»): принимает РЕФЕРЕНСЫ
//    (инлайн-картинки) → консистентные персонажи. Модель напр. gemini-2.5-flash-image.
//  • openai  — OpenAI-совместимый /images/generations (текст→картинка, без рефов).
// Запросы идут через локальный прокси (netFetch) — без CORS, как остальной ИИ.
// Ключ — только в localStorage (роль 'image').

const DEFAULT_GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash-image';
const DEFAULT_OPENAI_MODEL = 'gpt-image-1';

export interface ImageRef {
  mime: string;
  b64: string; // base64 без префикса data:
}

export interface ImageGenInput {
  prompt: string; // финальный текст (воркер-промпт + стиль)
  references?: ImageRef[]; // только для gemini
  size?: string;
  signal?: AbortSignal;
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
  return (cfg.model || '').trim() || (cfg.providerKind === 'gemini' ? DEFAULT_GEMINI_MODEL : DEFAULT_OPENAI_MODEL);
}

// Ошибка image-API с точным адресом, по которому мы стучались: 404 почти всегда
// значит «этот адрес не умеет картинки» (вписан текстовый шлюз) или опечатку в пути.
function imageHttpError(status: number, url: string, body: string): Error {
  const detail = cleanErr(body);
  const hint =
    status === 404
      ? 'адрес не найден. Обычно это значит, что в Base URL вписан текстовый LLM-шлюз, который генерацию картинок не поддерживает, либо неверный путь/модель.'
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
  return cfg.providerKind === 'gemini' ? generateGemini(cfg, input) : generateOpenAI(cfg, input);
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

  const url = `${base}/models/${model}:generateContent`;
  const res = await netFetch(url, {
    method: 'POST',
    signal: input.signal,
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { 'x-goog-api-key': key } : {}),
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: { responseModalities: ['IMAGE'] },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw imageHttpError(res.status, url, text);
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
      size: input.size || '1024x1024',
      response_format: 'b64_json',
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw imageHttpError(res.status, url, text);
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
  if (!res.ok) throw imageHttpError(res.status, url, await res.text().catch(() => ''));
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
