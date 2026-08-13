import type { Project, RuntimeState } from '../shared/types';
import { defaultImageGenConfig } from '../shared/types';
import { blobToRef, composeFinalPrompt, generateImage, supportsReferences, type ImageRef } from './imageProvider';
import { getAssetBlob } from '../storage/db';
import { resolveSprite } from '../shared/outfits';
import { normName } from './characterRegistry';

// ЕДИНЫЙ ИСТОЧНИК ЛЮДЕЙ ДЛЯ КАРТИНОК.
//
// Раньше каждая картинка собиралась по-своему: CG-студия брала персонажей со
// сцены, селфи — только протагониста, фото от бота — отправителя и то лишь если
// в тексте угадывалось слово «селфи», быстрые действия не брали никого. Из-за
// этого один и тот же человек в телефоне, в Game Master и в истории для
// художника был тремя разными людьми — отсюда «левые типы» на фотках.
//
// Здесь тот же принцип, что и в ростере промпта (whoIsWhoBlock): личность —
// это НЕ имя, а связка id персонажа проекта / записи реестра / контакта
// телефона. Кто угодно из движка спрашивает «кто это?» одним способом и
// получает описание внешности и референсы из одних и тех же настроек.

export interface Person {
  /** Канонический id (персонаж проекта → запись реестра → контакт). */
  id: string;
  /** Все известные id этого человека — по ним ищем реф в CG-студии. */
  ids: string[];
  name: string;
  aliases: string[];
  /** Описание внешности из карточки/досье/реестра/заметки о контакте. */
  description: string;
  isHero: boolean;
}

// Совпадение имени с поправкой на падежи: «Катя» ↔ «Кати», «Дэмиан» ↔ «Дэмианом».
// Для коротких имён (< 4 букв) только точное — иначе «Дан» ловит «Дар».
function nameHit(a: string, b: string): boolean {
  const x = normName(a);
  const y = normName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length < 4 || y.length < 4) return false;
  if (Math.abs(x.length - y.length) > 3) return false;
  const stem = Math.min(x.length, y.length) - 1;
  return x.slice(0, stem) === y.slice(0, stem);
}

function heroName(project: Project, state: RuntimeState): string {
  const hero = project.characters.find((c) => c.role === 'protagonist');
  return state.protagonistName || hero?.name || 'the hero';
}

// Сбор всех id и имён одного человека: расширяем множество, пока находится
// новое совпадение. Контакт даёт characterId/registryId, реестр — sheetId и
// алиасы, персонаж проекта — своё имя, досье — имя. Два прохода не хватает:
// контакт → реестр → анкета — это уже три звена.
function expand(
  project: Project,
  state: RuntimeState,
  seedIds: string[],
  seedNames: string[]
): { ids: Set<string>; names: Set<string> } {
  const ids = new Set(seedIds.filter(Boolean));
  const names = new Set(seedNames.filter(Boolean));
  const contacts = state.phone?.contacts || [];
  const reg = state.gm.registry || [];

  const hasName = (n?: string) => !!n && [...names].some((x) => nameHit(x, n));

  for (let pass = 0; pass < 4; pass++) {
    const before = ids.size + names.size;

    for (const ct of contacts) {
      const mine = ids.has(ct.id) || (!!ct.characterId && ids.has(ct.characterId)) || (!!ct.registryId && ids.has(ct.registryId));
      if (!mine && !hasName(ct.name)) continue;
      ids.add(ct.id);
      if (ct.characterId) ids.add(ct.characterId);
      if (ct.registryId) ids.add(ct.registryId);
      if (ct.name) names.add(ct.name);
    }

    for (const e of reg) {
      const mine =
        ids.has(e.id) ||
        (!!e.sheetId && ids.has(e.sheetId)) ||
        (!!e.contactId && ids.has(e.contactId)) ||
        [e.canonicalName, ...e.aliases].some(hasName);
      if (!mine) continue;
      ids.add(e.id);
      if (e.sheetId) ids.add(e.sheetId);
      if (e.contactId) ids.add(e.contactId);
      names.add(e.canonicalName);
      for (const a of e.aliases) names.add(a);
    }

    for (const c of project.characters) {
      const nm = c.role === 'protagonist' ? heroName(project, state) : c.name;
      if (!ids.has(c.id) && !hasName(c.name) && !hasName(nm)) continue;
      ids.add(c.id);
      names.add(c.name);
      names.add(nm);
    }

    for (const d of state.gm.characters) {
      if (!(d.charId && ids.has(d.charId)) && !hasName(d.name)) continue;
      if (d.charId) ids.add(d.charId);
      names.add(d.name);
    }

    if (ids.size + names.size === before) break;
  }
  return { ids, names };
}

