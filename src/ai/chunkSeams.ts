// ПЕРЕНОСЫ ПОСРЕДИ СЛОВ. Часть шлюзов отдаёт поток так, что каждый кусок текста
// заканчивается переводом строки, — и ответ приходит лесенкой: «Валь / гар медленно
// опустил…», «возра / жать». Лента рисует каждую строку абзацем, и текст рассыпается.
// Узнаём это по тому, что почти все переносы стоят посреди слова или фразы (а не
// после точки перед новой репликой), и склеиваем — ровно стык в стык, ничего не
// добавляя и не убирая: пробелы у таких шлюзов остаются внутри кусков. Обычный
// текст с абзацами под это правило не подпадает и не трогается.
function isChunkSeam(a: string, b: string): boolean {
  const first = b[0] || '';
  if (!first) return false;
  const last = a.slice(-1);
  if (/[\p{L}\p{N}]/u.test(last) && /\p{Ll}/u.test(first)) return true; // посреди слова или фразы
  if (/^[,.;:!?…)»]/.test(b)) return true; // знак препинания с новой строки
  if (!/[.!?…»"*:—\]}]$/.test(a.trimEnd()) && /\p{Ll}/u.test(first)) return true; // фраза не закончена
  return false;
}

export function repairChunkBreaks(text: string): string {
  if (!text || !text.includes('\n')) return text;
  const parts = text.split(/(\n+)/);
  // parts: [текст, разрыв, текст, разрыв, …]
  let seams = 0;
  let pairs = 0;
  for (let i = 0; i + 2 < parts.length; i += 2) {
    if (!parts[i].trim() || !parts[i + 2].trim()) continue;
    pairs++;
    if (isChunkSeam(parts[i], parts[i + 2])) seams++;
  }
  if (pairs < 3 || seams / pairs < 0.5) return text;
  let out = parts[0];
  for (let i = 1; i < parts.length; i += 2) {
    const prev = parts[i - 1];
    const next = parts[i + 1] ?? '';
    out += prev.trim() && next.trim() && isChunkSeam(prev, next) ? next : parts[i] + next;
  }
  return out;
}
