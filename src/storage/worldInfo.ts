import type { LorebookEntry } from '../shared/types';
import { uid } from '../shared/utils';

// Импорт/экспорт лорбука в формате SillyTavern World Info (см. CR v2 §D2).
// ST-файлы встречаются в двух формах: { entries: { "0": {...}, "1": {...} } }
// (объект по числовому ключу) и { entries: [...] } (массив) — читаем оба.

export function parseWorldInfo(json: unknown): LorebookEntry[] {
  const raw = (json as any)?.entries;
  if (!raw) return [];
  const list: any[] = Array.isArray(raw) ? raw : Object.values(raw);

  return list
    .filter((e) => e && (typeof e.content === 'string' || typeof e.text === 'string'))
    .map((e) => {
      const keys = [
        ...(Array.isArray(e.key) ? e.key : Array.isArray(e.keys) ? e.keys : []),
        ...(e.selective
          ? Array.isArray(e.keysecondary)
            ? e.keysecondary
            : Array.isArray(e.secondary_keys)
              ? e.secondary_keys
              : []
          : []),
      ].filter((k) => typeof k === 'string');

      return {
        id: uid('lb'),
        title: e.comment || e.name || keys[0] || 'Запись',
        keys,
        content: e.content ?? e.text ?? '',
        alwaysActive: !!(e.constant ?? false),
        priority: typeof e.order === 'number' ? e.order : typeof e.insertion_order === 'number' ? e.insertion_order : 0,
      };
    });
}

// Экспорт в формат ST World Info (объект entries по числовому ключу — самый
// распространённый вид среди файлов из экосистемы ST/Chub).
export function exportWorldInfo(entries: LorebookEntry[]): object {
  const out: Record<string, any> = {};
  entries.forEach((e, i) => {
    out[String(i)] = {
      key: e.keys,
      keysecondary: [],
      comment: e.title,
      content: e.content,
      constant: e.alwaysActive,
      selective: false,
      order: e.priority,
      position: 'before_char',
      disable: false,
      id: i,
    };
  });
  return { entries: out };
}
