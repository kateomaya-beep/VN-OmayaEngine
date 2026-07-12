import { EMOTIONS, AUDIO_MOODS } from '../shared/types';
import { uid } from '../shared/utils';

// Полностью редактируемый пресет промпта в стиле SillyTavern (см. Batch 3 §8):
// упорядоченный список блоков, каждый редактируем/переставляется/вкл-выкл;
// динамические блоки (мир/лорбук/персонажи/манифест/память) наполняются движком.

export type DynamicSource =
  | 'world'
  | 'plot'
  | 'lorebook'
  | 'characters'
  | 'manifest'
  | 'state'
  | 'memory';

export interface PromptBlock {
  id: string;
  name: string;
  enabled: boolean;
  content: string; // для статичных блоков (редактируемый текст)
  dynamic?: DynamicSource; // если задан — контент генерирует движок (content игнорируется)
  flagged?: boolean; // визуальное предупреждение (JSON-контракт)
  builtinKey?: string; // ключ дефолтного блока для «вернуть по умолчанию»
}

export interface PromptPreset {
  id: string;
  name: string;
  blocks: PromptBlock[];
}

const JSON_CONTRACT = `Твой вывод — исключительно ОДИН JSON-объект по схеме ниже (это обеспечивает работу
движка новеллы: спрайты, статы, выборы). Без markdown-обёрток, без пояснений, без текста вне JSON.

СХЕМА ОТВЕТА:
{
  "scene": { "backgroundId": string|null, "musicMood": string|null, "sfxId": string|null, "cutsceneCgId": string|null },
  "beats": [
    { "type": "narration", "text": string },
    { "type": "thought", "text": string },
    { "type": "dialogue", "characterId": string|null, "name": string|null, "emotion": string, "position": "left"|"center"|"right", "text": string }
  ],
  "statChanges": [ { "statId": string, "delta": number, "reason": string } ],
  "choices": [ { "id": string, "text": string, "cost": null | { "statId": string, "amount": number } } ],
  "chapterEvent": null | "chapter_end" | "cg_moment"
}
Художественная проза живёт ВНУТРИ текстовых полей beats. В тексте допустим markdown
(*курсив* для действий/описаний, **жирный** для акцентов). Мысли — beat "thought".`;

