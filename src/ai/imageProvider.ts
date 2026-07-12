import type { AiConfig } from '../shared/types';
import { getApiKey } from './keys';
import { getConnection } from './connection';

// Image generation via an OpenAI-compatible /images/generations endpoint
// (Nano Banana / Gemini Flash Image / OpenAI images / др.). BYO key — хранится
// только в localStorage (nf_apikey_image). Возвращает Blob картинки.

function b64ToBlob(b64: string, mime = 'image/png'): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export interface ImageGenOptions {
  size?: string; // напр. '1024x1024'
}

export async function generateImage(
  cfg: AiConfig,
  prompt: string,
  opts: ImageGenOptions = {}
): Promise<Blob> {
  const key = getApiKey('image');
  const base = (cfg.imageBaseUrl || getConnection().baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = cfg.imageModel || 'gpt-image-1';

  const res = await fetch(`${base}/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({
      model,
      prompt,
      n: 1,
      size: opts.size || '1024x1024',
      response_format: 'b64_json',
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Image-провайдер вернул ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  const item = data?.data?.[0];
  if (item?.b64_json) return b64ToBlob(item.b64_json);
  if (item?.url) {
    // Некоторые провайдеры возвращают url вместо b64 (может упереться в CORS).
    const img = await fetch(item.url);
    if (!img.ok) throw new Error('Не удалось загрузить сгенерированное изображение по URL');
    return img.blob();
  }
  throw new Error('Пустой ответ image-провайдера');
}
