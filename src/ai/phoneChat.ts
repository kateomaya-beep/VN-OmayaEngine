import type { Project, RuntimeState, LlmMessage, PhoneMessage } from '../shared/types';
import { PHONE_BALANCE_STAT } from '../shared/types';
import { runCompletion } from './providers';
import { getPresetSettings } from './presetSettings';
import { expandMacros } from './macros';
import { formatClock } from './gameMaster';

// Мессенджер телефона (Batch 7 §7.2). Отдельный лёгкий вызов ИИ: персонаж
// отвечает игроку СМС «в характере», не трогая основную сцену/движок. Возвращает
// чистый текст реплики (одно-два коротких сообщения в стиле переписки).

const MAX_HISTORY = 16; // сколько последних реплик переписки давать в контекст

function characterProfile(project: Project, state: RuntimeState, characterId: string): string {
  const c = project.characters.find((x) => x.id === characterId);
  if (!c) return `You are texting the hero. Stay in character.`;
  const ctx = { project, state };
  const rel = state.relationship[c.id] || c.relationship;
  const parts = [
    `You ARE ${c.name}. You are texting the hero from your phone — this is a private SMS/messenger chat, NOT the main story scene.`,
    `Personality: ${expandMacros(c.card.personality, ctx)}`,
    `Speech style: ${expandMacros(c.card.speechStyle, ctx)}`,
  ];
  if (c.card.backstory?.trim()) parts.push(`Backstory (for consistency): ${expandMacros(c.card.backstory, ctx).slice(0, 400)}`);
  parts.push(
    `Your feelings toward the hero right now (range -100..100): affection ${rel.affection}, passion ${rel.passion_stat}, friendship ${rel.friendship}, respect ${rel.respect}. Let these tint your tone.`
  );
  return parts.join('\n');
}

function worldContext(project: Project, state: RuntimeState): string {
  const parts: string[] = [];
  const clock = formatClock(state.gm.clock);
  if (clock) parts.push(`In-story time: ${clock}.`);
  // Короткая сводка последних событий, чтобы бот «был в курсе».
  const events = state.gm.events.slice(-3).map((e) => e.summary);
  if (events.length) parts.push(`Recent events the hero and you both know: ${events.join('; ')}.`);
  const heroName = state.protagonistName;
  if (heroName) parts.push(`The hero's name is ${heroName}.`);
  const bal = state.statValues[PHONE_BALANCE_STAT];
  if (typeof bal === 'number') parts.push(`(The hero's wallet balance is ${bal} ${project.phone?.currencyName || '$'} — only relevant if money comes up.)`);
  return parts.join('\n');
}

export async function generatePhoneReply(
  project: Project,
  state: RuntimeState,
  characterId: string,
  conversation: PhoneMessage[],
  signal?: AbortSignal
): Promise<string> {
  const ps = getPresetSettings();
  const narr = ps.narrativeLanguage === 'en' ? 'English' : 'Russian (русский)';

  const system = [
    characterProfile(project, state, characterId),
    worldContext(project, state),
    `TEXTING RULES:`,
    `- Reply as ${project.characters.find((c) => c.id === characterId)?.name || 'the character'} would in a text chat: short, natural, in-character.`,
    `- Write in ${narr}. Use casual messenger tone (may use short sentences, occasional emoji if it fits the character — do not overdo it).`,
    `- Output ONLY the message text. No name prefix, no quotation marks, no narration, no JSON, no stage directions.`,
    `- Keep it to 1–3 short messages worth of text (a few sentences at most). React to the hero's last message.`,
  ].join('\n');

  const messages: LlmMessage[] = conversation.slice(-MAX_HISTORY).map((m) => ({
    role: m.from === 'protagonist' ? ('user' as const) : ('assistant' as const),
    content: m.text,
  }));
  // Гарантируем, что последнее сообщение — от игрока (иначе модели нечего отвечать).
  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    messages.push({ role: 'user', content: '…' });
  }

  const raw = await runCompletion({
    system,
    messages,
    temperature: Math.min(ps.temperature ?? 0.8, 1),
    maxTokens: 400,
    reasoningEffort: 'none',
    signal,
  });

  // Чистим возможную обвязку (кавычки, префикс имени, случайный JSON).
  let text = raw.trim();
  // Срезаем ведущий "Имя:" если модель всё же добавила.
  const name = project.characters.find((c) => c.id === characterId)?.name;
  if (name && text.toLowerCase().startsWith(name.toLowerCase() + ':')) {
    text = text.slice(name.length + 1).trim();
  }
  // Снимаем обрамляющие кавычки.
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith('«') && text.endsWith('»'))) {
    text = text.slice(1, -1).trim();
  }
  return text || '…';
}