// Внешность: карточка → досье Game Master → реестр → заметка о контакте.
// Порядок тот же, что и в ростере промпта: карточка автора важнее записи,
// сделанной по ходу игры.
function describe(project: Project, state: RuntimeState, ids: Set<string>, names: Set<string>): string {
  const bits: string[] = [];
  const hasName = (n?: string) => !!n && [...names].some((x) => nameHit(x, n));

  const char = project.characters.find((c) => ids.has(c.id));
  if (char) {
    if (char.card.appearance.trim()) bits.push(char.card.appearance.trim());
    if (!bits.length && char.card.personality.trim()) bits.push(char.card.personality.trim());
  }
  const d = state.gm.characters.find((c) => (c.charId && ids.has(c.charId)) || hasName(c.name));
  if (d) {
    if (d.appearance?.trim()) bits.push(d.appearance.trim());
    if (!bits.length && d.dossier?.trim()) bits.push(d.dossier.trim());
    if (d.outfit?.trim()) bits.push(`usually wears: ${d.outfit.trim()}`);
  }
  const e = (state.gm.registry || []).find((r) => ids.has(r.id));
  if (!bits.length && e?.status?.trim()) bits.push(e.status.trim());
  const ct = (state.phone?.contacts || []).find((c) => ids.has(c.id));
  if (!bits.length && ct?.note?.trim()) bits.push(ct.note.trim());

  return bits.join('. ').slice(0, 600);
}

/**
 * Кто это. Спрашивать можно по любому id (персонаж проекта, запись реестра,
 * контакт телефона) или по имени/прозвищу — ответ один и тот же.
 */
export function resolvePerson(
  project: Project,
  state: RuntimeState,
  q: { id?: string; name?: string }
): Person | null {
  const seedIds = q.id ? [q.id] : [];
  const seedNames = q.name?.trim() ? [q.name.trim()] : [];
  if (!seedIds.length && !seedNames.length) return null;

  const { ids, names } = expand(project, state, seedIds, seedNames);
  // Никого не нашли — человек известен только по имени (эпизодический). Всё
  // равно возвращаем его: имя в промпте лучше, чем ничего.
  if (!ids.size && !seedNames.length) return null;

  const char = project.characters.find((c) => ids.has(c.id));
  const entry = (state.gm.registry || []).find((r) => ids.has(r.id));
  const contact = (state.phone?.contacts || []).find((c) => ids.has(c.id));
  const isHero = char?.role === 'protagonist';

  const name =
    (isHero ? heroName(project, state) : char?.name) ||
    entry?.canonicalName ||
    contact?.name ||
    seedNames[0] ||
    'a person';

  const id = char?.id || entry?.id || contact?.id || q.id || normName(name);
  return {
    id,
    ids: [...new Set([...ids, id])],
    name,
    aliases: [...names].filter((n) => !nameHit(n, name)),
    description: describe(project, state, ids, names),
    isHero: !!isHero,
  };
}

/**
 * Кого упомянул текст промпта. Нужно там, где кадр описан словами: «селфи с
 * Дэмианом», «фото Кати на пляже». Без этого модель рисовала по имени
 * случайного человека, потому что имя ей ни о чём не говорит.
 */
export function castFromText(project: Project, state: RuntimeState, text: string): Person[] {
  const t = text || '';
  if (!t.trim()) return [];
  const candidates: { name: string; id?: string }[] = [];
  for (const c of project.characters) {
    candidates.push({ name: c.role === 'protagonist' ? heroName(project, state) : c.name, id: c.id });
    if (c.role === 'protagonist' && c.name) candidates.push({ name: c.name, id: c.id });
  }
  for (const e of state.gm.registry || []) {
    candidates.push({ name: e.canonicalName, id: e.id });
    for (const a of e.aliases) candidates.push({ name: a, id: e.id });
  }
  for (const ct of state.phone?.contacts || []) if (ct.name) candidates.push({ name: ct.name, id: ct.id });
  for (const d of state.gm.characters) candidates.push({ name: d.name, id: d.charId });

  // Токены текста: слова длиной от 3 букв. Многословные имена («тётя Оля»)
  // ловим отдельной проверкой вхождения целиком.
  const tokens = t.split(/[^\p{L}\p{N}_-]+/u).filter((w) => w.length >= 3);
  const low = normName(t);

  const out: Person[] = [];
  const taken = new Set<string>();
  for (const cand of candidates) {
    const nm = cand.name?.trim();
    if (!nm || nm.length < 2) continue;
    const multi = nm.trim().includes(' ');
    const hit = multi ? low.includes(normName(nm)) : tokens.some((w) => nameHit(w, nm));
    if (!hit) continue;
    const p = resolvePerson(project, state, { id: cand.id, name: nm });
    if (!p || taken.has(p.id)) continue;
    taken.add(p.id);
    out.push(p);
  }
  return out;
}

