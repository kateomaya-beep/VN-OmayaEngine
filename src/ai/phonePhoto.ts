import type { AssetMeta, PhoneContact, Project, RuntimeState } from '../shared/types';
import { defaultImageGenConfig } from '../shared/types';
import { blobToRef, composeFinalPrompt, generateImage, supportsReferences, type ImageRef } from './imageProvider';
import { getApiKey } from './keys';
import { getAssetBlob, putAsset } from '../storage/db';
import { resolveSprite } from '../shared/outfits';
import { uid } from '../shared/utils';
import { logEvent } from '../shared/logStore';
import { nameOfContact } from './phoneChat';

// Фото, которое присылает БОТ (Телефон 2.0). Решение пользователя: генерируем
// через то же image-API, что и камера/CG-студия — отдельного подключения нет.
// Возвращает готовый ассет (blob уже в хранилище) или null, если генерация
// невозможна/не удалась: переписка из-за этого ломаться не должна.

// Кого рисуем. personId — ключ, по которому в CG-студии закреплены референсы
// (id персонажа проекта, записи реестра или самого контакта — они не пересекаются).
export interface PersonSubject {
  name: string;
  personId?: string;
  /** Своё описание внешности; пусто → соберём из карточки/досье. */
  description?: string;
}

// Описание внешности из того, что вообще известно об этом человеке: карточка
// персонажа → досье Game Master → запись реестра. Без него аватарка рисовалась
// «по имени», то есть по сути случайным человеком.
export function describePerson(project: Project, state: RuntimeState, subject: PersonSubject): string {
  const own = subject.description?.trim();
  if (own) return own;
  const bits: string[] = [];
  const char = subject.personId ? project.characters.find((c) => c.id === subject.personId) : undefined;
  if (char) {
    if (char.card.appearance.trim()) bits.push(char.card.appearance.trim());
    if (char.card.personality.trim() && bits.length === 0) bits.push(char.card.personality.trim());
  }
  const dossier = state.gm.characters.find(
    (c) => (subject.personId && c.charId === subject.personId) || c.name.toLowerCase() === subject.name.toLowerCase()
  );
  if (dossier) {
    if (dossier.appearance?.trim()) bits.push(dossier.appearance.trim());
    if (!bits.length && dossier.dossier?.trim()) bits.push(dossier.dossier.trim());
    if (dossier.outfit?.trim()) bits.push(`Usually wears: ${dossier.outfit.trim()}`);
  }
  const reg = subject.personId ? state.gm.registry?.find((r) => r.id === subject.personId) : undefined;
  if (!bits.length && reg?.status?.trim()) bits.push(reg.status.trim());
  // Заметка автора о контакте — последний источник: у мамы/папы карточки нет.
  const ct = (state.phone?.contacts || []).find(
    (c) => c.id === subject.personId || c.characterId === subject.personId || c.registryId === subject.personId
  );
  if (!bits.length && ct?.note?.trim()) bits.push(ct.note.trim());
  return bits.join('. ').slice(0, 600);
}

// Референсы человека из CG-студии: своя картинка, иначе нейтральный спрайт
// персонажа. Общая точка для селфи, фото от ботов и аватарок — чтобы «реф,
// закреплённый в картинках» действительно работал везде одинаково.
export async function loadPersonRefs(
  project: Project,
  personId: string | undefined,
  who: string,
  opts?: { withOutfit?: boolean }
): Promise<ImageRef[]> {
  const ig = project.imageGen ?? defaultImageGenConfig();
  const refs: ImageRef[] = [];
  if (!personId || !supportsReferences(ig) || !ig.sendReferences) return refs;
  const char = project.characters.find((c) => c.id === personId);
  const slots: { id?: string; kind: 'appearance' | 'outfit' }[] = [
    { id: ig.references[personId] || (char ? resolveSprite(char, undefined, 'neutral') : undefined), kind: 'appearance' },
  ];
  if (opts?.withOutfit) slots.push({ id: ig.outfitReferences?.[personId], kind: 'outfit' });
  for (const slot of slots) {
    const blobKey = slot.id ? project.assets.find((a) => a.id === slot.id)?.blobKey : undefined;
    if (!blobKey) continue;
    const b = await getAssetBlob(blobKey);
    if (b) refs.push(await blobToRef(b, { who, kind: slot.kind }));
  }
  return refs;
}

