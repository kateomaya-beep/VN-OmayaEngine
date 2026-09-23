import type { Project, RuntimeState, LlmMessage, PhoneMessage, PhoneChat, PhoneContact } from '../shared/types';
import { getAssetBlob } from '../storage/db';
import { blobToRef } from './imageProvider';
import { PHONE_BALANCE_STAT, contactDisplayName } from '../shared/types';
import { runCompletion } from './providers';
import { getPresetSettings } from './presetSettings';
import { expandMacros } from './macros';
import { formatClock } from './gameMaster';
import { resolvePerson, nameHit } from './characterRegistry';
import { logEvent } from '../shared/logStore';

// Мессенджер телефона (Batch 7 §7.2). Отдельный лёгкий вызов ИИ: персонаж
// отвечает игроку СМС «в характере», не трогая основную сцену/движок. Возвращает
// чистый текст реплики (одно-два коротких сообщения в стиле переписки).

const MAX_HISTORY = 16; // сколько последних реплик переписки давать в контекст

// ---- Защита от повтора уже доставленных сообщений ----------------------------
// Переписка уходит в контекст основной игры (она — часть сюжета), и стоит игроку
// упомянуть её в сцене, как модель присылает те же реплики заново, целым блоком и
// с новым временем. В промпте это запрещено словами, но словами такое не держится.
// Единственная проверка на весь движок: тот же отправитель, тот же текст, в пределах
// последних сорока сообщений чата. Короткие реплики («ок», «ага») не проверяем —
// они повторяются естественно, и глушить их хуже, чем пропустить дубль.
const MIN_DEDUPE_LEN = 12;
const RECENT_MESSAGES = 40;

export function messageKey(t: string): string {
  return t.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function alreadyInChat(
  chat: PhoneChat,
  senderId: string,
  what: { text?: string; photo?: string; from?: 'contact' | 'protagonist' }
): boolean {
  const side = what.from || 'contact';
  const recent = chat.messages
    .slice(-RECENT_MESSAGES)
    .filter((m) => m.from === side && (side === 'protagonist' || (m.senderId || senderId) === senderId));
  if (what.photo?.trim()) {
    const key = messageKey(what.photo);
    if (recent.some((m) => m.photoPrompt && messageKey(m.photoPrompt) === key)) return true;
  }
  const key = messageKey(what.text || '');
  if (key.length < MIN_DEDUPE_LEN) return false;
  return recent.some((m) => messageKey(m.text || '') === key);
}

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
  // Ищем по всем трём привязкам. registryId раньше не проверялся, и контакт,
  // заведённый на человека без анкеты, не находился по id его записи в реестре.
  return (
    list.find((c) => c.id === id) ||
    list.find((c) => c.characterId === id) ||
    list.find((c) => c.registryId === id)
  );
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
  // Все записи об этом человеке разом — тем же опознанием, что и везде.
  const who = resolvePerson(project, state, { id: contact.id, name: contact.name });
  const char = who?.char;
  const cardFilled = !!char && !!(char.card.personality.trim() || char.card.speechStyle.trim() || char.card.backstory.trim());
  if (char && cardFilled) {
    parts.push(characterProfile(project, state, char.id));
  } else {
    parts.push(`You are ${name}, texting ${heroName} in a private messenger chat (not the main story scene).`);
  }
  const reg = who?.entry;
  if (reg) {
    parts.push(`You (registry): ${reg.canonicalName}${reg.aliases.length ? ` (also called: ${reg.aliases.join(', ')})` : ''}. Status: ${reg.status || 'unknown'}.`);
  }
  // Досье Game Master — если оно есть, оно свежее реестра. По точному имени
  // запись, заведённая под прозвищем, не находилась: бот в переписке жил без
  // собственного досье, хотя в панели Game Master оно было.
  const dossier = who?.dossier;
  if (dossier) {
    const bits = [dossier.dossier, dossier.roleToHero && `For ${heroName} you are: ${dossier.roleToHero}`, dossier.personality && `Personality: ${dossier.personality}`, dossier.mood && `Current mood: ${dossier.mood}`]
      .filter(Boolean)
      .join('\n');
    if (bits) parts.push(bits);
  }
  if (contact.note?.trim()) parts.push(`Author's notes about you: ${contact.note.trim()}`);
  if (!cardFilled && !reg && !dossier && !contact.note?.trim()) {
    parts.push(`No character sheet: stay consistent with this chat so far.`);
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
    `You are ${c.name}, texting ${heroName} in a private messenger chat (not the main story scene).`,
    `Personality: ${expandMacros(c.card.personality, ctx)}`,
    `Speech style: ${expandMacros(c.card.speechStyle, ctx)}`,
  ];
  if (c.card.backstory?.trim()) parts.push(`Backstory: ${expandMacros(c.card.backstory, ctx).slice(0, 400)}`);
  parts.push(
    `Feelings toward ${heroName} (-100..100): affection ${rel.affection}, passion ${rel.passion_stat}, friendship ${rel.friendship}, respect ${rel.respect}. Let them shape your tone.`
  );
  return parts.join('\n');
}

