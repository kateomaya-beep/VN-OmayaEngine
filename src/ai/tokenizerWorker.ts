// Web Worker: точный счёт токенов словарём модели (см. ai/tokenCount.ts).
// Словарь — tokenizer.json модели, сжатый gzip (public/tokenizers/*.json.gz):
// грузится один раз при первом запросе и держится, пока модель не сменится.
// Считаем вне основного потока — словарь Gemini весит десятки мегабайт, и его
// разбор и счёт длинной истории подвешивали бы интерфейс.

import { Tokenizer } from '@huggingface/tokenizers';

let current: { id: string; tok: Tokenizer } | null = null;
let loading: { id: string; p: Promise<Tokenizer> } | null = null;

async function readJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`словарь не загрузился (${res.status})`);
  const buf = new Uint8Array(await res.arrayBuffer());
  // Сервер может сам снять gzip (Content-Encoding) — тогда пришёл готовый JSON.
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    return JSON.parse(await new Response(stream).text());
  }
  return JSON.parse(new TextDecoder().decode(buf));
}

function getTokenizer(id: string, url: string): Promise<Tokenizer> {
  if (current?.id === id) return Promise.resolve(current.tok);
  if (loading?.id === id) return loading.p;
  const p = readJson(url).then((json) => {
    const tok = new Tokenizer(json as any, {});
    current = { id, tok };
    return tok;
  });
  loading = { id, p };
  p.catch(() => {}).finally(() => {
    if (loading?.p === p) loading = null;
  });
  return p;
}

self.onmessage = async (e: MessageEvent<{ id: number; tok: string; url: string; texts: string[] }>) => {
  const { id, tok, url, texts } = e.data;
  try {
    const t = await getTokenizer(tok, url);
    const counts = texts.map((s) => (s ? t.encode(s, { add_special_tokens: false }).ids.length : 0));
    (self as any).postMessage({ id, ok: true, counts });
  } catch (err) {
    (self as any).postMessage({ id, ok: false, error: (err as Error).message });
  }
};
