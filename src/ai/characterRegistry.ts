import type {
  Project,
  GameMasterState,
  CharacterRegistryEntry,
  RuntimeState,
  Character,
  GmCharacter,
  PhoneContact,
} from '../shared/types';
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

// ---- ОПОЗНАНИЕ ЧЕЛОВЕКА -----------------------------------------------------
// Один человек живёт сразу в нескольких списках: анкета проекта, запись реестра,
// досье Game Master, контакт телефона. Пока каждый список опознавал его по-своему
// (кто по id, кто по точному имени в нижнем регистре), один и тот же человек
// раздваивался: досье не прилипало к карточке, телефон не связывался с сюжетом,
// сканирование заводило второго «Дэма» рядом с «Дэмианом».
//
// Правило теперь одно и живёт здесь. Связи считаются ОДИН РАЗ на состояние —
// иначе ростер, опрашивающий каждого человека, перебирал бы все списки заново
// на каждого, и на большом сейве сборка промпта занимала секунды.

// Падежные окончания русских имён. Список закрытый И ЭТО ВАЖНО: «похожий
// префикс» как правило склейки не годится — «Виктор» и «Виктория» тогда
// оказываются одним человеком, а это разные люди.
const CASE_ENDINGS = ['ами', 'ой', 'ей', 'ом', 'ем', 'ём', 'ах', 'ям', 'ов', 'ев', 'а', 'я', 'у', 'ю', 'е', 'и', 'ы'];
const MIN_STEM = 3;

// normName вызывается на одних и тех же строках тысячи раз за сборку промпта,
// а внутри три регулярки. Кэшируем.
const keyCache = new Map<string, string>();

/**
 * Ключ имени: нормализованное имя без падежного окончания. «Катя», «Кати»,
 * «Кате» дают один ключ; «Виктор» и «Виктория» — разные. Настоящие прозвища
 * («Дэм», «Сашка») сюда НЕ входят намеренно: их знает список алиасов в реестре,
 * а гадать по похожести значит склеивать разных людей.
 */
export function nameKey(s: string): string {
  const raw = s || '';
  let v = keyCache.get(raw);
  if (v !== undefined) return v;
  const n = normName(raw);
  v = n;
  if (n.length >= MIN_STEM + 1) {
    for (const end of CASE_ENDINGS) {
      if (n.length - end.length >= MIN_STEM && n.endsWith(end)) {
        v = n.slice(0, -end.length);
        break;
      }
    }
  }
  if (keyCache.size > 8000) keyCache.clear();
  keyCache.set(raw, v);
  return v;
}

/** Одно ли это имя с точностью до падежа. */
export function nameHit(a: string, b: string): boolean {
  const x = nameKey(a);
  return !!x && x === nameKey(b);
}

/** Все записи об одном человеке. */
export interface Person {
  /** Канонический id: анкета проекта → запись реестра → контакт. */
  id: string;
  /** Все известные id — по ним ищутся рефы, контакты и привязки. */
  ids: string[];
  name: string;
  aliases: string[];
  isHero: boolean;
  char?: Character;
  entry?: CharacterRegistryEntry;
  contact?: PhoneContact;
  dossier?: GmCharacter;
}

function heroNameIn(project: Project, state: RuntimeState): string {
  return (
    state.protagonistName?.trim() ||
    project.characters.find((c) => c.role === 'protagonist')?.name ||
    'the hero'
  );
}

// Кэш «этот id поглощён другой записью» на конкретный массив реестра.
const mergedCache = new WeakMap<object, Set<string>>();
function isMerged(registry: CharacterRegistryEntry[], id: string): boolean {
  let set = mergedCache.get(registry);
  if (!set) {
    set = new Set<string>();
    for (const e of registry) for (const m of e.merged || []) set.add(m);
    mergedCache.set(registry, set);
  }
  return set.has(id);
}

interface IdentityIndex {
  byId: Map<string, Person>;
  byKey: Map<string, Person>;
  /** Составные имена («тётя Оля») — их в тексте ищем вхождением, а не по словам. */
  multiWord: { key: string; person: Person }[];
  people: Person[];
}

// Простой union-find по узлам «запись такого-то списка».
function makeUnion() {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = parent.get(x);
    if (r === undefined) {
      parent.set(x, x);
      return x;
    }
    while (r !== parent.get(r)!) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  return { find, union, nodes: () => [...parent.keys()] };
}

