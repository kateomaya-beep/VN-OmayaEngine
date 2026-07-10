import type { LorebookEntry } from '../shared/types';

// Scan recent text for lorebook keys (case-insensitive, word boundaries) and
// return the entries to inject, always-active first, then by priority (see ТЗ §6.3).

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function matchLorebook(entries: LorebookEntry[], recentText: string): LorebookEntry[] {
  const text = recentText.toLowerCase();
  const active = new Map<string, LorebookEntry>();

  for (const e of entries) {
    if (e.alwaysActive) {
      active.set(e.id, e);
      continue;
    }
    for (const key of e.keys) {
      const k = key.trim();
      if (!k) continue;
      // Unicode-aware "boundary": key surrounded by non-letter or string ends.
      const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegex(k.toLowerCase())}([^\\p{L}\\p{N}]|$)`, 'u');
      if (re.test(text)) {
        active.set(e.id, e);
        break;
      }
    }
  }

  return [...active.values()].sort((a, b) => {
    if (a.alwaysActive !== b.alwaysActive) return a.alwaysActive ? -1 : 1;
    return (b.priority || 0) - (a.priority || 0);
  });
}
