import type { AssetMeta, PhoneContact, Project, RuntimeState } from '../shared/types';
import { getApiKey } from './keys';
import { putAsset } from '../storage/db';
import { uid } from '../shared/utils';
import { logEvent } from '../shared/logStore';
import { nameOfContact } from './phoneChat';
import { renderImage } from './imageCast';
import { resolvePerson, describePerson as describeOf } from './characterRegistry';

// Фото, которое присылает БОТ (Телефон 2.0). Решение пользователя: генерируем
// через то же image-API, что и камера/CG-студия — отдельного подключения нет.
// Возвращает готовый ассет (blob уже в хранилище) или null, если генерация
// невозможна/не удалась: переписка из-за этого ломаться не должна.

// Кого рисуем. personId — любой id этого человека: анкета проекта, запись
// реестра Game Master или сам контакт телефона. Разрешает его imageCast — тот
// же механизм, что и ростер в промпте, поэтому «перс из телефона» и «перс из
// Game Master» больше не разные люди.
export interface PersonSubject {
  name: string;
  personId?: string;
  /** Своё описание внешности; пусто → соберём из карточки/досье/реестра. */
  description?: string;
}

// Описание внешности человека. Осталось экспортом ради превью в UI телефона.
export function describePerson(project: Project, state: RuntimeState, subject: PersonSubject): string {
  const own = subject.description?.trim();
  if (own) return own;
  return describeOf(resolvePerson(project, state, { id: subject.personId, name: subject.name }));
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
    const own = subject.description?.trim();
    const basePrompt = [
      `Messenger profile picture (avatar) of ${name}.`,
      own ? `${name}: ${own}.` : '',
      'Head-and-shoulders portrait, square 1:1 crop, face clearly visible and centred, relaxed natural expression, simple uncluttered background.',
      'It is a picture this person chose for their own profile — not a story illustration, no scene action, no other people in frame, no text or watermarks.',
    ]
      .filter(Boolean)
      .join(' ');

    // Одежду в аватарку не тащим: кадр по плечи, наряд там всё равно не читается,
    // а второй реф только сбивает лицо. Текст промпта не сканируем — в кадре
    // ровно один человек, и это владелец профиля.
    const { blob } = await renderImage(project, state, {
      prompt: basePrompt,
      cast: [{ id: subject.personId, name }],
      withOutfit: false,
      maxRefs: 2,
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
  state: RuntimeState,
  title: string,
  topic?: string,
  signal?: AbortSignal
): Promise<AssetMeta | null> {
  if (!getApiKey('image')) return null;
  try {
    const basePrompt = [
      `Group-chat avatar icon for a messenger group called "${title.trim() || 'группа'}".`,
      topic?.trim() ? `The group is about: ${topic.trim()}.` : '',
      'Simple square 1:1 image, one clear central subject or symbol, uncluttered background, no text, no letters, no watermarks, no people posing.',
    ]
      .filter(Boolean)
      .join(' ');
    const { blob } = await renderImage(project, state, {
      prompt: basePrompt,
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
    const who = contact ? nameOfContact(project, state, contact) : 'the sender';
    // Кадр «как с телефона»: снимал живой человек, а не фотограф.
    const basePrompt = [
      `A photo taken on a smartphone by ${who} and sent to a friend in a messenger: ${trimmed}.`,
      `Casual amateur phone photography, natural available light, realistic colours, slight handheld imperfection.`,
    ].join(' ');

    // Кто в кадре. Отправителя добавляем, только если он снял сам себя: иначе
    // его лицо лезло на фото улицы или еды. Всех остальных — по именам в тексте
    // промпта: «фото с Дэмианом» рисовалось случайным парнем именно потому, что
    // имя ни с кем не связывалось.
    const selfInFrame = /selfie|self-portrait|me\b|myself|my face|мо[ёе] лицо|селфи/i.test(trimmed);
    const personId = contact?.characterId || contact?.registryId || contact?.id;
    const { blob } = await renderImage(project, state, {
      prompt: basePrompt,
      cast: selfInFrame ? [{ id: personId, name: who }] : [],
      scanText: trimmed,
      withOutfit: true,
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