const indexCache = new WeakMap<object, { chars: unknown; phone: unknown; index: IdentityIndex }>();

/** Индекс «кто есть кто» для текущего состояния. Строится один раз, дальше O(1). */
export function identityIndex(project: Project, state: RuntimeState): IdentityIndex {
  const hit = indexCache.get(state.gm);
  if (hit && hit.chars === project.characters && hit.phone === state.phone) return hit.index;

  const registry = state.gm.registry || [];
  const contacts = state.phone?.contacts || [];
  const dossiers = state.gm.characters || [];
  const heroName = heroNameIn(project, state);
  const u = makeUnion();

  const C = (id: string) => `c:${id}`;
  const R = (id: string) => `r:${id}`;
  const P = (id: string) => `p:${id}`;
  const D = (i: number) => `d:${i}`;

  // 1) Связи по id — они точные и главнее имён.
  for (const c of project.characters) u.find(C(c.id));
  for (const e of registry) {
    u.find(R(e.id));
    if (e.sheetId) u.union(R(e.id), C(e.sheetId));
    if (e.contactId) u.union(R(e.id), P(e.contactId));
  }
  for (const ct of contacts) {
    u.find(P(ct.id));
    if (ct.characterId) u.union(P(ct.id), C(ct.characterId));
    if (ct.registryId) u.union(P(ct.id), R(ct.registryId));
  }
  dossiers.forEach((d, i) => {
    u.find(D(i));
    if (d.charId) u.union(D(i), C(d.charId));
  });

  // 2) Связи по имени (с точностью до падежа). Имя, известное реестру как алиас,
  //    связывает записи так же надёжно, как id: ради этого реестр и заводился.
  const firstByKey = new Map<string, string>();
  const linkName = (node: string, name?: string) => {
    const k = name ? nameKey(name) : '';
    if (!k) return;
    const first = firstByKey.get(k);
    if (first === undefined) firstByKey.set(k, node);
    else u.union(node, first);
  };
  for (const c of project.characters) {
    linkName(C(c.id), c.name);
    if (c.role === 'protagonist') linkName(C(c.id), heroName);
  }
  for (const e of registry) {
    linkName(R(e.id), e.canonicalName);
    for (const a of e.aliases) linkName(R(e.id), a);
  }
  for (const ct of contacts) linkName(P(ct.id), ct.name);
  dossiers.forEach((d, i) => linkName(D(i), d.name));

  // 3) Собираем людей из групп.
  const groups = new Map<string, Person>();
  const idsOf = new Map<string, Set<string>>();
  const namesOf = new Map<string, Set<string>>();
  const ensure = (root: string): Person => {
    let p = groups.get(root);
    if (!p) {
      p = { id: '', ids: [], name: '', aliases: [], isHero: false };
      groups.set(root, p);
      idsOf.set(root, new Set());
      namesOf.set(root, new Set());
    }
    return p;
  };
  const addId = (root: string, id?: string) => id && idsOf.get(root)!.add(id);
  const addName = (root: string, n?: string) => n?.trim() && namesOf.get(root)!.add(n.trim());

  for (const c of project.characters) {
    const root = u.find(C(c.id));
    const p = ensure(root);
    if (!p.char) p.char = c;
    if (c.role === 'protagonist') {
      p.isHero = true;
      addName(root, heroName);
    }
    addId(root, c.id);
    addName(root, c.name);
  }
  for (const e of registry) {
    if (isMerged(registry, e.id)) continue;
    const root = u.find(R(e.id));
    const p = ensure(root);
    if (!p.entry) p.entry = e;
    addId(root, e.id);
    if (e.sheetId) addId(root, e.sheetId);
    if (e.contactId) addId(root, e.contactId);
    addName(root, e.canonicalName);
    for (const a of e.aliases) addName(root, a);
  }
  for (const ct of contacts) {
    const root = u.find(P(ct.id));
    const p = ensure(root);
    if (!p.contact) p.contact = ct;
    addId(root, ct.id);
    if (ct.characterId) addId(root, ct.characterId);
    if (ct.registryId) addId(root, ct.registryId);
    addName(root, ct.name);
  }
  dossiers.forEach((d, i) => {
    const root = u.find(D(i));
    const p = ensure(root);
    if (!p.dossier) p.dossier = d;
    if (d.charId) addId(root, d.charId);
    addName(root, d.name);
  });

  const byId = new Map<string, Person>();
  const byKey = new Map<string, Person>();
  const multiWord: { key: string; person: Person }[] = [];
  const people: Person[] = [];
  for (const [root, p] of groups) {
    const names = [...namesOf.get(root)!];
    p.name =
      (p.isHero ? heroName : p.char?.name) ||
      p.entry?.canonicalName ||
      p.contact?.name ||
      p.dossier?.name ||
      names[0] ||
      'a person';
    p.id = p.char?.id || p.entry?.id || p.contact?.id || nameKey(p.name);
    p.ids = [...new Set([...idsOf.get(root)!, p.id])];
    p.aliases = names.filter((n) => !nameHit(n, p.name));
    people.push(p);
    for (const id of p.ids) if (!byId.has(id)) byId.set(id, p);
    for (const n of names) {
      const k = nameKey(n);
      if (k && !byKey.has(k)) byKey.set(k, p);
      if (k && n.trim().includes(' ')) multiWord.push({ key: normName(n), person: p });
    }
  }

  const index: IdentityIndex = { byId, byKey, multiWord, people };
  indexCache.set(state.gm, { chars: project.characters, phone: state.phone, index });
  return index;
}