// Референсы человека из CG-студии. Реф может быть закреплён на любом из его id
// (анкета, запись реестра, контакт) — проверяем все, а для персонажа проекта
// в запасе есть нейтральный спрайт.
async function personRefs(
  project: Project,
  person: Person,
  opts: { withOutfit: boolean }
): Promise<ImageRef[]> {
  const ig = project.imageGen ?? defaultImageGenConfig();
  const out: ImageRef[] = [];
  if (!supportsReferences(ig) || !ig.sendReferences) return out;

  const char = project.characters.find((c) => person.ids.includes(c.id));
  const pick = (map: Record<string, string> | undefined): string | undefined => {
    if (!map) return undefined;
    for (const id of person.ids) if (map[id]) return map[id];
    return undefined;
  };
  const slots: { id?: string; kind: 'appearance' | 'outfit' }[] = [
    { id: pick(ig.references) || (char ? resolveSprite(char, undefined, 'neutral') : undefined), kind: 'appearance' },
  ];
  if (opts.withOutfit) slots.push({ id: pick(ig.outfitReferences), kind: 'outfit' });

  for (const slot of slots) {
    const blobKey = slot.id ? project.assets.find((a) => a.id === slot.id)?.blobKey : undefined;
    if (!blobKey) continue;
    const b = await getAssetBlob(blobKey);
    if (b) out.push(await blobToRef(b, { who: person.name, kind: slot.kind }));
  }
  return out;
}

export interface RenderImageOpts {
  /** Текст для художника БЕЗ стиля и без описаний людей — их добавим сами. */
  prompt: string;
  /** Кто точно в кадре (уже разрешённые люди или запросы по id/имени). */
  cast?: (Person | { id?: string; name?: string })[];
  /** Текст, в котором ищем упоминания известных людей (обычно сам промпт). */
  scanText?: string;
  aspectRatio?: import('../shared/types').ImageAspectRatio;
  /** Слать ли второй реф с одеждой. Для аватарок не нужен — кадр по плечи. */
  withOutfit?: boolean;
  /** Потолок картинок-референсов в запросе: больше — модель путает лица. */
  maxRefs?: number;
  signal?: AbortSignal;
}

export interface RenderedImage {
  blob: Blob;
  /** Кто в итоге поехал в кадр — для лога и UI. */
  cast: Person[];
  finalPrompt: string;
}

/**
 * ЕДИНАЯ ТОЧКА ГЕНЕРАЦИИ. Стиль проекта, запреты, описания людей в кадре и их
 * референсы применяются здесь — значит, ко ВСЕМ картинкам игры сразу, а не
 * там, где кто-то не забыл их подставить.
 */
export async function renderImage(
  project: Project,
  state: RuntimeState,
  opts: RenderImageOpts
): Promise<RenderedImage> {
  const ig = project.imageGen ?? defaultImageGenConfig();

  const people: Person[] = [];
  const taken = new Set<string>();
  const push = (p: Person | null) => {
    if (p && !taken.has(p.id)) {
      taken.add(p.id);
      people.push(p);
    }
  };
  for (const c of opts.cast || []) {
    push('ids' in c ? (c as Person) : resolvePerson(project, state, c));
  }
  if (opts.scanText) for (const p of castFromText(project, state, opts.scanText)) push(p);

  const known = people.filter((p) => p.description);
  const whoBlock = known.length
    ? `\nPeople in this image (draw them as described, these are established characters):\n` +
      known.map((p) => `- ${p.name}: ${p.description}`).join('\n')
    : '';

  const maxRefs = opts.maxRefs ?? 4;
  const refs: ImageRef[] = [];
  for (const p of people) {
    if (refs.length >= maxRefs) break;
    const got = await personRefs(project, p, { withOutfit: !!opts.withOutfit });
    for (const r of got) {
      if (refs.length >= maxRefs) break;
      refs.push(r);
    }
  }

  const finalPrompt = composeFinalPrompt(ig, `${opts.prompt.trim()}${whoBlock}`, { refs });
  const blob = await generateImage(ig, {
    prompt: finalPrompt,
    references: refs,
    aspectRatio: opts.aspectRatio,
    signal: opts.signal,
  });
  return { blob, cast: people, finalPrompt };
}
