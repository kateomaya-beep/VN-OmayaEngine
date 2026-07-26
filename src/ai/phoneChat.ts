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

  const charName = project.characters.find((c) => c.id === characterId)?.name || 'the character';
  const system = [
    characterProfile(project, state, characterId),
    worldContext(project, state),
    `TEXTING RULES (this is a plain text-message chat, NOT the visual-novel narration engine):`,
    `- Reply as ${charName} would type in a messenger: short, natural, in-character. React to the hero's last message.`,
    `- Write in ${narr}. Casual messenger tone; occasional emoji if it fits — do not overdo it.`,
    `- Output ONLY the literal words ${charName} types. NOTHING else.`,
    `- ABSOLUTELY FORBIDDEN: mood/tone labels or emotion tags of any kind (e.g. "(Defensive/Playful):", "[teasing]", "Amused:"), asterisk actions or roleplay markup (e.g. *smiles*, *rolls eyes*), narration, stage directions, character name prefixes, quotation marks around the whole message, JSON, or any commentary about the message. Just the message text itself.`,
    `- Keep it to 1–3 short messages worth of text (a few sentences at most). Finish your thought — do not cut off mid-sentence.`,
  ].join('\n');

  const messages: LlmMessage[] = conversation.slice(-MAX_HISTORY).map((m) => ({
    role: m.from === 'protagonist' ? ('user' as const) : ('assistant' as const),
    // Фото без текста (селфи из камеры) — модель vision не видит, даём словесную пометку.
    content: m.text || (m.attachedAssetId ? '[the hero sent you a photo]' : '…'),
  }));
  // Гарантируем, что последнее сообщение — от игрока (иначе модели нечего отвечать).
  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    messages.push({ role: 'user', content: '…' });
  }

  const raw = await runCompletion({
    system,
    messages,
    temperature: Math.min(ps.temperature ?? 0.8, 1),
    // Больше запаса, чтобы reasoning-модели не обрезали короткую реплику на полуслове.
    maxTokens: 800,
    reasoningEffort: 'none',
    signal,
  });

  return cleanReply(raw, charName);
}

// Убирает артефакты «режиссёрского» формата, если модель их всё же добавила:
// метки тона «(Defensive/Playful):», префикс имени, звёздочки-действия, кавычки, JSON.
export function cleanReply(raw: string, charName: string): string {
  let text = (raw || '').trim();

  // Если пришёл JSON — пытаемся достать текст реплики.
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const obj = JSON.parse(text);
      const cand = obj?.text ?? obj?.message ?? obj?.reply ?? (Array.isArray(obj) ? obj[0]?.text : '');
      if (typeof cand === 'string' && cand.trim()) text = cand.trim();
    } catch {
      /* оставляем как есть */
    }
  }

  // Срезаем ведущую метку тона/эмоции в скобках или до двоеточия:
  //   "(Defensive/Playful):", "[teasing]", "Amused:" — но НЕ реальную реплику с «:».
  text = text.replace(/^\s*[([][^)\]\n]{0,40}[)\]]\s*[:—-]?\s*/, '');
  const colon = text.match(/^\s*([A-Za-zА-Яа-яЁё/ ]{1,24}):\s+(?=\S)/);
  if (colon && /^[A-Z]/.test(colon[1].trim()) && !colon[1].includes(' ')) {
    // одно слово-метка с заглавной (Amused, Defensive…) — режем
    text = text.slice(colon[0].length);
  }

  // Ведущий префикс имени персонажа.
  if (charName && text.toLowerCase().startsWith(charName.toLowerCase())) {
    const rest = text.slice(charName.length).trimStart();
    if (rest.startsWith(':')) text = rest.slice(1).trimStart();
  }

  // Снимаем обрамляющие кавычки/звёздочки, если обёрнута вся реплика.
  const pairs: [string, string][] = [['"', '"'], ['«', '»'], ['*', '*'], ['“', '”']];
  for (const [l, r] of pairs) {
    if (text.length > 1 && text.startsWith(l) && text.endsWith(r)) {
      text = text.slice(l.length, -r.length).trim();
    }
  }
  // Одиночная висячая звёздочка в начале (незакрытое действие).
  text = text.replace(/^\*+\s*/, '').replace(/\s*\*+$/, '').trim();

  return text || '…';
}
