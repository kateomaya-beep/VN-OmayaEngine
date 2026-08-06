import type { Project, RuntimeState, LlmMessage, PhoneMessage, PhoneChat, PhoneContact } from '../shared/types';
import { getAssetBlob } from '../storage/db';
import { blobToRef } from './imageProvider';
import { PHONE_BALANCE_STAT, contactDisplayName } from '../shared/types';
import { runCompletion } from './providers';
import { getPresetSettings } from './presetSettings';
import { expandMacros } from './macros';
import { formatClock } from './gameMaster';
import { logEvent } from '../shared/logStore';

// Мессенджер телефона (Batch 7 §7.2). Отдельный лёгкий вызов ИИ: персонаж
// отвечает игроку СМС «в характере», не трогая основную сцену/движок. Возвращает
// чистый текст реплики (одно-два коротких сообщения в стиле переписки).

const MAX_HISTORY = 16; // сколько последних реплик переписки давать в контекст

// ---- Контакты (Телефон 2.0) --------------------------------------------------
// Контакт больше не обязан быть персонажем проекта: он может ссылаться на запись
// реестра Game Master («тот, кого задетектил ГМ») или существовать сам по себе
// (просто имя). Все запросы к ИИ идут ЧЕРЕЗ контакт, а профиль собирается из того
// источника, который у него есть.

export function nameOfContact(project: Project, state: RuntimeState, contact: PhoneContact): string {
  return contactDisplayName(contact, {
    characterName: (id) => project.characters.find((c) => c.id === id)?.name,
    registryName: (id) => state.gm.registry?.find((r) => r.id === id)?.canonicalName,
  });
}

// Имя героя для промптов мессенджера. Безымянный «the hero» рядом с названным
// собеседником — второй референт, на который модель и соскакивала.
export function heroNameOf(project: Project, state: RuntimeState): string {
  return (
    state.protagonistName?.trim() ||
    project.characters.find((c) => c.role === 'protagonist')?.name ||
    'the hero'
  );
}

export function findContact(state: RuntimeState, id: string): PhoneContact | undefined {
  const list = state.phone?.contacts || [];
  return list.find((c) => c.id === id) || list.find((c) => c.characterId === id);
}

// Профиль контакта для system-промпта. Персонаж проекта → полная карточка;
// запись реестра → досье Game Master; «просто имя» → минимальная инструкция.
function contactProfile(project: Project, state: RuntimeState, contact: PhoneContact): string {
  const name = nameOfContact(project, state, contact);
  const parts: string[] = [];
  // Карточка персонажа — лучший источник; но она бывает пустой (например у
  // контакта, заведённого сканированием), поэтому это не «либо-либо»: досье,
  // реестр и авторская заметка ДОПОЛНЯЮТ карточку, а не заменяются ею.
  const heroName = heroNameOf(project, state);
  const char = contact.characterId ? project.characters.find((c) => c.id === contact.characterId) : undefined;
  const cardFilled = !!char && !!(char.card.personality.trim() || char.card.speechStyle.trim() || char.card.backstory.trim());
  if (char && cardFilled) {
    parts.push(characterProfile(project, state, char.id));
  } else {
    parts.push(`You ARE ${name}. You are texting ${heroName} from your phone — this is a private messenger chat, NOT the main story scene.`);
  }
  const reg = contact.registryId ? state.gm.registry?.find((r) => r.id === contact.registryId) : undefined;
  if (reg) {
    parts.push(`Who you are (from the story's character registry): ${reg.canonicalName}${reg.aliases.length ? ` (also called: ${reg.aliases.join(', ')})` : ''}. Current status: ${reg.status || 'unknown'}.`);
  }
  // Досье Game Master по имени — если оно есть, оно свежее реестра.
  const dossier = state.gm.characters.find(
    (c) => (contact.characterId && c.charId === contact.characterId) || c.name.toLowerCase() === name.toLowerCase()
  );
  if (dossier) {
    const bits = [dossier.dossier, dossier.roleToHero && `For ${heroName} you are: ${dossier.roleToHero}`, dossier.personality && `Personality: ${dossier.personality}`, dossier.mood && `Current mood: ${dossier.mood}`]
      .filter(Boolean)
      .join('\n');
    if (bits) parts.push(bits);
  }
  if (contact.note?.trim()) parts.push(`The author's notes about you: ${contact.note.trim()}`);
  if (!cardFilled && !reg && !dossier && !contact.note?.trim()) {
    parts.push(`You do not have a full character sheet — stay consistent with how this chat went so far.`);
  }
  return parts.join('\n');
}

