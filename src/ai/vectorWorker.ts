// Web Worker: computes sentence embeddings locally via a small transformer model,
// off the main thread (see CR v2 §E3.1). Lazily loads the model on first request.

let extractor: any = null;

async function getExtractor() {
  if (!extractor) {
    const { pipeline } = await import('@huggingface/transformers');
    extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
  return extractor;
}

self.onmessage = async (e: MessageEvent<{ id: number; texts: string[] }>) => {
  const { id, texts } = e.data;
  try {
    const fn = await getExtractor();
    const vectors: number[][] = [];
    for (const t of texts) {
      const out = await fn(t, { pooling: 'mean', normalize: true });
      vectors.push(Array.from(out.data as Float32Array));
    }
    (self as any).postMessage({ id, ok: true, vectors });
  } catch (err) {
    (self as any).postMessage({ id, ok: false, error: (err as Error).message });
  }
};
