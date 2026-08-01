import type { Project, RuntimeState, LlmMessage, PhoneMessage } from '../shared/types';
import { getAssetBlob } from '../storage/db';
import { blobToRef } from './imageProvider';
import { PHONE_BALANCE_STAT } from '../shared/types';
import { runCompletion } from './providers';
import { getPresetSettings } from './presetSettings';
import { expandMacros } from './macros';
import { formatClock } from './gameMaster';
import { logEvent } from '../shared/logStore';

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
): Promise<string[]> {
  const ps = getPresetSettings();
  const narr = ps.narrativeLanguage === 'en' ? 'English' : 'Russian (русский)';

  const charName = project.characters.find((c) => c.id === characterId)?.name || 'the character';
  const system = [
    characterProfile(project, state, characterId),
    worldContext(project, state),
    `TEXTING RULES (this is a plain text-message chat, NOT the visual-novel narration engine):`,
    `- Reply as ${charName} would type in a messenger: short, natural, in-character. React to the hero's last message.`,
    `- MESSAGE BURSTS: reply the way people really text — sometimes ONE message, sometimes several short ones fired in a row (up to 4). Put EACH separate message on ITS OWN LINE (a line break = a new message bubble). Split when it feels natural (a quick thought, then another), keep it to one message when that's natural.`,
    `- Write in ${narr}. Use real texting culture WHEN IT FITS the character: casual tone, common abbreviations, emoji, and (for Russian) smiley parentheses like ), )), ))) or :). Lowercase and dropped punctuation are fine for a casual character. Match the character's personality — a formal or cold character texts differently; don't force slang on them.`,
    `- Output ONLY the literal words ${charName} types. NOTHING else.`,
    `- ABSOLUTELY FORBIDDEN: mood/tone labels or emotion tags of any kind (e.g. "(Defensive/Playful):", "[teasing]", "Amused:"), asterisk actions or roleplay markup (e.g. *smiles*, *rolls eyes*), narration, stage directions, character name prefixes, quotation marks around the whole message, JSON, or any commentary. Note: smiley parentheses like ")))" are allowed as emoji, but a parenthesis label like "(playful)" is NOT.`,
    `- Keep each message short (a texting line, not a paragraph). Finish your thought — never cut off mid-sentence.`,
  ].join('\n');

  const messages: LlmMessage[] = conversation
    // Выбрасываем заглушки «…» от прежних пустых ответов — иначе модель считает их
    // своим стилем и продолжает отвечать многоточиями.
    .filter((m) => m.text.trim() !== '…' || !!m.attachedAssetId)
    .slice(-MAX_HISTORY)
    .map((m) => ({
      role: m.from === 'protagonist' ? ('user' as const) : ('assistant' as const),
      // Текстовая пометка остаётся всегда: если модель картинки не принимает,
      // персонаж хотя бы знает, что ему прислали фото.
      content: m.text || (m.attachedAssetId ? '[the hero sent you a photo]' : '…'),
    }));

  // VISION: последнее фото герой отправил только что — прикладываем саму картинку,
  // чтобы персонаж отвечал на то, что НА фото, а не на пометку о нём. Модель без
  // поддержки картинок отбракует вложение, провайдер повторит запрос без него.
  const attachments = await loadLastPhoto(project, conversation);
  const raw = await completeWithRetry(
    system,
    normalizeChatHistory(messages),
    ps.temperature ?? 0.8,
    signal,
    attachments
  );
  return splitReplies(raw, charName);
}

// Фото из ПОСЛЕДНЕГО сообщения героя (если это фото) → вложение для vision-модели.
// Только одно и только свежее: старые фото раздували бы каждый запрос, а отвечает
// персонаж всегда на последнее. blobToRef заодно ужимает картинку до 768px.
async function loadLastPhoto(
  project: Project,
  conversation: PhoneMessage[]
): Promise<{ mime: string; b64: string }[] | undefined> {
  const last = conversation[conversation.length - 1];
  if (!last || last.from !== 'protagonist' || !last.attachedAssetId) return undefined;
  try {
    const blobKey = project.assets.find((a) => a.id === last.attachedAssetId)?.blobKey;
    if (!blobKey) return undefined;
    const blob = await getAssetBlob(blobKey);
    if (!blob) return undefined;
    const ref = await blobToRef(blob);
    return [{ mime: ref.mime, b64: ref.b64 }];
  } catch (e) {
    logEvent('warn', 'phone', 'Не удалось приложить фото к запросу: ' + (e as Error).message);
    return undefined;
  }
}

// Приводит историю переписки к виду, который принимают все провайдеры.
// ПРИЧИНА (баг «ответы на мои смс не приходят, а рандомные приходят»): если тред
// начинался входящим СМС, первым сообщением шёл assistant. Gemini (и его
// OpenAI-совместимые шлюзы) требуют, чтобы диалог начинался с user-хода, и на
// историю, открытую ходом модели, возвращают ПУСТОЙ текст — игрок видел «…».
// Заодно склеиваем подряд идущие одинаковые роли (их тоже принимают не все).
export function normalizeChatHistory(msgs: LlmMessage[]): LlmMessage[] {
  // 1) Отбрасываем ведущие assistant-сообщения, но не теряем их смысл: первое
  //    входящее становится частью вводного user-сообщения.
  let i = 0;
  const leading: string[] = [];
  while (i < msgs.length && msgs[i].role === 'assistant') {
    leading.push(msgs[i].content);
    i++;
  }
  const rest = msgs.slice(i);
  const out: LlmMessage[] = [];
  if (leading.length) {
    out.push({
      role: 'user',
      content: `(Earlier you texted the hero first: ${leading.join(' / ')})`,
    });
  }
  // 2) Склеиваем подряд идущие одинаковые роли.
  for (const m of rest) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content = `${last.content}\n${m.content}`;
    else out.push({ ...m });
  }
  // 3) Последним всегда ход игрока — иначе модели нечего отвечать.
  if (!out.length || out[out.length - 1].role !== 'user') {
    out.push({ role: 'user', content: '(reply to the last message)' });
  }
  return out;
}

