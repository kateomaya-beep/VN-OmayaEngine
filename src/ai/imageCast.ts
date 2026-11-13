import type { Project, RuntimeState } from '../shared/types';
import { blobToRef, composeFinalPrompt, generateImage, supportsReferences, type ImageRef } from './imageProvider';
import { getAssetBlob } from '../storage/db';
import { imageGenFor } from './imageConnection';
import { resolveSprite } from '../shared/outfits';
import { resolvePerson, personsInText, describePerson, type Person } from './characterRegistry';

// КАРТИНКИ. Кто на них изображён — решает не этот модуль: опознание человека
// одно на всю игру и живёт в characterRegistry. Здесь только то, что относится
// к рисованию: описание внешности и референсы едут к художнику одинаково из
// любой точки — CG-студия, камера телефона, фото от ботов, аватарки.
//
// Раньше каждое из этих мест собирало запрос по-своему, и один и тот же человек
// в телефоне, в Game Master и в истории был для художника тремя разными людьми.

// Референсы человека из CG-студии. Реф может быть закреплён на любом из его id
// (анкета, запись реестра, контакт) — проверяем все, а для персонажа проекта
// в запасе есть нейтральный спрайт.
async function personRefs(
  project: Project,
  person: Person,
  opts: { withOutfit: boolean }
): Promise<ImageRef[]> {
  const ig = imageGenFor(project);
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
  /** Какие рефы реально ушли художнику — чтобы было видно, а не гадать. */
  refs: RefReport;
}

export interface RefReport {
  /** «Старк — дизайн», «Кейт — одежда». */
  sent: string[];
  /** Кто в кадре, но рефа у него нет (ни своей картинки, ни спрайта). */
  missing: string[];
  /** Почему рефы не ушли вовсе (выключены, провайдер не принял). */
  note?: string;
}

/**
 * Имена из строки CAST воркера → люди. Воркер пишет имя как ему удобно («Тони
 * Старк» при карточке «Старк», «Старка»), и при точном сравнении человек
 * становился «безбумажным» — без записей, а значит, и без рефа: картинка шла по
 * тексту, и дизайн каждый раз выходил новым. Неузнанное имя ищем по словам
 * среди известных людей.
 */
export function resolveCast(project: Project, state: RuntimeState, names: string[]): Person[] {
  const out: Person[] = [];
  for (const name of names) {
    let p = resolvePerson(project, state, { name });
    if (p && !p.ids.length) p = personsInText(project, state, name)[0] || p;
    if (p && !out.some((x) => x.id === p!.id)) out.push(p);
  }
  return out;
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
  // Подключение — общее, стиль и рефы — проекта (см. imageConnection.ts).
  const ig = imageGenFor(project);

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
  if (opts.scanText) for (const p of personsInText(project, state, opts.scanText)) push(p);

  const known = people
    .map((p) => ({ name: p.name, look: describePerson(p) }))
    .filter((x) => x.look);
  const whoBlock = known.length
    ? `\nPeople in this image (draw them as described, these are established characters):\n` +
      known.map((x) => `- ${x.name}: ${x.look}`).join('\n')
    : '';

  const maxRefs = opts.maxRefs ?? 4;
  const refs: ImageRef[] = [];
  const report: RefReport = { sent: [], missing: [] };
  if (!supportsReferences(ig)) report.note = 'этот провайдер картинок рефы не принимает';
  else if (!ig.sendReferences) report.note = 'отправка рефов выключена (галочка «Отправлять рефы»)';
  for (const p of people) {
    if (refs.length >= maxRefs) break;
    const got = await personRefs(project, p, { withOutfit: !!opts.withOutfit });
    if (!got.length && !report.note) report.missing.push(p.name);
    for (const r of got) {
      if (refs.length >= maxRefs) break;
      refs.push(r);
    }
  }
  for (const r of refs) {
    const solo = r.kind === 'outfit' ? 'одежда' : refs.some((x) => x.kind === 'outfit' && x.who === r.who) ? 'внешность' : 'дизайн целиком';
    report.sent.push(`${r.who || '?'} — ${solo}`);
  }

  const finalPrompt = composeFinalPrompt(ig, `${opts.prompt.trim()}${whoBlock}`, { refs });
  const blob = await generateImage(ig, {
    prompt: finalPrompt,
    references: refs,
    aspectRatio: opts.aspectRatio,
    signal: opts.signal,
    onRefsDropped: (why) => {
      report.note = why;
      report.sent = [];
    },
  });
  return { blob, cast: people, finalPrompt, refs: report };
}
