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
  const base = (cfg.baseUrl || DEFAULT_GEMINI_BASE).replace(/\/$/, '');
  const model = cfg.model || DEFAULT_GEMINI_MODEL;

  const parts: any[] = [{ text: input.prompt }];
  for (const r of input.references || []) {
    parts.push({ inline_data: { mime_type: r.mime, data: r.b64 } });
  }

  const res = await netFetch(`${base}/models/${model}:generateContent`, {
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
    throw new Error(`Image-провайдер вернул ${res.status}: ${cleanErr(text)}`);
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
  const base = (cfg.baseUrl || getConnection().baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = cfg.model || DEFAULT_OPENAI_MODEL;

  const res = await netFetch(`${base}/images/generations`, {
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
    throw new Error(`Image-провайдер вернул ${res.status}: ${cleanErr(text)}`);
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