// Вызов с ретраем на ПУСТОЙ ответ. Reasoning-модели (Gemini 3 и т.п.) нередко тратят
// весь бюджет на скрытое размышление и возвращают пустой текст — игрок видел «…»
// вместо реплики. Повтор идёт с бо́льшим лимитом и без принудительного reasoning:'none'
// (некоторые шлюзы на этом значении как раз и отдают пустоту).
async function completeWithRetry(
  system: string,
  messages: LlmMessage[],
  temperature: number,
  signal?: AbortSignal,
  attachments?: { mime: string; b64: string }[]
): Promise<string> {
  const first = await runCompletion({
    system,
    messages,
    temperature: Math.min(temperature, 1),
    maxTokens: 2400,
    reasoningEffort: 'none',
    signal,
    attachments,
  });
  if (first.trim()) return first;

  logEvent(
    'info',
    'phone',
    `Пустой ответ мессенджера — повторяю с увеличенным лимитом (история: ${messages
      .map((m) => m.role[0])
      .join('')})`
  );
  const second = await runCompletion({
    system: `${system}\n\nIMPORTANT: reply with the message text directly. Do not think out loud, do not return an empty response.`,
    messages,
    temperature: Math.min(temperature, 1),
    maxTokens: 6000,
    signal, // reasoningEffort не задаём — пусть провайдер решает сам
    attachments,
  });
  return second;
}

// Спонтанное входящее СМС от персонажа (гарантия движка): вызывается, когда
// случайное событие «входящее СМС» сработало, а модель не прислала sms_incoming-бит.
// Возвращает 1–2 коротких сообщения «из ниоткуда» в характере персонажа.
export async function generateIncomingSms(
  project: Project,
  state: RuntimeState,
  characterId: string,
  conversation: PhoneMessage[],
  signal?: AbortSignal
): Promise<string[]> {
  const ps = getPresetSettings();
  const narr = ps.narrativeLanguage === 'en' ? 'English' : 'Russian (русский)';
  const charName = project.characters.find((c) => c.id === characterId)?.name || 'the character';

  const system = [
    characterProfile(project, state, characterId),
    worldContext(project, state),
    `TASK: ${charName} texts the hero FIRST, out of the blue — the hero did not write to them just now.`,
    `- Pick a natural reason to reach out that fits the current story moment and your relationship: checking in, a question, a complaint, teasing, news, a request, missing them.`,
    `- Write in ${narr}, in real texting style: short, casual, in character. 1-2 messages, EACH ON ITS OWN LINE.`,
    `- Output ONLY the literal words ${charName} types. No tone labels, no asterisk actions, no narration, no name prefix, no JSON.`,
    conversation.length
      ? `- Continue naturally from the existing chat; do not repeat what was already said.`
      : `- This is the first message in this chat.`,
  ].join('\n');

  const recent = conversation.slice(-8).map((m) => ({
    role: m.from === 'protagonist' ? ('user' as const) : ('assistant' as const),
    content: m.text || '[photo]',
  }));

  const raw = await completeWithRetry(
    system,
    normalizeChatHistory([...recent, { role: 'user', content: '(write your incoming message now)' }]),
    ps.temperature ?? 0.9,
    signal
  );
  return splitReplies(raw, charName).slice(0, 2);
}

// Разбивает сырой ответ на отдельные сообщения-«пузыри» (Batch — живые смс).
// Строка = сообщение. Поддерживает и JSON-массив, если модель его прислала.
export function splitReplies(raw: string, charName: string): string[] {
  let text = (raw || '').trim();

  // JSON-массив строк.
  if (text.startsWith('[')) {
    try {
      const arr = JSON.parse(text);
      if (Array.isArray(arr)) {
        const out = arr
          .map((x) => (typeof x === 'string' ? x : typeof x?.text === 'string' ? x.text : ''))
          .map((m) => cleanReply(m, charName))
          .filter((m) => m && m !== '…');
        if (out.length) return out.slice(0, 5);
      }
    } catch {
      /* fallthrough к построчному разбору */
    }
  }

  const lines = text
    .split(/\n+/)
    .map((l) => cleanReply(l, charName))
    .filter((l) => l && l !== '…');
  // Пусто — возвращаем ПУСТОЙ список, а не «…»: вызывающий покажет ошибку и не
  // засорит переписку заглушкой (она потом ещё и уезжала в контекст как реплика).
  return lines.slice(0, 5);
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

  // Срезаем ведущую метку тона/эмоции в скобках ТОЛЬКО если за ней двоеточие:
  //   "(Defensive/Playful):" / "[teasing]:" — режем; но "(наконец-то дозвонилась))"
  //   как реальный текст/смайлик НЕ трогаем.
  text = text.replace(/^\s*[([][^)\]\n]{0,40}[)\]]\s*:\s*/, '');
  // Одно слово-метка с заглавной перед двоеточием (Amused: / Defensive:) — режем.
  const colon = text.match(/^\s*([A-Za-zА-ЯЁ][A-Za-zА-Яа-яЁё]{1,20}):\s+(?=\S)/);
  if (colon && !colon[1].includes(' ')) {
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
