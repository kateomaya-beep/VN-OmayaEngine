import { uid } from '../shared/utils';
import { parsePresetJson, type PromptBlock, type PromptPreset } from './promptPreset';

// ПРЕСЕТ ДЛЯ ЛОКАЛЬНОЙ МОДЕЛИ (LM Studio, Ollama и прочий свой сервер).
//
// Это не «облегчённая копия ради экономии» — это другой инструмент под другую
// модель. Полный РП-пресет написан для больших моделей: полтора десятка блоков
// нюансов (анти-слоп, арки сюжета, информационная гигиена, реализм поступков) —
// пара тысяч токенов инструкций. У Gemma 4B или Qwen 8B на это есть два ответа,
// и оба плохие:
//   — контекст. У локальных сборок его часто 4–8k, и системная часть съедает
//     почти весь, не оставляя места истории. Модель становится амнезиком.
//   — внимание. Маленькая модель не удержит пятнадцать правил разом: она начнёт
//     ронять то одно, то другое, причём непредсказуемо. Три правила, которые она
//     ВЫПОЛНЯЕТ, полезнее пятнадцати, которые она читает и забывает.
//
// Поэтому здесь остаётся только то, без чего РП перестаёт быть РП: не писать за
// игрока, писать прозой в заданном формате, держать длину. Всё остальное отдано
// самой модели — пусть тратит силы на текст, а не на свод правил.
//
// Служебного блока <state> здесь тоже нет намеренно: просить маленькую модель
// выдавать валидный JSON в конце каждого хода — почти гарантированный способ
// испортить и JSON, и прозу перед ним.

function makeDefaults(): PromptBlock[] {
  const b = (builtinKey: string, name: string, content: string): PromptBlock => ({
    id: uid('blk'),
    name,
    enabled: true,
    content,
    builtinKey,
  });

  return [
    b(
      'local_identity',
      '✦ Кто вы и главное правило',
      `You are the narrator of a roleplay with {{user}}. You write the world and every character in it — except {{user}}.

NEVER write {{user}}'s words, thoughts, feelings or actions. Not one line. Describe what happens TO them and what others do; stop where it is their turn to act.

Write in past tense, third person, unless the story already uses something else.`
    ),
    b(
      'local_format',
      '⚙ Формат',
      `Speech goes in "double quotes". Always. Never use a dash to open a line of speech.
Everything else — actions, description — is plain text.
*Italics* only for a character's unspoken thought. **Bold** only for real emphasis.

Write plain paragraphs. No headings, no lists, no "Name:" prefixes, no notes to the player, no summary of what just happened.`
    ),
    b(
      'local_style',
      '✎ Как писать',
      `Show what happens through action, speech and the senses. Concrete details, not grand words.
Give each character their own way of speaking.
Characters want their own things and may refuse {{user}}, argue, or leave. Do not make everyone agreeable.
End on something {{user}} can respond to — a question, a gesture, a silence.`
    ),
    b(
      'local_moves',
      '⚙ Пометки хода',
      `The player's move arrives tagged. The tag is engine plumbing — never mention or answer it.
"[VERBATIM] …" — what {{user}} said or did. Take it as given, react with the world.
"[CONTINUE]" — {{user}} is watching. Move the scene yourself, still writing nothing for them.
"[OOC] …" — a note to you as the author, not part of the story.
"[GAME START] …" — open the story from this description.

In {{user}}'s own text, *italics* mean a private thought — nobody in the scene can hear it.`
    ),
    // Пустые слоты — как в больших пресетах: место под своё.
    b('jailbreak', '🔓 Jailbreak (свой)', ''),
    b('nsfw', '🔞 NSFW (свой)', ''),
    // Динамика: наполняет движок. Здесь их МЕНЬШЕ, чем в полном пресете, и это
    // тоже сознательно — досье, лорбук и реестр раздувают запрос сильнее всего,
    // а на маленьком контексте важнее оставить место живой переписке.
    { ...b('world', '↳ Мир и правила', ''), dynamic: 'world' },
    { ...b('scene_chars', '↳ Персонажи в фокусе', ''), dynamic: 'characters' },
    { ...b('memory', '↳ Память', ''), dynamic: 'memory' },
    { ...b('chat_history', '💬 История переписки', ''), dynamic: 'history' },
  ];
}

export function defaultLocalPreset(): PromptPreset {
  return { id: 'omaya_local_default', name: 'OmayaEngine Local (compact)', blocks: makeDefaults() };
}

// Дефолтный текст блока — для кнопки «вернуть по умолчанию».
export function defaultLocalBlockContent(builtinKey: string): string | null {
  return makeDefaults().find((b) => b.builtinKey === builtinKey)?.content ?? null;
}

const LOCAL_BUILTIN_ORDER = makeDefaults().map((b) => b.builtinKey as string);

export function normalizeLocalPreset(raw: unknown): PromptPreset {
  const parsed =
    raw && typeof raw === 'object' && Array.isArray((raw as any).blocks) ? parsePresetJson(raw) : null;
  if (!parsed) return defaultLocalPreset();
  const have = new Set(parsed.blocks.map((b) => b.builtinKey).filter(Boolean) as string[]);
  const missing = makeDefaults().filter((b) => b.builtinKey && !have.has(b.builtinKey));
  if (!missing.length) return parsed;
  // Недостающие блоки вставляем на штатные места по порядку дефолта, а не в конец:
  // блок ниже истории переписки читается моделью как более свежий, и «формат»
  // внизу вёл бы себя иначе, чем задумано.
  const blocks = [...parsed.blocks];
  for (const block of missing) {
    const want = LOCAL_BUILTIN_ORDER.indexOf(block.builtinKey as string);
    let at = blocks.length;
    for (let i = 0; i < blocks.length; i++) {
      const idx = blocks[i].builtinKey ? LOCAL_BUILTIN_ORDER.indexOf(blocks[i].builtinKey as string) : -1;
      if (idx > want) {
        at = i;
        break;
      }
    }
    blocks.splice(at, 0, { ...block, id: uid('blk') });
  }
  return { ...parsed, blocks };
}
