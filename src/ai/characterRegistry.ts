import type { Project, GameMasterState, CharacterRegistryEntry } from '../shared/types';
import { uid } from '../shared/utils';

// Реестр персонажей (patch character-registry): единый источник правды «кто есть кто».
// Дедуп имён на стороне движка, чтобы ИИ не плодил дубли анкет.

export function normName(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/[.,!?;:«»"'()\[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Расстояние Левенштейна (для нечёткого сравнения имён).
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

export interface RegistryMatch {
  entry: CharacterRegistryEntry;
  exact: boolean; // точное совпадение имени/алиаса (можно склеивать молча)
}

// Ищет запись реестра, к которой относится имя. exact=true — точное совпадение
// canonicalName/алиаса; иначе — кандидат (частичное вхождение / Левенштейн).
export function findRegistryMatch(
  registry: CharacterRegistryEntry[],
  name: string
): RegistryMatch | null {
  const n = normName(name);
  if (!n) return null;

  // 1) Точное совпадение canonicalName или любого алиаса.
  for (const e of registry) {
    const names = [e.canonicalName, ...e.aliases].map(normName);
    if (names.includes(n)) return { entry: e, exact: true };
  }
  // 2) Частичное вхождение / префикс.
  for (const e of registry) {
    const names = [e.canonicalName, ...e.aliases].map(normName);
    for (const cand of names) {
      if (!cand) continue;
      if (cand.includes(n) || n.includes(cand)) return { entry: e, exact: false };
    }
  }
  // 3) Нечёткое (Левенштейн ≤ 2 для имён длиной ≥ 5).
  if (n.length >= 5) {
    for (const e of registry) {
      const names = [e.canonicalName, ...e.aliases].map(normName);
      for (const cand of names) {
        if (cand.length >= 5 && levenshtein(cand, n) <= 2) return { entry: e, exact: false };
      }
    }
  }
  return null;
}

// Синхронизирует реестр с персонажами проекта (миграция + поддержание): у каждого
// персонажа проекта должна быть запись реестра (id = id персонажа). Идемпотентно.
// Мутирует gm.registry и возвращает его.
export function syncRegistry(project: Project, gm: GameMasterState): CharacterRegistryEntry[] {
  const reg = (gm.registry ||= []);
  const byId = new Map(reg.map((e) => [e.id, e]));
  const phoneOn = !!project.phone?.enabled;
  for (const c of project.characters) {
    let e = byId.get(c.id);
    if (!e) {
      // Может, дубль уже был поглощён — не воскрешаем.
      if (reg.some((x) => x.merged?.includes(c.id))) continue;
      e = {
        id: c.id,
        canonicalName: c.name,
        aliases: [c.name],
        role: c.role,
        status: '',
        sheetId: c.id,
      };
      reg.push(e);
      byId.set(c.id, e);
    } else {
      // Держим базовые поля в актуальном состоянии.
      if (c.name && !e.aliases.some((a) => normName(a) === normName(c.name))) e.aliases.push(c.name);
      e.role = c.role;
      e.sheetId = c.id;
    }
    if (phoneOn) e.contactId = e.contactId || c.id;
  }
  return reg;
}

// Реестр для отображения/контекста без мутации gm (используется в promptBuilder).
export function buildRegistryView(project: Project, gm: GameMasterState): CharacterRegistryEntry[] {
  const existing = gm.registry || [];
  const out = [...existing];
  const has = (id: string) => out.some((e) => e.id === id) || existing.some((e) => e.merged?.includes(id));
  for (const c of project.characters) {
    if (!has(c.id)) {
      out.push({ id: c.id, canonicalName: c.name, aliases: [c.name], role: c.role, status: '', sheetId: c.id });
    }
  }
  return out;
}

// Компактный реестр для контекста ИИ.
export function registryContextBlock(registry: CharacterRegistryEntry[]): string {
  const active = registry.filter((e) => !registry.some((x) => x.merged?.includes(e.id)));
  if (!active.length) return '';
  const lines = active.map((e) => {
    const aka = e.aliases.filter((a) => normName(a) !== normName(e.canonicalName));
    return `${e.id} | ${e.canonicalName}${aka.length ? ` | aka: ${aka.join(', ')}` : ''}${e.status ? ` | статус: ${e.status}` : ''}`;
  });
  return `=== CHARACTER REGISTRY (who exists — reference by id, never by bare name) ===\n${lines.join('\n')}`;
}

export function newRegistryId(): string {
  return uid('char');
}

// Находит подозрительные пары дублей (patch §3.3) — по тем же правилам, что и дедуп.
export function findDuplicatePairs(
  registry: CharacterRegistryEntry[]
): [CharacterRegistryEntry, CharacterRegistryEntry][] {
  const active = registry.filter((e) => !registry.some((x) => x.merged?.includes(e.id)));
  const pairs: [CharacterRegistryEntry, CharacterRegistryEntry][] = [];
  const similar = (a: CharacterRegistryEntry, b: CharacterRegistryEntry): boolean => {
    const an = [a.canonicalName, ...a.aliases].map(normName).filter(Boolean);
    const bn = [b.canonicalName, ...b.aliases].map(normName).filter(Boolean);
    for (const x of an)
      for (const y of bn) {
        if (x === y) return true;
        if (x.length >= 3 && y.length >= 3 && (x.includes(y) || y.includes(x))) return true;
        if (x.length >= 5 && y.length >= 5 && levenshtein(x, y) <= 2) return true;
      }
    return false;
  };
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      // Протагониста не склеиваем с другими.
      if (active[i].role === 'protagonist' || active[j].role === 'protagonist') continue;
      if (similar(active[i], active[j])) pairs.push([active[i], active[j]]);
    }
  }
  return pairs;
}
