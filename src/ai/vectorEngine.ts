import type { Project } from '../shared/types';
import { getApiKey } from './keys';

// Векторизация памяти (см. CR v2 §E3): подсос релевантного из "сырого архива"
// (свёрнутые куски истории, не инжектящиеся целиком). Три режима: builtin
// (локальная модель в Web Worker), custom (внешний embeddings API), off.

export interface Corpus {
  id: string;
  text: string;
}

let worker: Worker | null = null;
let reqId = 0;
const pending = new Map<number, { resolve: (v: number[][]) => void; reject: (e: Error) => void }>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./vectorWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<any>) => {
      const { id, ok, vectors, error } = e.data;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (ok) p.resolve(vectors);
      else p.reject(new Error(error));
    };
  }
  return worker;
}

function embedBuiltin(texts: string[]): Promise<number[][]> {
  const id = ++reqId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, texts });
  });
}

async function embedCustom(project: Project, texts: string[]): Promise<number[][]> {
  const conn = project.memoryConfig.embeddingsConnection;
  if (!conn) throw new Error('Не настроено подключение для эмбеддингов');
  const base = conn.baseUrl.replace(/\/$/, '');
  const key = getApiKey('embeddings');
  const res = await fetch(`${base}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({ model: conn.model || 'text-embedding-3-small', input: texts }),
  });
  if (!res.ok) throw new Error(`Embeddings API вернул ${res.status}`);
  const data = await res.json();
  const items = Array.isArray(data?.data) ? data.data : [];
  return items.map((d: any) => d.embedding as number[]);
}

async function embed(project: Project, texts: string[]): Promise<number[][]> {
  const mode = project.memoryConfig.vectorization;
  if (mode === 'builtin') return embedBuiltin(texts);
  if (mode === 'custom') return embedCustom(project, texts);
  throw new Error('Векторизация выключена');
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// Возвращает top-k наиболее релевантных элементов корпуса к запросу. Любая
// ошибка (модель не загрузилась, API недоступен) → пустой массив, без крашей.
export async function retrieveRelevant(
  project: Project,
  query: string,
  corpus: Corpus[],
  topK = 3
): Promise<Corpus[]> {
  if (project.memoryConfig.vectorization === 'off' || corpus.length === 0) return [];
  try {
    const [queryVec, ...corpusVecs] = await embed(project, [query, ...corpus.map((c) => c.text)]);
    const scored = corpus.map((c, i) => ({ ...c, score: cosine(queryVec, corpusVecs[i]) }));
    scored.sort((a, b) => b.score - a.score);
    return scored.filter((s) => s.score > 0.3).slice(0, topK);
  } catch {
    return []; // graceful degradation — контекст просто обходится без подсоса
  }
}