function worldContext(project: Project, state: RuntimeState): string {
  const parts: string[] = [];
  const heroName = heroNameOf(project, state);
  const clock = formatClock(state.gm.clock);
  if (clock) parts.push(`In-story time: ${clock}.`);
  // Короткая сводка последних событий, чтобы бот «был в курсе».
  // Бот видел только 3 последних события — то есть жил в другом мире, чем
  // рассказчик: тот знает журнал эпизодов и снапшот, а бот не знал ничего дальше
  // вчерашнего дня. Одна история — один набор фактов, просто короче.
  const milestones = state.gm.events.filter((e) => e.level === 'key' || e.level === 'important').slice(-4);
  const recent = state.gm.events.filter((e) => e.level !== 'key' && e.level !== 'important').slice(-3);
  const events = [...milestones, ...recent].map((e) => `${e.date ? `[${e.date}] ` : ''}${e.summary}`);
  if (events.length) parts.push(`Known to you both: ${events.join('; ')}.`);
  // Снапшот состояния — коротко: где сейчас сюжет. Без него бот отвечал так, будто
  // истории вокруг переписки не существует.
  const snap = state.memory.storyState?.trim();
  if (snap) {
    // «NOW» — секция нового короткого снапшота, «CURRENT SITUATION» — прежнего.
    const cur = snap.split(/##\s*(?:CURRENT SITUATION|NOW)\b/i)[2];
    if (cur) parts.push(`Story now: ${cur.trim().slice(0, 400)}`);
  }
  const bal = state.statValues[PHONE_BALANCE_STAT];
  if (typeof bal === 'number') parts.push(`(${heroName}'s balance: ${bal} ${project.phone?.currencyName || '$'}; only if money comes up.)`);
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
    `You are texting ${heroName} (the player's character) and nobody else.`,
  ];

  // Кто такой герой: карточка протагониста + досье Game Master о нём.
  const ctx = { project, state };
  const about: string[] = [];
  if (hero) {
    if (hero.card.appearance.trim()) about.push(expandMacros(hero.card.appearance, ctx).slice(0, 300));
    if (hero.card.personality.trim()) about.push(expandMacros(hero.card.personality, ctx).slice(0, 300));
  }
  const heroDossier = resolvePerson(project, state, { id: hero?.id, name: heroName })?.dossier;
  if (heroDossier?.dossier?.trim()) about.push(heroDossier.dossier.trim().slice(0, 300));
  if (about.length) lines.push(`${heroName}: ${about.join('. ')}`);

  // Кем герой приходится ИМЕННО ЭТОМУ собеседнику.
  if (contact) {
    const contactName = nameOfContact(project, state, contact);
    const tie: string[] = [];
    const who = resolvePerson(project, state, { id: contact.id, name: contact.name });
    const dossier = who?.dossier;
    if (dossier?.roleToHero?.trim()) tie.push(`for ${heroName} you are: ${dossier.roleToHero.trim()}`);
    // Сетка связей Game Master — по именам, в обе стороны. Имя в ребре может
    // оказаться прозвищем («Дэм → Кейт»), поэтому сравниваем со ВСЕМИ именами
    // человека, а не только с тем, как он подписан в телефоне: иначе связь
    // «кто он герою» просто пропадала.
    const isContact = (n?: string) =>
      !!n && (nameHit(n, contactName) || (who?.aliases || []).some((a) => nameHit(a, n)));
    const isHero = (n?: string) => !!n && nameHit(n, heroName);
    for (const edge of state.gm.relations || []) {
      if (!edge.label?.trim()) continue;
      if (isContact(edge.from) && isHero(edge.to)) tie.push(`${contactName} → ${heroName}: ${edge.label.trim()}`);
      else if (isHero(edge.from) && isContact(edge.to)) tie.push(`${heroName} → ${contactName}: ${edge.label.trim()}`);
    }
    if (contact.note?.trim()) tie.push(contact.note.trim().slice(0, 200));
    if (tie.length) lines.push(`Your connection: ${tie.join('; ')}.`);
  }

  lines.push(
    `Never confuse ${heroName} with anyone else from your life (sibling, partner, friend from your backstory): no other name, no someone else's shared history.`
  );
  // Второе лицо. Модель то и дело сбивалась на «он/она» ПРО героя, хотя пишет
  // ЕМУ — в переписке это выглядит так, будто говорят у него за спиной.
  lines.push(
    `Address ${heroName} directly in the second person ("ты"/"вы"/"you"). Never refer to them in the third person or narrate their actions or feelings. Third person only for people outside this chat.`
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

// То, что случилось В ПЕРЕПИСКЕ и должно остаться в истории. Уезжает в ту же
// ленту событий Game Master, что и события сцены: переписка — часть той же
// истории, а не отдельная коробка. Без этого сказанное в чате жило ровно до тех
// пор, пока сообщения не уехали из окна контекста, и потом исчезало насовсем.
export interface ChatEvent {
  summary: string;
  level: 'general' | 'important' | 'key';
}

export interface ChatTurn {
  replies: ChatReply[];
  events: ChatEvent[];
}

// Правило записи события — общее для лички, групп и спонтанных входящих.
function eventRule(narr: string): string {
  return [
    `- STORY RECORD: if this exchange produced something the story must remember (news, an agreed plan or meeting, a confession, a quarrel or reconciliation, a life change: move, illness, pregnancy, job, breakup, death), add ONE line after all messages:`,
    `  [event: one past-tense sentence in ${narr}, saying it happened in the chat | important]`,
    `  "| important" = changes the situation; "| key" = turning point; omit for ordinary things.`,
    `- Usually there is no event line (small talk, jokes, flirting, plans only discussed). Max one, never instead of the messages.`,
  ].join('\n');
}

// Снимает строки-маркеры [event: …] с ответа модели ДО разбора на пузыри:
// событие — не сообщение и в переписке показываться не должно.
export function extractChatEvents(raw: string): { text: string; events: ChatEvent[] } {
  const events: ChatEvent[] = [];
  const kept: string[] = [];
  for (const line of (raw || '').split(/\n/)) {
    const m = line.match(/^\s*(?:[^:\n]{0,40}:\s*)?\[?\s*event\s*:\s*([^\]]+?)\s*\]?\s*$/i);
    if (!m) {
      kept.push(line);
      continue;
    }
    const [summary, lvl] = m[1].split('|').map((x) => x.trim());
    if (!summary) continue;
    events.push({
      summary,
      level: /^key$/i.test(lvl || '') ? 'key' : /^important$/i.test(lvl || '') ? 'important' : 'general',
    });
  }
  // Больше одного события за обмен сообщениями не бывает: модель попросили об
  // одном, а если прислала пачку — это перечисление мелочей, берём главное.
  return { text: kept.join('\n'), events: events.slice(0, 1) };
}

// Правило про фото — общее для лички и групп. Модель сама решает, уместно ли фото.
function photoRule(): string {
  return [
    `- PHOTOS: when natural (where you are, food, outfit, a joke, a selfie), write a line: [photo: short English description]. The message line right before it is the caption; a photo line alone has none.`,
    `- Rarely, only when a real person would. Never describe a photo in words instead of the marker.`,
  ].join('\n');
}

export async function generateChatReplies(
  project: Project,
  state: RuntimeState,
  chat: PhoneChat,
  opts?: { spontaneous?: boolean; signal?: AbortSignal }
): Promise<ChatTurn> {
  if (chat.kind === 'group') return generateGroupReplies(project, state, chat, opts);
  const peerId = chat.participantIds[0];
  const contact = findContact(state, peerId);
  if (!contact) return { replies: [], events: [] };
  const out = opts?.spontaneous
    ? await generateIncomingSms(project, state, peerId, chat.messages, opts?.signal)
    : await generatePhoneReply(project, state, peerId, chat.messages, opts?.signal);
  return {
    replies: attachPhotos(out.texts.map((t) => ({ senderId: peerId, text: t }))),
    events: out.events,
  };
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
): Promise<ChatTurn> {
  const ps = getPresetSettings();
  const narr = ps.narrativeLanguage === 'en' ? 'English' : 'Russian (русский)';
  const members = chat.participantIds
    .map((id) => findContact(state, id))
    .filter((c): c is PhoneContact => !!c && !c.hidden);
  if (!members.length) return { replies: [], events: [] };
  const heroName = heroNameOf(project, state);
  const roster = members
    .map((c) => {
      const nm = nameOfContact(project, state, c);
      const talk = typeof c.chattiness === 'number' ? c.chattiness : 50;
      return `### ${nm} (chattiness ${talk}/100)\n${contactProfile(project, state, c)}`;
    })
    .join('\n\n');

  const system = [
    `You run a messenger GROUP CHAT. You play every participant except ${heroName} (the player); never write for ${heroName}.`,
    `Group name: ${chat.title || 'Без названия'}.`,
    chat.topic?.trim() ? `Group topic and manners: ${chat.topic.trim()}` : '',
    `Liveliness: ${typeof chat.groupActivity === 'number' ? chat.groupActivity : 50}/100 (higher = more and more frequent messages).`,
    ``,
    `PARTICIPANTS:`,
    roster,
    ``,
    heroBlock(project, state),
    ``,
    worldContext(project, state),
    ``,
    `RULES:`,
    `- Choose who speaks by context and chattiness: talkative people often, quiet ones when addressed or when it matters. Someone addressed by name almost always answers.`,
    `- Not everyone answers; sometimes only one person.`,
    `- Each line = one message bubble, starting with the sender's name and a colon, e.g. "${nameOfContact(project, state, members[0])}: текст". No other prefixes.`,
    `- Real texting in ${narr}: short lines, bursts, people react to each other, not only to ${heroName}.`,
    `- Speaking to ${heroName}: second person ("ты"/"вы"/"you").`,
    photoRule().replace('[photo:', '[photo:'),
    `- Photo line: "Name: [photo: English description]".`,
    eventRule(narr),
    `- Forbidden: narration, asterisk actions, tone labels, quotes around a whole message, JSON, lines for ${heroName}.`,
    opts?.spontaneous
      ? `- Nobody wrote just now: start a conversation that fits the story moment (news, joke, question, photo). 1–4 messages.`
      : `- Reply to the latest messages. 1–5 messages.`,
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
  const { text, events } = extractChatEvents(raw);
  return { replies: parseGroupReplies(text, project, state, members, heroName), events };
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
): Promise<{ texts: string[]; events: ChatEvent[] }> {
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
    `TEXTING RULES (a plain text chat, not story narration):`,
    `- Reply as ${charName} types in a messenger: short, natural, in character. React to ${heroNameOf(project, state)}'s last message.`,
    photoRule(),
    eventRule(narr),
    `- One message or a burst of up to 4 short ones; each message on its own line (a line = a bubble).`,
    `- Write in ${narr}. Texting culture where it fits the character: casual tone, abbreviations, emoji, Russian smiley parentheses ) )) ))). A formal or cold character texts formally.`,
    `- Output only the literal words ${charName} types.`,
    `- Forbidden: tone or emotion labels ("(Playful):", "[teasing]", "Amused:"), asterisk actions, narration, stage directions, name prefixes, quotes around the whole message, JSON, commentary. ")))" smileys are fine; "(playful)" labels are not.`,
    `- Short texting lines, not paragraphs. Never stop mid-sentence.`,
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
  const { text, events } = extractChatEvents(raw);
  return { texts: splitReplies(text, charName), events };
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
    system: `${system}\n\nReply with the message text directly; no thinking out loud, never empty.`,
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
): Promise<{ texts: string[]; events: ChatEvent[] }> {
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
    `TASK: ${charName} texts ${heroNameOf(project, state)} first, unprompted.`,
    `- A natural reason that fits the story moment and your relationship (checking in, question, complaint, teasing, news, request, missing them).`,
    `- ${narr}, texting style, in character. 1–2 messages, each on its own line.`,
    photoRule(),
    eventRule(narr),
    `- Output only the literal words ${charName} types: no tone labels, asterisk actions, narration, name prefix or JSON.`,
    conversation.length ? `- Continue from the existing chat; do not repeat it.` : `- This is the first message in this chat.`,
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
  const { text, events } = extractChatEvents(raw);
  return { texts: splitReplies(text, charName).slice(0, 2), events };
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
