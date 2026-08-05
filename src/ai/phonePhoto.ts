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
    // модель тащит его лицо на фото улицы или еды.
    const refs: ImageRef[] = [];
    const selfInFrame = /selfie|self-portrait|me\b|myself|my face|мо[ёе] лицо|селфи/i.test(trimmed);
    const charId = contact?.characterId;
    if (selfInFrame && charId && supportsReferences(ig) && ig.sendReferences) {
      const char = project.characters.find((c) => c.id === charId);
      const slots: { id?: string; kind: 'appearance' | 'outfit' }[] = [
        { id: ig.references[charId] || (char ? resolveSprite(char, undefined, 'neutral') : undefined), kind: 'appearance' },
        { id: ig.outfitReferences?.[charId], kind: 'outfit' },
      ];
      for (const slot of slots) {
        const blobKey = slot.id ? project.assets.find((a) => a.id === slot.id)?.blobKey : undefined;
        if (!blobKey) continue;
        const b = await getAssetBlob(blobKey);
        if (b) refs.push(await blobToRef(b, { who, kind: slot.kind }));
      }
    }

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