function characterProfile(project: Project, state: RuntimeState, characterId: string): string {
  const c = project.characters.find((x) => x.id === characterId);
  const heroName = heroNameOf(project, state);
  if (!c) return `You are texting ${heroName}. Stay in character.`;
  const ctx = { project, state };
  const rel = state.relationship[c.id] || c.relationship;
  const parts = [
    `You ARE ${c.name}. You are texting ${heroName} from your phone — this is a private SMS/messenger chat, NOT the main story scene.`,
    `Personality: ${expandMacros(c.card.personality, ctx)}`,
    `Speech style: ${expandMacros(c.card.speechStyle, ctx)}`,
  ];
  if (c.card.backstory?.trim()) parts.push(`Backstory (for consistency): ${expandMacros(c.card.backstory, ctx).slice(0, 400)}`);
  parts.push(
    `Your feelings toward ${heroName} right now (range -100..100): affection ${rel.affection}, passion ${rel.passion_stat}, friendship ${rel.friendship}, respect ${rel.respect}. Let these tint your tone.`
  );
  return parts.join('\n');
}

function worldContext(project: Project, state: RuntimeState): string {
  const parts: string[] = [];
  const heroName = heroNameOf(project, state);
  const clock = formatClock(state.gm.clock);
  if (clock) parts.push(`In-story time: ${clock}.`);
  // Короткая сводка последних событий, чтобы бот «был в курсе».
  const events = state.gm.events.slice(-3).map((e) => e.summary);
  if (events.length) parts.push(`Recent events ${heroName} and you both know: ${events.join('; ')}.`);
  const bal = state.statValues[PHONE_BALANCE_STAT];
  if (typeof bal === 'number') parts.push(`(${heroName}'s wallet balance is ${bal} ${project.phone?.currencyName || '$'} — only relevant if money comes up.)`);
  return parts.join('\n');
}

