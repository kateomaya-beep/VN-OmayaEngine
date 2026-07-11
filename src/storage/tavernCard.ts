import { CharacterCard } from '@lenml/char-card-reader';
import type { Character, LorebookEntry, AssetMeta } from '../shared/types';
import { uid } from '../shared/utils';
import { putAsset } from './db';

export interface ImportedCharacter {
  character: Character; // character.sprites.neutral, если задан, ссылается на avatarAsset.id
  avatarAsset?: AssetMeta; // добавить в project.assets ДО/вместе с character
  lorebookEntries: LorebookEntry[];
  hasSystemPrompt: boolean; // system_prompt/post_history_instructions найдены, но НЕ применены
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob | null> {
  try {
    const res = await fetch(dataUrl);
    return await res.blob();
  } catch {
    return null;
  }
}

function mapCharacterBook(book: any): LorebookEntry[] {
  const entries = Array.isArray(book?.entries) ? book.entries : [];
  return entries
    .filter((e: any) => e && typeof e.content === 'string')
    .map((e: any) => {
      const keys = [...(e.keys || []), ...(e.selective ? e.secondary_keys || [] : [])].filter(
        (k: unknown) => typeof k === 'string'
      );
      return {
        id: uid('lb'),
        title: e.name || e.comment || keys[0] || 'Запись',
        keys,
        content: e.content,
        alwaysActive: !!e.constant,
        priority: typeof e.priority === 'number' ? e.priority : 0,
      };
    });
}

// Импорт карточки персонажа формата Character Card V2/V3 (PNG со встроенным
// JSON в tEXt-чанке или .json-файл) — см. CR v2 §D1. Использует @lenml/char-card-reader
// (не парсим PNG-чанки вручную). Мягкая ошибка на защищённых/нечитаемых карточках —
// движок никогда не крашится на чужом файле.
export async function importTavernCard(file: File): Promise<ImportedCharacter> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let card: CharacterCard;

  try {
    if (file.name.toLowerCase().endsWith('.json')) {
      const json = JSON.parse(new TextDecoder().decode(buf));
      card = CharacterCard.from_json(json);
    } else {
      card = await CharacterCard.from_file(buf);
    }
  } catch (e) {
    const name = (e as any)?.constructor?.name;
    if (name === 'CharacterCardParserError' || /Failed to extract/i.test((e as Error).message || '')) {
      throw new Error(
        'Не удалось прочитать карточку — возможно, она защищена (Janitor) или повреждена.'
      );
    }
    throw new Error('Файл не похож на карточку персонажа: ' + (e as Error).message);
  }

  const description = card.description && card.description !== 'unknown' ? card.description : '';
  const personality = card.personality && card.personality !== 'unknown' ? card.personality : '';
  // Описание часто смешанное — при неоднозначности всё уходит в personality (см. CR §D1.3).
  const mergedPersonality = [description, personality].filter(Boolean).join('\n\n');

  const firstMes = card.first_message && card.first_message !== 'unknown' ? card.first_message : '';
  const greetings = [firstMes, ...(card.alternate_greetings || [])].filter(Boolean);

  const systemPrompt = (card.raw_data as any)?.data?.system_prompt || (card.raw_data as any)?.system_prompt;
  const postHistory =
    (card.raw_data as any)?.data?.post_history_instructions ||
    (card.raw_data as any)?.post_history_instructions;
  const sourceSystemPrompt = [systemPrompt, postHistory].filter(Boolean).join('\n\n---\n\n') || undefined;

  const spec = card.spec === 'chara_card_v3' ? 'tavern_v3' : 'tavern_v2';

  // Аватар → спрайт neutral (fallback), чтобы карточка не осталась совсем без картинки.
  let sprites: Character['sprites'] = {};
  let avatarAsset: AssetMeta | undefined;
  const avatar = await card.get_avatar(true).catch(() => '');
  if (avatar) {
    const blob = await dataUrlToBlob(avatar);
    if (blob) {
      const blobKey = uid('blob');
      await putAsset(blobKey, blob);
      avatarAsset = {
        id: uid('spr'),
        type: 'sprite',
        name: 'avatar_neutral',
        blobKey,
        mime: blob.type || 'image/png',
      };
      sprites = { neutral: avatarAsset.id };
    }
  }

  const character: Character = {
    id: uid('char'),
    name: card.name && card.name !== 'unknown' ? card.name : 'Импортированный персонаж',
    role: 'important_character', // юзер выбирает роль сразу после импорта (см. CR §D1.4)
    card: {
      appearance: '',
      personality: mergedPersonality,
      backstory: '',
      speechStyle: card.message_example && card.message_example !== 'unknown' ? card.message_example : '',
      scenario: card.scenario && card.scenario !== 'unknown' ? card.scenario : undefined,
      greetings: greetings.length ? greetings : undefined,
    },
    sprites,
    relationship: { affection: 0, passion_stat: 0, friendship: 0 },
    importedFrom: spec,
    sourceSystemPrompt,
  };

  const lorebookEntries = mapCharacterBook(card.character_book);

  return { character, avatarAsset, lorebookEntries, hasSystemPrompt: !!sourceSystemPrompt };
}