// Аватарка для мессенджера. Раньше сюда уходил только текст из поля ввода — и
// выходил случайный человек в случайном стиле. Теперь: стиль проекта (как у всех
// картинок) + референс персонажа из CG-студии + описание внешности из карточки/
// досье, а от «аватарки» остаётся только кадрирование и постановка.
export async function generateAvatarImage(
  project: Project,
  state: RuntimeState,
  subject: PersonSubject,
  signal?: AbortSignal
): Promise<AssetMeta | null> {
  if (!getApiKey('image')) return null;
  const name = subject.name.trim() || 'a person';
  try {
    const ig = project.imageGen ?? defaultImageGenConfig();
    const look = describePerson(project, state, subject);
    // Одежду в аватарку не тащим: кадр по плечи, наряд там всё равно не читается,
    // а второй реф только сбивает лицо.
    const refs = await loadPersonRefs(project, subject.personId, name, { withOutfit: false });
    const basePrompt = [
      `Messenger profile picture (avatar) of ${name}.`,
      look ? `${name}: ${look}.` : '',
      'Head-and-shoulders portrait, square 1:1 crop, face clearly visible and centred, relaxed natural expression, simple uncluttered background.',
      'It is a picture this person chose for their own profile — not a story illustration, no scene action, no other people in frame, no text or watermarks.',
    ]
      .filter(Boolean)
      .join(' ');

    const blob = await generateImage(ig, {
      prompt: composeFinalPrompt(ig, basePrompt, { refs }),
      references: refs,
      aspectRatio: '1:1',
      signal,
    });
    const blobKey = uid('blob');
    await putAsset(blobKey, blob);
    return {
      id: uid('cg'),
      type: 'icon', // 'icon' не попадает в манифест сцены — аватарка не фон и не CG
      name: `Аватар: ${name.slice(0, 24)}`,
      generated: true,
      blobKey,
      mime: blob.type || 'image/png',
    };
  } catch (e) {
    logEvent('error', 'phone', 'Аватарка не сгенерировалась: ' + (e as Error).message);
    throw e;
  }
}

// Аватарка группы: людей в кадре нет, поэтому ни рефов, ни описания внешности —
// только стиль проекта и то, о чём чат.
export async function generateGroupAvatarImage(
  project: Project,
  title: string,
  topic?: string,
  signal?: AbortSignal
): Promise<AssetMeta | null> {
  if (!getApiKey('image')) return null;
  try {
    const ig = project.imageGen ?? defaultImageGenConfig();
    const basePrompt = [
      `Group-chat avatar icon for a messenger group called "${title.trim() || 'группа'}".`,
      topic?.trim() ? `The group is about: ${topic.trim()}.` : '',
      'Simple square 1:1 image, one clear central subject or symbol, uncluttered background, no text, no letters, no watermarks, no people posing.',
    ]
      .filter(Boolean)
      .join(' ');
    const blob = await generateImage(ig, {
      prompt: composeFinalPrompt(ig, basePrompt),
      aspectRatio: '1:1',
      signal,
    });
    const blobKey = uid('blob');
    await putAsset(blobKey, blob);
    return {
      id: uid('cg'),
      type: 'icon',
      name: `Аватар группы: ${title.slice(0, 24)}`,
      generated: true,
      blobKey,
      mime: blob.type || 'image/png',
    };
  } catch (e) {
    logEvent('error', 'phone', 'Аватарка группы не сгенерировалась: ' + (e as Error).message);
    throw e;
  }
}

export async function generateContactPhoto(
  project: Project,
  state: RuntimeState,
  contact: PhoneContact | undefined,
  prompt: string,
  signal?: AbortSignal
): Promise<AssetMeta | null> {
  if (!getApiKey('image')) return null;
  const trimmed = prompt.trim();
  if (!trimmed) return null;
  try {
    const ig = project.imageGen ?? defaultImageGenConfig();
    const who = contact ? nameOfContact(project, state, contact) : 'the sender';
    // Кадр «как с телефона»: снимал живой человек, а не фотограф.
    const basePrompt = [
      `A photo taken on a smartphone by ${who} and sent to a friend in a messenger: ${trimmed}.`,
      `Casual amateur phone photography, natural available light, realistic colours, slight handheld imperfection.`,
    ].join(' ');

    // Референсы отправителя — только если он сам в кадре (селфи и т.п.): иначе
    // модель тащит его лицо на фото улицы или еды. Реф ищем и по персонажу
    // проекта, и по самому контакту (для тех, у кого карточки нет).
    const selfInFrame = /selfie|self-portrait|me\b|myself|my face|мо[ёе] лицо|селфи/i.test(trimmed);
    const personId = contact?.characterId || contact?.registryId || contact?.id;
    const refs = selfInFrame ? await loadPersonRefs(project, personId, who, { withOutfit: true }) : [];

    const blob = await generateImage(ig, {
      prompt: composeFinalPrompt(ig, basePrompt, { refs }),
      references: refs,
      aspectRatio: selfInFrame ? '3:4' : '4:3',
      signal,
    });
    const blobKey = uid('blob');
    await putAsset(blobKey, blob);
    return {
      id: uid('cg'),
      type: 'cg',
      name: `Фото от ${who}: ${trimmed.slice(0, 24)}`,
      generated: true,
      blobKey,
      mime: blob.type || 'image/png',
    };
  } catch (e) {
    logEvent('warn', 'phone', 'Фото от контакта не сгенерировалось: ' + (e as Error).message);
    return null;
  }
}