// КТО НА ТОМ КОНЦЕ. Без этого блока в промпте был безымянный «the hero», и модель
// достраивала собеседника из карточки самого персонажа: сестра парня писала так,
// будто переписывается с братом. Теперь герой назван по имени, описан, и явно
// сказано, кем он приходится ЭТОМУ контакту.
function heroBlock(project: Project, state: RuntimeState, contact?: PhoneContact): string {
  const hero = project.characters.find((c) => c.role === 'protagonist');
  const heroName = heroNameOf(project, state);
  const lines = [
    `WHO YOU ARE TEXTING (this never changes): the person on the other side of this chat is ${heroName} — the player's character — and NOBODY else.`,
  ];

  // Кто такой герой: карточка протагониста + досье Game Master о нём.
  const ctx = { project, state };
  const about: string[] = [];
  if (hero) {
    if (hero.card.appearance.trim()) about.push(expandMacros(hero.card.appearance, ctx).slice(0, 300));
    if (hero.card.personality.trim()) about.push(expandMacros(hero.card.personality, ctx).slice(0, 300));
  }
  const heroDossier = state.gm.characters.find(
    (c) => (hero && c.charId === hero.id) || c.name.toLowerCase() === heroName.toLowerCase()
  );
  if (heroDossier?.dossier?.trim()) about.push(heroDossier.dossier.trim().slice(0, 300));
  if (about.length) lines.push(`Who ${heroName} is: ${about.join('. ')}`);

  // Кем герой приходится ИМЕННО ЭТОМУ собеседнику.
  if (contact) {
    const contactName = nameOfContact(project, state, contact);
    const tie: string[] = [];
    const dossier = state.gm.characters.find(
      (c) => (contact.characterId && c.charId === contact.characterId) || c.name.toLowerCase() === contactName.toLowerCase()
    );
    if (dossier?.roleToHero?.trim()) tie.push(`for ${heroName} you are: ${dossier.roleToHero.trim()}`);
    // Сетка связей Game Master — по именам, в обе стороны.
    for (const edge of state.gm.relations || []) {
      const from = edge.from?.trim().toLowerCase();
      const to = edge.to?.trim().toLowerCase();
      const cn = contactName.toLowerCase();
      const hn = heroName.toLowerCase();
      if (!edge.label?.trim()) continue;
      if (from === cn && to === hn) tie.push(`${contactName} → ${heroName}: ${edge.label.trim()}`);
      else if (from === hn && to === cn) tie.push(`${heroName} → ${contactName}: ${edge.label.trim()}`);
    }
    if (contact.note?.trim()) tie.push(contact.note.trim().slice(0, 200));
    if (tie.length) lines.push(`How ${heroName} and you are connected: ${tie.join('; ')}.`);
  }

  lines.push(
    `Never confuse ${heroName} with anyone else from your life — not a sibling, not a partner, not a friend mentioned in your own backstory. ` +
      `Do not greet them by another name, do not bring up shared history that belongs to someone else, and if you are unsure who they are, treat them as ${heroName} and nobody else.`
  );
  // Второе лицо. Модель то и дело сбивалась на «он/она» ПРО героя, хотя пишет
  // ЕМУ — в переписке это выглядит так, будто говорят у него за спиной.
  lines.push(
    `You are writing TO ${heroName}, so address them DIRECTLY, in the second person — "ты" / "вы" / "you", by name if it fits. ` +
      `NEVER speak about ${heroName} in the third person ("он", "она", "${heroName} сделала…") and never narrate their actions or feelings: ` +
      `you are one side of a real text conversation, not a storyteller. Third person is only for people who are NOT in this chat.`
  );
  return lines.join('\n');
}

// Ответ в чате (личном или групповом). Возвращает список «пузырей»: кто написал,
// что написал и (опционально) какое фото приложил.
export interface ChatReply {
  senderId: string;
  text: string;
  photoPrompt?: string;
}

// Правило про фото — общее для лички и групп. Модель сама решает, уместно ли фото.
function photoRule(): string {
  return [
    `- PHOTOS: you may send a photo when it is natural (showing where you are, what you're eating/wearing/doing, a joke picture, a selfie). To do it, write a line exactly like this: [photo: short description of the picture IN ENGLISH]. The message line right BEFORE it becomes the caption of that photo (write the caption line first, then the photo line). A photo line on its own = a photo with no caption.`,
    `- Do not send photos often — only when a real person would. Never describe the photo in words instead of the marker.`,
  ].join('\n');
}

export async function generateChatReplies(
  project: Project,
  state: RuntimeState,
  chat: PhoneChat,
  opts?: { spontaneous?: boolean; signal?: AbortSignal }
): Promise<ChatReply[]> {
  if (chat.kind === 'group') return generateGroupReplies(project, state, chat, opts);
  const peerId = chat.participantIds[0];
  const contact = findContact(state, peerId);
  if (!contact) return [];
  const texts = opts?.spontaneous
    ? await generateIncomingSms(project, state, peerId, chat.messages, opts?.signal)
    : await generatePhoneReply(project, state, peerId, chat.messages, opts?.signal);
  return attachPhotos(texts.map((t) => ({ senderId: peerId, text: t })));
}

