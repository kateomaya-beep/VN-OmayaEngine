import type { Project } from '../shared/types';
import { getApiKey } from './keys';
import { logEvent } from '../shared/logStore';

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

// Локальные эмбеддинги (MiniLM в Web Worker) — независимо от режима памяти проекта.
// Используется локальным Селектором ассетов (Batch 5.4) для классификации по смыслу.
export function embedLocal(texts: string[]): Promise<number[][]> {
  return embedBuiltin(texts);
}
export { cosine as cosineSim };

async function embedCustom(project: Project, texts: string[]): Promise<number[][]> {
  const conn = project.memoryConfig.embeddingsConnection;
  if (!conn) throw new Error('Не настроено подключение для эмбеддингов');
  const base = conn.baseUrl.replace(/\/$/, '');
  const key = getApiKey('embeddings');
  // Без таймаута зависший API эмбеддингов держал бы всё, что его ждёт.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), EMBED_REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${base}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({ model: conn.model || 'text-embedding-3-small', input: texts }),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`Embeddings API вернул ${res.status}`);
  const data = await res.json();
  const items = Array.isArray(data?.data) ? data.data : [];
  return items.map((d: any) => d.embedding as number[]);
}

async function embed(project: Project, texts: string[]): Promise<number[][]> {
  const mode = project.memoryConfig.vectorization;
  if (!texts.length) return [];
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

const vecCache = new Map<string, number[]>();

// ПОИСК ПО СМЫСЛУ НЕ ДОЛЖЕН ДЕРЖАТЬ ХОД. Архив ищется по отрывку на каждый ход —
// на длинной игре это сотни текстов. Раньше все недостающие эмбеддинги считались
// ПРЯМО В ХОДЕ одним заходом: встроенная модель на телефоне считала их минутами
// (и заново после каждой перезагрузки — кэш живёт в памяти вкладки), а внешний
// API получал сотни текстов разом и мог не ответить вовсе. Ход всё это время
// «думал», хотя до модели запрос ещё даже не ушёл. Теперь:
//  • архив прогревается В ФОНЕ небольшими порциями и кэшируется;
//  • в ходе ищем только среди уже посчитанного, а на запрос даём короткий срок;
//  • не успели — ход идёт дальше без этого поиска (вызывающий подставит поиск по словам).
const EMBED_REQUEST_TIMEOUT_MS = 30000;
const RECALL_TIMEOUT_MS = 4000;
let warming = false;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(null);
      }
    );
  });
}

async function warmUp(project: Project, texts: string[], key: (t: string) => string): Promise<void> {
  if (warming) return;
  warming = true;
  // Встроенная модель считает в одном воркере по очереди: маленькие порции, чтобы
  // запрос следующего хода не стоял за большой пачкой.
  const batch = project.memoryConfig.vectorization === 'builtin' ? 8 : 32;
  try {
    for (let i = 0; i < texts.length; i += batch) {
      const part = texts.slice(i, i + batch).filter((t) => !vecCache.has(key(t)));
      if (!part.length) continue;
      const vecs = await embed(project, part);
      part.forEach((t, j) => vecs[j] && vecCache.set(key(t), vecs[j]));
    }
    logEvent('info', 'memory', `Поиск по смыслу: архив посчитан (${texts.length} отрывков)`);
  } catch (e) {
    logEvent('warn', 'memory', 'Эмбеддинги архива не посчитались: ' + (e as Error).message + ' — пока работает поиск по словам');
  } finally {
    warming = false;
  }
}

export interface RecallResult {
  hits: Corpus[];
  /** Сколько текстов корпуса уже посчитано (остальные прогреваются в фоне). */
  ready: number;
}

// Возвращает top-k наиболее релевантных элементов корпуса к запросу. Никогда не
// ждёт дольше RECALL_TIMEOUT_MS и никогда не бросает.
export async function retrieveRelevant(
  project: Project,
  query: string,
  corpus: Corpus[],
  topK = 3
): Promise<RecallResult> {
  const mode = project.memoryConfig.vectorization;
  if (mode === 'off' || mode === 'keyword' || corpus.length === 0) return { hits: [], ready: 0 };
  const key = (t: string) => `${mode}|${project.memoryConfig.embeddingsConnection?.model || ''}|${t}`;
  const missing = corpus.filter((c) => !vecCache.has(key(c.text)));
  if (missing.length) void warmUp(project, missing.map((c) => c.text), key);
  const ready = corpus.filter((c) => vecCache.has(key(c.text)));
  if (!ready.length) return { hits: [], ready: 0 };
  const q = await withTimeout(embed(project, [query]), RECALL_TIMEOUT_MS);
  const queryVec = q?.[0];
  if (!queryVec) return { hits: [], ready: ready.length };
  const scored = ready.map((c) => ({ ...c, score: cosine(queryVec, vecCache.get(key(c.text)) || []) }));
  if (vecCache.size > 5000) vecCache.clear();
  scored.sort((a, b) => b.score - a.score);
  return { hits: scored.filter((x) => x.score > 0.3).slice(0, topK), ready: ready.length };
}