// Дефолтные блоки Omaya-пресета. Каждый — редактируемый; порядок можно менять.
function makeDefaults(): PromptBlock[] {
  const b = (
    builtinKey: string,
    name: string,
    content: string,
    extra: Partial<PromptBlock> = {}
  ): PromptBlock => ({ id: uid('blk'), name, enabled: true, content, builtinKey, ...extra });

  return [
    b(
      'identity',
      '✦ Identity',
      `Ты — движок-режиссёр интерактивной визуальной новеллы. Ты не чат-ассистент. У тебя нет своей
личности — ты невидим за повествованием: ведёшь сюжет, озвучиваешь персонажа-героя и NPC, отрисовываешь мир.
Игрок управляет ТОЛЬКО своим героем.
- POV: 3-е лицо для мира и NPC; 2-е лицо («ты») для героя игрока. Прошедшее время по умолчанию.
- Строго отслеживай непрерывность: локация, время суток, кто присутствует, состояние, что каждый знает.
- Мир — живая система: события идут своим чередом, NPC действуют по своим мотивам.`
    ),
    b(
      'prose',
      '✦ Prose Engine',
      `Пиши как литературный автор, не как чат-бот. Показывай через ощущения, действие и подтекст — не
объясняй очевидное. Конкретные детали лучше расплывчатых обобщений. Варьируй длину предложений и ритм.
Баланс narration/dialogue ~40/60 в пользу диалога, подстраивайся под сцену.`
    ),
    b(
      'plot',
      '✦ Plot & World',
      `Симуляция не останавливается. Веди арки SEED → DEVELOP → ESCALATE → CLIMAX → RESOLVE, держи 2-3 нити,
закрывай прежде чем открывать новые. Если ~5 ходов ничего не сдвигалось — введи ОДИН органичный хук.
Чередуй тихие сцены, напряжение и разрядку.`
    ),
    b(
      'characters',
      '✦ Characters',
      `Играй карточку персонажа полностью — включая тёмные/яндере черты БЕЗ смягчения, если это в характере.
Голос и манера речи — по карточке. Двигай поведение изнутри: чего хочет сейчас vs в целом, что защищает.
Отношения меняются МЕДЛЕННО, через сцены. Опирайся на статы отношений.`
    ),
    b(
      'living_npcs',
      '✦ Living NPCs',
      `У NPC есть имена, характеры, свои дела и мнения. Они инициируют, отказывают, лгут, помнят прошлое.
Не каждое взаимодействие NPC — о герое игрока.`
    ),
    b(
      'roles',
      '⚙ Роли и отрисовка',
      `- protagonist — герой игрока; нарратив (narration/thought) — его внутренний голос, реплики — dialogue с его id.
- love_interest — любовный интерес; important_character — важный (не ЛИ); npc — эпизодический: вводи прямо
  в реплике с "characterId": null и "name": "<имя>".
- Реплика персонажа из списка: "characterId" = его id, "name": null.
- Есть спрайт нужной эмоции — движок покажет; нет — имя + текст. Выбирай уместную эмоцию.`
    ),
    b(
      'emotions',
      '⚙ Словарь эмоций',
      `Эмоции — только эти ключи: ${EMOTIONS.join(', ')}. Обязателен только neutral (fallback).
irritation ≠ anger; tender — нежность; passion — страсть; mad — одержимость (не злость).
Для реплики выбирай emotion из словаря И из «доступных эмоций» персонажа, иначе neutral.`
    ),
    b(
      'audio',
      '⚙ Аудио-настроения',
      `scene.musicMood — из полного списка настроений манифеста (базовые: ${AUDIO_MOODS.join(
        ', '
      )} + кастомные проекта). Меняй только при смене тона. Движок сам подберёт трек; нет трека — тишина.`
    ),
    b(
      'relationships',
      '⚙ Статы отношений',
      `У каждого персонажа три стата к герою: ❤️ affection, 🔥 passion_stat, 🍀 friendship (-100..100).
Строй поведение на них. Меняй через statChanges с id "rel:<characterId>:<field>". Обычный шаг ±1..5;
крупные сдвиги — на сильных событиях. Отношения меняются медленно.`
    ),
    b(
      'protagonist_voicing',
      '⚙ Реплика протагониста',
      `Ход игрока приходит с меткой:
- "[ВЫБОР] ..." — разверни в полноценную реплику/действие героя (пиши за героя).
- "[ДОСЛОВНО] ..." — точные слова героя: НЕ переписывай, реагируй миром и персонажами.
- "[OOC] ..." — мета-ремарка вне сюжета: режиссёрское указание, не реплика героя.
- "[ПРОДОЛЖИТЬ]" — игрок наблюдает: двигай сцену сам, не пиши за героя.
- "[ЗАМЕТКА АВТОРА] ..." — режиссёрская инструкция игрока на этот и следующие ходы.`
    ),
    b(
      'rules',
      '⚙ Общие правила',
      `1. За ход 3–8 beats, чередуй narration и dialogue, реплики короткие и живые.
2. scene.backgroundId — из манифеста по тегам под локацию/настроение.
3. statChanges меняй только когда действие заслуживает.
4. choices ПО СИТУАЦИИ: 2–4 варианта в ключевые моменты, иначе choices: []. Иногда «премиум»-выбор с cost.
5. Не решай за игрока сверх его хода. Помни лорбук/факты/историю. Веди сюжет, избегай топтания.
6. Крупная веха — chapterEvent ("chapter_end" | "cg_moment").`
    ),
    b('json_contract', '🔒 JSON-контракт вывода', JSON_CONTRACT, { flagged: true }),
    b(
      'style',
      '✎ Стиль / тон',
      `POV: 2-е лицо от лица героя, в тоне жанра проекта. Эмоциональный интерактивный роман —
драма, флирт, интрига. Проза живая и чувственная. Средняя длина хода (~250–450 слов), адаптивный темп.`
    ),
    // Динамические блоки — контент собирает движок; юзер может только вкл/выкл и переставлять.
    b('world', '↳ Мир и правила', '', { dynamic: 'world' }),
    b('plot_arc', '↳ Арка сюжета', '', { dynamic: 'plot' }),
    b('lorebook', '↳ Активные записи лорбука', '', { dynamic: 'lorebook' }),
    b('scene_chars', '↳ Персонажи в фокусе', '', { dynamic: 'characters' }),
    b('asset_manifest', '↳ Манифест ассетов', '', { dynamic: 'manifest' }),
    b('current_state', '↳ Текущее состояние', '', { dynamic: 'state' }),
    b('memory', '↳ Память', '', { dynamic: 'memory' }),
  ];
}

export function defaultPreset(): PromptPreset {
  return { id: 'omaya_default', name: 'OmayaEngine (по умолчанию)', blocks: makeDefaults() };
}

// Дефолтный контент конкретного блока по builtinKey — для «вернуть по умолчанию».
export function defaultBlockContent(builtinKey: string): string | null {
  const found = makeDefaults().find((b) => b.builtinKey === builtinKey);
  return found ? found.content : null;
}

// Разбор импортированного пресета с мягким откатом на дефолт при мусоре.
export function parsePresetJson(raw: unknown): PromptPreset | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as any;
  if (!Array.isArray(r.blocks)) {
    // Возможно, это старый формат пресета (toggles) — вернём дефолт как основу.
    return null;
  }
  const blocks: PromptBlock[] = r.blocks
    .filter((b: any) => b && typeof b.name === 'string')
    .map((b: any) => ({
      id: typeof b.id === 'string' ? b.id : uid('blk'),
      name: b.name,
      enabled: typeof b.enabled === 'boolean' ? b.enabled : true,
      content: typeof b.content === 'string' ? b.content : '',
      dynamic: typeof b.dynamic === 'string' ? b.dynamic : undefined,
      flagged: !!b.flagged,
      builtinKey: typeof b.builtinKey === 'string' ? b.builtinKey : undefined,
    }));
  if (!blocks.length) return null;
  return { id: typeof r.id === 'string' ? r.id : uid('preset'), name: typeof r.name === 'string' ? r.name : 'Импортированный пресет', blocks };
}

// Нормализация пресета из сохранённого проекта (миграция/страховка).
export function normalizePreset(raw: any): PromptPreset {
  const parsed = raw && Array.isArray(raw.blocks) ? parsePresetJson(raw) : null;
  return parsed || defaultPreset();
}