// Превращает «сырые» пузыри в итоговые, вытаскивая маркеры [photo: …]. Подписью
// к фото становится предыдущее сообщение того же отправителя — так и просили
// модель писать («сначала подпись, потом строка с фото»).
function attachPhotos(items: { senderId: string; text: string }[]): ChatReply[] {
  const out: ChatReply[] = [];
  for (const it of items) {
    const m = it.text.match(/^\s*\[?\s*photo\s*:\s*([^\]]+?)\s*\]?\s*$/i);
    if (m) {
      const prompt = m[1].trim();
      if (!prompt) continue;
      const prev = out[out.length - 1];
      if (prev && prev.senderId === it.senderId && !prev.photoPrompt) prev.photoPrompt = prompt;
      else out.push({ senderId: it.senderId, text: '', photoPrompt: prompt });
      continue;
    }
    out.push({ senderId: it.senderId, text: it.text });
  }
  return out.filter((r) => r.text.trim() || r.photoPrompt);
}

// Групповой чат: ОДИН запрос на всех участников. Модель сама решает, кто и сколько
// раз отвечает — по контексту и «болтливости» контакта (решение пользователя).
async function generateGroupReplies(
  project: Project,
  state: RuntimeState,
  chat: PhoneChat,
  opts?: { spontaneous?: boolean; signal?: AbortSignal }
): Promise<ChatReply[]> {
  const ps = getPresetSettings();
  const narr = ps.narrativeLanguage === 'en' ? 'English' : 'Russian (русский)';
  const members = chat.participantIds
    .map((id) => findContact(state, id))
    .filter((c): c is PhoneContact => !!c && !c.hidden);
  if (!members.length) return [];
  const heroName = heroNameOf(project, state);
  const roster = members
    .map((c) => {
      const nm = nameOfContact(project, state, c);
      const talk = typeof c.chattiness === 'number' ? c.chattiness : 50;
      return `### ${nm} (chattiness ${talk}/100)\n${contactProfile(project, state, c)}`;
    })
    .join('\n\n');

  const system = [
    `You are running a GROUP CHAT in a messenger app. You play EVERY participant EXCEPT ${heroName} — ${heroName} is the human player, and you NEVER write a line for them.`,
    `Group name: ${chat.title || 'Без названия'}.`,
    chat.topic?.trim() ? `What this group is about / how people behave here: ${chat.topic.trim()}` : '',
    `Group liveliness: ${typeof chat.groupActivity === 'number' ? chat.groupActivity : 50}/100 — higher means people chime in more and more often.`,
    ``,
    `PARTICIPANTS (each with their own personality and chattiness):`,
    roster,
    ``,
    heroBlock(project, state),
    ``,
    worldContext(project, state),
    ``,
    `HOW TO ANSWER:`,
    `- YOU decide who speaks up, based on the context of the conversation and each person's chattiness: a talkative person jumps in often, a quiet one only when addressed or when it really matters. Someone directly addressed by name almost always answers.`,
    `- Not everyone has to answer. Sometimes only one person replies. Never make all participants answer every time just because they are in the group.`,
    `- Format: EVERY line is one message bubble and MUST start with the sender's name and a colon, e.g. "${nameOfContact(project, state, members[0])}: текст". No other prefixes.`,
    `- Real texting style, in ${narr}: short lines, several in a row are fine, people talk over each other, react to each other — not only to ${heroName}.`,
    `- When someone speaks TO ${heroName}, they address them in the second person ("ты"/"вы"/"you"), like in a real group chat. Third person is only for people who are not in this chat.`,
    photoRule().replace('[photo:', '[photo:'),
    `- For a photo the line is "Name: [photo: english description]" — the sender's name still comes first.`,
    `- FORBIDDEN: narration, asterisk actions (*smiles*), tone labels, quotes around a whole message, JSON, writing for ${heroName}.`,
    opts?.spontaneous
      ? `- NOBODY wrote just now. Start a conversation out of the blue: someone brings up news, a joke, a question, a photo — something that fits the story moment. 1-4 messages total.`
      : `- Reply to what was just written in the chat. 1-5 messages total.`,
  ]
    .filter(Boolean)
    .join('\n');

  const history: LlmMessage[] = chat.messages.slice(-MAX_HISTORY).map((m) => {
    if (m.from === 'protagonist') {
      return { role: 'user' as const, content: `${heroName}: ${m.text || '[photo]'}` };
    }
    const c = m.senderId ? findContact(state, m.senderId) : undefined;
    const nm = c ? nameOfContact(project, state, c) : 'Кто-то';
    return { role: 'assistant' as const, content: `${nm}: ${m.text || '[photo]'}` };
  });
  history.push({
    role: 'user',
    content: opts?.spontaneous ? '(write the new messages in the group now)' : '(write the replies now)',
  });

  const raw = await completeWithRetry(system, normalizeChatHistory(history), ps.temperature ?? 0.9, opts?.signal);
  return parseGroupReplies(raw, project, state, members, heroName);
}