/**
 * Кто это. Спрашивать можно по любому id (анкета, запись реестра, контакт) или
 * по имени/прозвищу — ответ один и тот же, со всеми записями об этом человеке.
 */
export function resolvePerson(
  project: Project,
  state: RuntimeState,
  q: { id?: string; name?: string }
): Person | null {
  const idx = identityIndex(project, state);
  if (q.id) {
    const byId = idx.byId.get(q.id);
    if (byId) return byId;
  }
  const nm = q.name?.trim();
  if (nm) {
    const byKey = idx.byKey.get(nameKey(nm));
    if (byKey) return byKey;
    const low = normName(nm);
    const multi = idx.multiWord.find((m) => m.key === low);
    if (multi) return multi.person;
    // Ни одной записи: человек известен только по имени (эпизодник). Отдаём
    // «безбумажного» — имя в промпте лучше, чем ничего.
    return { id: q.id || nameKey(nm), ids: q.id ? [q.id] : [], name: nm, aliases: [], isHero: false };
  }
  return null;
}

/** Описание внешности человека из всех его записей — карточка важнее записей игры. */
export function describePerson(person: Person | null): string {
  if (!person) return '';
  const bits: string[] = [];
  if (person.char) {
    if (person.char.card.appearance.trim()) bits.push(person.char.card.appearance.trim());
    if (!bits.length && person.char.card.personality.trim()) bits.push(person.char.card.personality.trim());
  }
  const d = person.dossier;
  if (d) {
    if (d.appearance?.trim()) bits.push(d.appearance.trim());
    if (!bits.length && d.dossier?.trim()) bits.push(d.dossier.trim());
    if (d.outfit?.trim()) bits.push(`usually wears: ${d.outfit.trim()}`);
  }
  if (!bits.length && person.entry?.status?.trim()) bits.push(person.entry.status.trim());
  if (!bits.length && person.contact?.note?.trim()) bits.push(person.contact.note.trim());
  return bits.join('. ').slice(0, 600);
}

/**
 * Кого упоминает текст. Нужно там, где человек назван словами, а не id:
 * промпт картинки («селфи с Дэмианом»), реплика от модели, разбор сцены.
 */
export function personsInText(project: Project, state: RuntimeState, text: string): Person[] {
  const t = text || '';
  if (!t.trim()) return [];
  const idx = identityIndex(project, state);
  const out: Person[] = [];
  const taken = new Set<string>();
  const push = (p?: Person) => {
    if (p && !taken.has(p.id)) {
      taken.add(p.id);
      out.push(p);
    }
  };
  const low = normName(t);
  for (const m of idx.multiWord) if (low.includes(m.key)) push(m.person);
  for (const w of t.split(/[^\p{L}\p{N}_-]+/u)) {
    if (w.length < 3) continue;
    push(idx.byKey.get(nameKey(w)));
  }
  return out;
}
