import type { Project, RuntimeState } from '../shared/types';
import { buildTimeline } from './chapters';
import { retrieveRelevant } from './vectorEngine';

// ПОИСК ПО ПРОШЛОМУ — дословные отрывки свёрнутых ходов, похожие на то, что
// происходит сейчас.
//
// Как было и почему не работало: архив хранился кусками по 40 тыс. символов, и
// каждый кусок шёл в поиск целиком. Встроенная модель смыслов читает только
// первые ~256 токенов текста — то есть «искала» по началу периода, а найденное
// отдавала модели первыми 400 символами куска, а не тем местом, которое совпало.
// К тому же она английская, и русский текст различала плохо.
//
// Теперь единица поиска — ОДИН ХОД (реплика игрока + ответ), а модели уходит
// отрывок вокруг совпадения. По умолчанию поиск по словам: без модели, на любом
// языке, офлайн. Смысловой поиск (своя модель или внешний API) остаётся по выбору.

export interface RecallHit {
  turn: number;
  text: string;
}

interface Passage {
  turn: number;
  text: string;
}

function passages(state: RuntimeState): Passage[] {
  const out: Passage[] = [];
  let cur: Passage | null = null;
  for (const m of buildTimeline(state)) {
    if (m.source !== 'archive') continue;
    if (!cur || cur.turn !== m.turn) {
      if (cur) out.push(cur);
      cur = { turn: m.turn, text: '' };
    }
    cur.text += (cur.text ? '\n' : '') + (m.role === 'user' ? 'PLAYER: ' : '') + m.text;
  }
  if (cur) out.push(cur);
  return out.filter((p) => p.text.trim().length > 40);
}

// Грубая основа слова: регистр долой, у длинных слов — первые шесть букв. Для
// русского этого хватает, чтобы «письмо/письма/письмом» сошлись в одно.
function stems(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).map((w) => (w.length > 6 ? w.slice(0, 6) : w));
}

// Отрывок вокруг самого плотного места совпадений.
function excerpt(text: string, terms: Set<string>, size = 700): string {
  if (text.length <= size) return text.trim();
  const re = /[\p{L}\p{N}]{3,}/gu;
  const hits: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const w = m[0].toLowerCase();
    if (terms.has(w.length > 6 ? w.slice(0, 6) : w)) hits.push(m.index);
  }
  if (!hits.length) return text.slice(0, size).trim() + '…';
  let best = hits[0];
  let bestCount = 0;
  for (const h of hits) {
    const c = hits.filter((x) => x >= h && x < h + size).length;
    if (c > bestCount) {
      bestCount = c;
      best = h;
    }
  }
  const start = Math.max(0, best - Math.round(size * 0.25));
  const end = Math.min(text.length, start + size);
  return (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
}

/** BM25 по словам: без модели, на любом языке. */
export function keywordRecall(state: RuntimeState, query: string, topK = 3): RecallHit[] {
  const ps = passages(state);
  if (!ps.length) return [];
  const qTerms = [...new Set(stems(query))];
  if (!qTerms.length) return [];
  const docs = ps.map((p) => stems(p.text));
  const N = docs.length;
  const avg = docs.reduce((n, d) => n + d.length, 0) / N || 1;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) || 0) + 1);
  const k1 = 1.2;
  const b = 0.75;
  const scored = docs.map((d, i) => {
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) || 0) + 1);
    let score = 0;
    let matched = 0;
    for (const q of qTerms) {
      const f = tf.get(q);
      if (!f) continue;
      const n = df.get(q) || 0;
      // Слово, которое есть в половине ходов (имя героини, «сказал»), не различает
      // ничего — такие отбрасываем совсем.
      if (n > N * 0.5) continue;
      matched++;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avg));
    }
    return { i, score, matched };
  });
  const terms = new Set(qTerms);
  return scored
    .filter((s) => s.matched >= 2 && s.score > 2)
    .sort((a, b2) => b2.score - a.score)
    .slice(0, topK)
    .sort((a, b2) => ps[a.i].turn - ps[b2.i].turn)
    .map((s) => ({ turn: ps[s.i].turn, text: excerpt(ps[s.i].text, terms) }));
}

/** Поиск по прошлому в режиме проекта. Любая ошибка — пустой результат. */
export async function pastRecall(project: Project, state: RuntimeState, query: string, topK = 3): Promise<RecallHit[]> {
  const mode = project.memoryConfig.vectorization;
  if (mode === 'off' || !state.memory.rawArchive.length || !query.trim()) return [];
  if (mode === 'keyword') return keywordRecall(state, query, topK);
  const ps = passages(state);
  if (!ps.length) return [];
  const hits = await retrieveRelevant(
    project,
    query,
    ps.map((p, i) => ({ id: String(i), text: p.text })),
    topK
  );
  const terms = new Set(stems(query));
  return hits
    .map((h) => ps[Number(h.id)])
    .filter(Boolean)
    .sort((a, b) => a.turn - b.turn)
    .map((p) => ({ turn: p.turn, text: excerpt(p.text, terms) }));
}