// Разбор ответа группы: строка «Имя: текст» → пузырь от этого участника.
export function parseGroupReplies(
  raw: string,
  project: Project,
  state: RuntimeState,
  members: PhoneContact[],
  heroName?: string
): ChatReply[] {
  const byName = new Map<string, PhoneContact>();
  for (const c of members) {
    byName.set(nameOfContact(project, state, c).toLowerCase(), c);
    if (c.name) byName.set(c.name.toLowerCase(), c);
    const reg = c.registryId ? state.gm.registry?.find((r) => r.id === c.registryId) : undefined;
    for (const al of reg?.aliases || []) byName.set(al.toLowerCase(), c);
  }
  const items: { senderId: string; text: string }[] = [];
  let current: PhoneContact | undefined;
  for (const rawLine of (raw || '').split(/\n+/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = line.match(/^([^:\n]{1,40}):\s*(.*)$/);
    let text = line;
    if (m) {
      const label = m[1].trim().toLowerCase();
      // Страховка: строку, подписанную именем ГЕРОЯ, выбрасываем — за игрока
      // модель писать не должна, а иначе такая реплика доставалась бы
      // случайному участнику и он «говорил голосом героя».
      if (heroName && label === heroName.trim().toLowerCase()) {
        current = undefined;
        continue;
      }
      const who = byName.get(label);
      if (who) {
        current = who;
        text = m[2].trim();
      }
    }
    // Имени нет и ещё никто не «взял слово» — отдаём самому болтливому участнику,
    // иначе реплика просто потерялась бы.
    if (!current) {
      current = [...members].sort((a, b) => (b.chattiness ?? 50) - (a.chattiness ?? 50))[0];
    }
    if (!text) continue;
    const cleaned = cleanReply(text, nameOfContact(project, state, current));
    if (!cleaned || cleaned === '…') continue;
    items.push({ senderId: current.id, text: cleaned });
  }
  return attachPhotos(items).slice(0, 6);
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

  const contact = findContact(state, characterId);
  const charName = contact
    ? nameOfContact(project, state, contact)
    : project.characters.find((c) => c.id === characterId)?.name || 'the character';
  const system = [
    contact ? contactProfile(project, state, contact) : characterProfile(project, state, characterId),
    heroBlock(project, state, contact),
    worldContext(project, state),
    `TEXTING RULES (this is a plain text-message chat, NOT the visual-novel narration engine):`,
    `- Reply as ${charName} would type in a messenger: short, natural, in-character. React to ${heroNameOf(project, state)}'s last message.`,
    photoRule(),
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
      content: m.text || (m.attachedAssetId ? '[they sent you a photo]' : '…'),
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
      content: `(Earlier you texted first: ${leading.join(' / ')})`,
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
  const contact = findContact(state, characterId);
  const charName = contact
    ? nameOfContact(project, state, contact)
    : project.characters.find((c) => c.id === characterId)?.name || 'the character';

  const system = [
    contact ? contactProfile(project, state, contact) : characterProfile(project, state, characterId),
    heroBlock(project, state, contact),
    worldContext(project, state),
    `TASK: ${charName} texts ${heroNameOf(project, state)} FIRST, out of the blue — they did not write to you just now.`,
    `- Pick a natural reason to reach out that fits the current story moment and your relationship: checking in, a question, a complaint, teasing, news, a request, missing them.`,
    `- Write in ${narr}, in real texting style: short, casual, in character. 1-2 messages, EACH ON ITS OWN LINE.`,
    photoRule(),
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
