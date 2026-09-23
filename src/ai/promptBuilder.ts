import type { NarrativeMode, Project, RuntimeState, LlmMessage, MemoryBookEntry } from '../shared/types';
import { AUDIO_MOODS, DEFAULT_TURN_LENGTH, DEFAULT_THINKING_PLAN, DEFAULT_RP_THINKING_PLAN, DEFAULT_BAN_WORDS, PHONE_BALANCE_STAT, normalizeNarrativeMode } from '../shared/types';
import { FORMAT_REMINDER } from './directorPrompt';
import { type DynamicSource } from './promptPreset';
import { RP_STATE_OPEN, RP_STATE_CLOSE, RP_STATE_BLOCK_KEY } from './rpPreset';
import { stripStateBlock } from './rpResponse';
import { applyRegexRules } from './regexRules';
import { getPresetSettings, presetForMode } from './presetSettings';
import { modelAlwaysThinks } from './providers';
import { DEEPSEEK_THINKING_PLAN } from './deepseekPreset';
import { matchLorebook } from './lorebookEngine';
import { logEvent } from '../shared/logStore';
import { getGlobalNotes } from '../shared/globalNotes';
import { characterOutfits, defaultOutfitTag, hasExtraOutfits } from '../shared/outfits';
import { extractJson } from './responseParser';
import { formatClock } from './gameMaster';
import { parseDate, diffDays } from '../shared/gameDate';
import { expandMacros, type MacroContext } from './macros';
import { pastRecall } from './pastRecall';
import { chaptersOf, isLiveChapter, pickMemorybook, type MemorybookPick } from './chapters';
import { normName, resolvePerson, type Person } from './characterRegistry';
import { estimateTokens } from '../shared/utils';

// Builds the full request as a system string (layered core → style → jailbreak →
// dynamic context) plus the live-window history and the player's move.

// Размер НЕИЗМЕНЯЕМОЙ части последнего запроса (системный промпт + блоки пресета +
// ход игрока). Нужен свёртке памяти: она решает, сколько истории может жить
// дословно, и без этого числа считала по грубой доле бюджета — то отдавая истории
// меньше, чем есть свободного места, то больше, чем реально влезает.
let lastFixed = 0;
export function lastFixedContextTokens(): number {
  return lastFixed;
}

// Сжимает сырой JSON-ход ассистента до чистой прозы (что видел игрок): нарратив/
// мысли как есть, реплики как «Имя: текст». Возвращает null при неразборе — тогда
// вызывающий оставит сырой контент. Снимает дублирование JSON-обвязки в контексте.
export function condenseAssistantTurn(raw: string, project: Project, state: RuntimeState): string | null {
  const js = extractJson(raw);
  if (!js) return null;
  let obj: any;
  try {
    obj = JSON.parse(js);
  } catch {
    return null;
  }
  if (!obj || !Array.isArray(obj.beats)) return null;
  const nameOf = (b: any): string => {
    if (b.characterId) {
      const c = project.characters.find((x) => x.id === b.characterId);
      if (c) return c.role === 'protagonist' ? state.protagonistName || c.name : c.name;
    }
    return typeof b.name === 'string' ? b.name : '';
  };
  // Только то, что герой реально видел на экране. У СМС-битов тоже есть text, и
  // раньше он попадал сюда голой строкой — без отправителя и без пометки, что это
  // переписка. Получалась вторая копия сообщения в контексте (первая — в блоке
  // ТЕЛЕФОН, с именами и временем), и модель принимала её за реплику сцены.
  const SHOWN = new Set(['narration', 'dialogue', 'thought']);
  const lines = obj.beats
    .map((b: any) => {
      const text = typeof b?.text === 'string' ? b.text : '';
      if (!text || !SHOWN.has(b?.type)) return '';
      if (b.type === 'dialogue') {
        const n = nameOf(b);
        return n ? `${n}: ${text}` : text;
      }
      return text; // narration / thought
    })
    .filter(Boolean);
  return lines.length ? lines.join('\n') : null;
}

function assetManifest(project: Project): string {
  const line = (a: { id: string; name: string; tags?: string[] }) =>
    `  - ${a.id} "${a.name}" [${(a.tags || []).join(', ')}]`;
  const sections: string[] = [];
  const bg = project.assets.filter((a) => a.type === 'background');
  const cg = project.assets.filter((a) => a.type === 'cg');
  const sfx = project.assets.filter((a) => a.type === 'sfx');
  if (bg.length) sections.push(`Backgrounds (pick backgroundId by tags):\n${bg.map(line).join('\n')}`);
  if (cg.length) sections.push(`CG (cutscenes):\n${cg.map(line).join('\n')}`);
  if (sfx.length) sections.push(`SFX (sfxId):\n${sfx.map(line).join('\n')}`);

  // Аудио-настроения: базовые + кастомные проекта (см. CR v2 §N.2), помечая
  // какие реально доступны (есть трек).
  const availableMoods = new Set<string>();
  for (const a of project.assets) if (a.type === 'music' && a.audioMood) availableMoods.add(a.audioMood);
  const allMoods = [...AUDIO_MOODS, ...project.audioMoods];
  const moodLine = allMoods
    .map((m) => `${m}${availableMoods.has(m) ? '' : ' (no track — do not pick)'}`)
    .join(', ');
  sections.push(`Audio moods (musicMood): ${moodLine}`);

  return sections.join('\n') || '  (no assets)';
}

// ЕДИНАЯ КАРТОТЕКА. Раньше один и тот же человек описывался в промпте ЧЕТЫРЕЖДЫ:
// карточка проекта, строка «на сцене», досье Game Master и запись реестра. Четыре
// независимо ведущихся источника об одном персонаже — и любой из них мог разойтись
// с остальными: карточка говорит одно, досье (записанное сто ходов назад) другое,
// реестр третье. Отсюда «алло, дочка уже есть, почему она снова беременна».
// Теперь источник один: на каждого человека — один абзац, где идентичность, карточка
// и текущее состояние собраны вместе, а у состояния стоит отметка свежести.
// Присутствие человека в телефоне — часть его записи в картотеке, а не отдельный
// список. Так «кому можно написать» не расходится с «кто вообще есть».
// Контакт берём из УЖЕ разрешённого человека — по любому его id. Раньше здесь
// проверялись только id контакта и characterId, и человек, заведённый в телефон
// через запись реестра (у кого нет анкеты: мама, сестра парня, коллега), в
// ростере оказывался «не в телефоне»: рассказчик не знал, что ему можно писать.
function phoneNote(state: RuntimeState, person: Person | null): string {
  const ph = state.phone;
  const contact = person?.contact;
  if (!ph || !contact) return '';
  const groups = ph.chats
    .filter((ch) => ch.kind === 'group' && !ch.archived && ch.participantIds.includes(contact.id))
    .map((ch) => `"${ch.title || 'группа'}"`);
  const talk = typeof contact.chattiness === 'number' ? `, chattiness ${contact.chattiness}/100` : '';
  // Хвост «reachable via sms_incoming / sms_photo» раньше повторялся на КАЖДОМ
  // человеке — на большой картотеке это десятки токенов ни за что. Правило
  // сказано один раз в конце раздела.
  return `Phone: contact id ${contact.id}${talk}${groups.length ? `; groups: ${groups.join(', ')}` : ''}`;
}

// КТО В ФОКУСЕ — то есть чья анкета уходит ЦЕЛИКОМ (внешность, предыстория,
// манера речи, арка), а не одной строкой характера, и чьи образцы речи попадают в
// хвост запроса. Ответ общий на оба вопроса: показывать голос персонажа, анкету
// которого мы не отдали, бессмысленно, и наоборот.
//
// В новелле фокус — те, кто на сцене: движок знает их точно, по битам с
// characterId, которыми ставятся спрайты. В РП таких бит НЕТ ВООБЩЕ: ход приходит
// одной narration-битой без говорящего, onScreen остаётся пустым навсегда, и в
// фокусе оказывался один лишь герой. Всем остальным доставалось 110 символов
// характера и ни слова предыстории — анкета до модели просто не доезжала.
//
// На выдуманном персонаже это выглядит как «бледноватый характер» и почти не
// ловится. На каноничном — как прямое враньё: своей предыстории модель не
// получает, зато первоисточник помнит и пишет его уверенно.
//
// Поэтому в РП фокус считается по тексту: герой, все упомянутые в свежих ходах,
// затем остальные по значимости роли — до RP_FULL_CARDS. Предел щедрый намеренно:
// типичный ролеплей ведут с двумя-пятью персонажами, и там уходят все анкеты.
const RP_FULL_CARDS = 8;

export function focusCharacters(
  project: Project,
  state: RuntimeState,
  onScreenIds: string[],
  mode: NarrativeMode,
  recentText: string
): Project['characters'] {
  if (mode !== 'rp') {
    const present = project.characters.filter((c) => onScreenIds.includes(c.id));
    const hero = project.characters.find((c) => c.role === 'protagonist' && !present.includes(c));
    return hero ? [hero, ...present] : present;
  }
  const reg = state.gm.registry || [];
  const hay = ` ${normName(recentText)} `;
  const mentioned = (c: Project['characters'][number]) => {
    const e = reg.find((r) => r.id === c.id || r.sheetId === c.id);
    return [c.name, ...(e?.aliases || [])]
      .filter((n) => n && n.trim().length > 2)
      .some((n) => hay.includes(normName(n)));
  };
  const rank = (c: Project['characters'][number]) => {
    if (c.role === 'protagonist') return 0;
    if (mentioned(c)) return 1;
    if (c.role === 'love_interest') return 2;
    if (c.role === 'important_character') return 3;
    return 4;
  };
  return [...project.characters].sort((a, b) => rank(a) - rank(b)).slice(0, RP_FULL_CARDS);
}

// ОБРАЗЦЫ РЕЧИ персонажей в фокусе. Отдельный блок пресета (dynamic: 'voice'),
// а не вставка движка: место в промпте у него решающее, и решать его должен автор.
//
// По умолчанию блок стоит НИЖЕ истории — вплотную к ходу. Разница не в стиле: в
// анкете, за сотни строк до хода, образцы читаются как ещё одно описание («говорит
// резко» модель усваивает, звучание — нет), а положенные последними дают
// услышать голос, и следующая реплика подстраивается под него. Так их подаёт и
// Таверна — рядом с перепиской, а не внутри описания.
function voiceSamplesText(
  project: Project,
  state: RuntimeState,
  onScreenIds: string[],
  mode: NarrativeMode,
  recentText: string,
  ctx: MacroContext
): string {
  const samples = focusCharacters(project, state, onScreenIds, mode, recentText)
    .map((c) => ({ name: c.name, text: expandMacros(c.card.speechExamples || '', ctx).trim() }))
    .filter((x) => x.text);
  if (!samples.length) return '';
  return (
    'VOICE SAMPLES (from the character sheets). Match vocabulary, rhythm, sentence length and manner. ' +
    'Samples show a voice only: never quote them, and their content did not happen in this story.\n\n' +
    samples.map((x) => `--- ${x.name} ---\n${x.text}`).join('\n\n')
  );
}

function whoIsWhoBlock(
  project: Project,
  state: RuntimeState,
  onScreenIds: string[],
  ctx: MacroContext,
  // В текстовом РП спрайтов нет — перечислять доступные эмоции незачем: это лишние
  // токены и прямое приглашение модели писать служебные пометки в прозе.
  mode: NarrativeMode = 'vn',
  // Свежий кусок истории + ход игрока — по нему в РП определяем, кто сейчас в игре.
  recentText = ''
): string {
  const turnNow = state.turnCount;
  const roleLabel: Record<string, string> = {
    protagonist: "PLAYER'S HERO",
    love_interest: 'love interest',
    important_character: 'important character',
    npc: 'minor',
  };
  const reg = state.gm.registry || [];
  const activeReg = reg.filter((e) => !reg.some((x) => x.merged?.includes(e.id)));
  // ОДНО опознание на человека — и досье, и контакт телефона берутся из него.
  // По точному имени в нижнем регистре запись досье, заведённая под прозвищем
  // («Дэм» при карточке «Дэмиан»), к персонажу не прилипала: в ростере он
  // оставался без досье, а сама запись висела сиротой — видна в панели Game
  // Master и невидима для модели. Резолв не из дешёвых, поэтому строго один раз
  // на запись: ростер собирается КАЖДЫЙ ход, а индекс личностей — раз на ход.
  const whoIs = (id: string | undefined, name: string) => resolvePerson(project, state, { id, name });
  const dossierOf = (id: string | undefined, name: string) => whoIs(id, name)?.dossier;
  const onScreenOf = (id: string) => state.onScreen.find((o) => o.characterId === id);
  const rels = state.relationship || {};

  // «Сейчас» одной строкой + отметка возраста. Пустое — не печатаем вовсе.
  const nowLine = (id: string | undefined, name: string, deep = false): string => {
    const who = whoIs(id, name);
    const d = who?.dossier;
    const os = id ? onScreenOf(id) : undefined;
    // ДВА РАЗНЫХ ПО СВЕЖЕСТИ ИСТОЧНИКА, и путать их нельзя. Присутствие на сцене
    // движок знает точно на этот ход. Статус/настроение/место — запись из досье,
    // сделанная когда-то и с тех пор не подтверждённая. Раньше они склеивались в
    // одну строку, и если персонаж стоял на сцене, отметка возраста пропадала —
    // «беременна» столетней давности выглядело как факт этого хода.
    const out: string[] = [];
    if (os) out.push(`Present in the scene right now (emotion: ${os.emotion}${os.outfit ? `, outfit: ${os.outfit}` : ''})`);
    const recordedAt = d?.updatedAtTurn ?? null;
    // Ничего не затухает и не выбрасывается. Персонаж, с которым давно не играли,
    // обязан остаться известным — иначе движок сам создаёт амнезию. Свежесть
    // обеспечивается не забыванием, а тем, что модель переписывает сводку по тем,
    // кто в игре, КАЖДЫЙ ход (см. контракт worldState).
    const recorded = [
      d?.status && `status: ${d.status}`,
      d?.mood && `mood: ${d.mood}`,
      d?.outfit && !os?.outfit && `outfit: ${d.outfit}`,
      d?.location && !os && `at: ${d.location}`,
    ].filter(Boolean);
    if (recorded.length) {
      // Тоже абсолютным номером хода — по той же причине, что и снапшот выше:
      // «N ходов назад» меняется каждый ход и рушит общий префикс запроса.
      const stamp =
        recordedAt === null
          ? ' [age unknown — check against the story]'
          : ` [recorded at turn ${recordedAt}]`;
      out.push(`Last recorded: ${recorded.join('; ')}${stamp}`);
    }
    // ИСТОРИЯ СТАТУСА. Одна строка «status: беременна» не говорит, было это
    // вчера или два года назад и чем кончилось, — и модель на ней залипала.
    // Цепочка «беременна (01/03) → родила (12/12) → в декрете» показывает, что
    // прежний статус УЖЕ ОТМЕНЁН более поздним, и по датам видно, когда.
    const log = (who?.entry?.statusLog || []).filter((x) => x.status?.trim());
    if (log.length > 1) {
      const fmt = (x: { status: string; date?: string }) => `${x.status}${x.date ? ` (${x.date})` : ''}`;
      if (deep) {
        // Человек в кадре — вся цепочка целиком: она читается как биография.
        const shown = log.slice(-4);
        out.push(
          `Status history (oldest → newest; each entry cancels the earlier ones): ${
            log.length > shown.length ? '… → ' : ''
          }${shown.map(fmt).join(' → ')}`
        );
      } else {
        // Остальным — ТОЛЬКО отменённое. Текущий статус уже напечатан строкой
        // выше, и повторять его в хвосте цепочки значило платить за него дважды.
        // Смысл цепочки не в биографии, а в том, чтобы старая запись не
        // выглядела действующей.
        const past = log.slice(0, -1).slice(-2);
        if (past.length) out.push(`No longer true (superseded): ${past.map(fmt).join(', ')}`);
      }
    }
    return out.join('\n');
  };

  const entries: string[] = [];
  const seen = new Set<string>();

  // 1) Персонажи проекта — с карточкой. В фокусе карточка полная (см. focusCharacters).
  const hero = project.characters.find((c) => c.role === 'protagonist' && !onScreenIds.includes(c.id));
  const focus = focusCharacters(project, state, onScreenIds, mode, recentText);

  for (const c of project.characters) {
    seen.add(c.id);
    const inFocus = focus.includes(c);
    const e = activeReg.find((r) => r.id === c.id || r.sheetId === c.id);
    const aka = (e?.aliases || []).filter((a) => normName(a) !== normName(c.name));
    const head = `### ${c.name} — id: ${c.id} | ${roleLabel[c.role] || c.role}${aka.length ? ` | aka: ${aka.join(', ')}` : ''}`;
    const lines = [head];
    if (inFocus) {
      lines.push(`Who they are: ${expandMacros(c.card.personality, ctx)}`);
      if (c.card.appearance.trim()) lines.push(`Appearance: ${expandMacros(c.card.appearance, ctx)}`);
      // Внешность, ЗАПИСАННАЯ по ходу игры (постригся, шрам, поправился), жила
      // только в Game Master и в генераторе картинок: рассказчик её не видел
      // вовсе и продолжал описывать человека по анкете. Печатаем, только если
      // она реально отличается от анкетной — иначе это была бы вторая копия.
      const dNow = dossierOf(c.id, c.name)?.appearance?.trim();
      if (dNow && normName(dNow) !== normName(c.card.appearance)) {
        lines.push(`Appearance now (newer than the sheet): ${dNow}`);
      }
      if (c.card.backstory.trim()) lines.push(`Backstory: ${expandMacros(c.card.backstory, ctx)}`);
      lines.push(`Speech: ${expandMacros(c.card.speechStyle, ctx)}`);
      if (c.card.relationshipArc) lines.push(`Arc: ${expandMacros(c.card.relationshipArc, ctx)}`);
    } else {
      lines.push(`Who they are: ${c.card.personality.slice(0, 110)}`);
    }
    const evo = evolutionLines(state, c.name, c.id, inFocus);
    if (evo) lines.push(evo);
    const d = dossierOf(c.id, c.name);
    if (d?.roleToHero) lines.push(`To the hero: ${d.roleToHero}`);
    // ТЕГИ — то, что помнит о человеке сама игра: что он знает, что обещал, чем
    // обязан. Модель их писала, движок хранил, панель показывала — а ростер НЕТ,
    // и обратно они не возвращались никогда. Тайна, которую герой кому-то
    // доверил, жила ровно до тех пор, пока та сцена не уезжала из контекста.
    if (d?.tags?.length) lines.push(`Known about them (lasting facts): ${d.tags.join('; ')}`);
    const ph = phoneNote(state, whoIs(c.id, c.name));
    if (ph) lines.push(ph);
    const now = nowLine(c.id, c.name, inFocus);
    if (now) lines.push(now);
    if (c.role !== 'protagonist') {
      const r = rels[c.id] || c.relationship;
      lines.push(
        `Feelings toward the hero (statChanges ids, -100..100): ❤️ rel:${c.id}:affection=${r.affection}, 🔥 rel:${c.id}:passion_stat=${r.passion_stat}, 🍀 rel:${c.id}:friendship=${r.friendship}, 🎖 rel:${c.id}:respect=${r.respect}`
      );
    }
    if (inFocus) {
      if (mode !== 'rp') {
        const emotions = Object.keys(c.sprites);
        lines.push(`Emotions available: ${emotions.length ? emotions.join(', ') : '(no sprites — name + text)'}`);
      }
      if (hasExtraOutfits(c)) {
        lines.push(
          `Outfits (pick the tag that fits the scene; default "${defaultOutfitTag(c)}"):\n${characterOutfits(c)
            .map((tag) => {
              if (tag === defaultOutfitTag(c)) return `  - ${tag} (default everyday look)`;
              const desc = c.outfits?.find((o) => o.outfit === tag)?.description?.trim();
              return `  - ${tag}${desc ? ` — use when: ${desc}` : ''}`;
            })
            .join('\n')}`
        );
      }
    }
    entries.push(lines.join('\n'));
  }

  // 2) Люди из реестра/досье без карточки проекта — те, кого завёл сам сюжет.
  for (const e of activeReg) {
    if (seen.has(e.id) || (e.sheetId && seen.has(e.sheetId))) continue;
    seen.add(e.id);
    const aka = e.aliases.filter((a) => normName(a) !== normName(e.canonicalName));
    const lines = [`### ${e.canonicalName} — id: ${e.id} | ${e.role}${aka.length ? ` | aka: ${aka.join(', ')}` : ''}`];
    const d = dossierOf(e.id, e.canonicalName);
    if (d?.dossier) lines.push(`Who they are: ${d.dossier}`);
    const evo = evolutionLines(state, e.canonicalName, e.sheetId, true);
    if (evo) lines.push(evo);
    // Внешность человека без анкеты. Её знал Game Master и знал генератор
    // картинок — а рассказчик нет, и описывал его с нуля каждый раз.
    if (d?.appearance?.trim()) lines.push(`Appearance: ${d.appearance.trim()}`);
    if (d?.roleToHero) lines.push(`To the hero: ${d.roleToHero}`);
    if (d?.tags?.length) lines.push(`Known about them (lasting facts): ${d.tags.join('; ')}`);
    const ph = phoneNote(state, whoIs(e.id, e.canonicalName));
    if (ph) lines.push(ph);
    const now = nowLine(e.id, e.canonicalName) || (e.status ? `Now: status: ${e.status}` : '');
    if (now) lines.push(now);
    entries.push(lines.join('\n'));
  }

  if (!entries.length) return '(no characters yet — introduce them via character_new)';

  return (
    entries.join('\n\n') +
    `\n\nROSTER RULES (this is the only list of people):\n` +
    `- The sheet is the only truth about a person. A name shared with a book, film, anime or game character does not import that canon. Where the sheet is silent, invent to fit this story; never state a fact the sheet does not support.\n` +
    `- Identity is the id, not the name: nicknames vary. Reuse an existing id for anyone already listed under any name or alias.\n` +
    `- "Last recorded" lines carry their age. If recent messages or chapters show something newer (birth, healing, move, death), the story wins: write the current reality and send the correction in worldState.characters.\n` +
    `- "Phone:" means textable: sms_incoming / sms_photo when they write, sms_outgoing when the hero writes — by id.\n` +
    `- New person → {"type":"character_new",...}; known person, new nickname → {"type":"character_alias_add","id":"<id>","alias":"..."}; changed situation → {"type":"character_update","id":"<id>","status":"..."}. Never duplicate a person.`
  );
}

// ЭВОЛЮЦИЯ ПЕРСОНАЖА. Анкета — это человек на старте. История его меняет, и без
// ленты модель каждый ход играла анкету заново, будто ничего не было: после
// признания и предательства он оставался тем же холодным незнакомцем из карточки.
// Анкета остаётся основой (характер, голос, прошлое), а поверх неё — кем он стал.
function evolutionLines(state: RuntimeState, name: string, charId: string | undefined, deep: boolean): string {
  const arc = (state.memory.arcs || []).find(
    (a) => (charId && a.charId === charId) || normName(a.name) === normName(name)
  );
  const stages = arc?.stages.filter((x) => x.now.trim() || x.change.trim()) || [];
  if (!stages.length) return '';
  const last = stages[stages.length - 1];
  if (!deep) return `Evolution: stage «${last.label}» — ${last.now || last.change}`;
  const path = stages.slice(-5).map((x) => x.label).join(' → ');
  const recent = stages
    .slice(-2)
    .map((x) => `turn ${x.turn}: ${x.change}${x.cause ? ` (because: ${x.cause})` : ''}`)
    .join('; ');
  return (
    `WHO THEY HAVE BECOME (play this stage; the sheet stays the base — same core, voice, past): ${last.now || last.change}\n` +
    `Evolution path: ${stages.length > 5 ? '… → ' : ''}${path} (current)\n` +
    `Latest shifts: ${recent}`
  );
}

// Текущие спрайты на сцене с эмоцией и нарядом — чтобы модель вела непрерывность
// (держала эмоцию/наряд между ходами и меняла осознанно, а не заново угадывала).
// Запись со сцены не убирается никогда (её вытесняет только четвёртый говорящий),
// поэтому давность реплики проговариваем вслух: иначе строчка утверждала, что
// человек рядом, хотя герой попрощался с ним десять ходов назад.
function onScreenState(project: Project, state: RuntimeState): string {
  if (!state.onScreen.length) return 'nobody';
  return state.onScreen
    .map((s) => {
      const c = project.characters.find((x) => x.id === s.characterId);
      const name = c?.name || s.characterId;
      const bits = [`emotion: ${s.emotion}`];
      if (s.outfit) bits.push(`outfit: ${s.outfit}`);
      const age = s.atTurn === undefined ? 0 : state.turnCount - s.atTurn;
      const stale = age > 1 ? `; last spoke ${age} turns ago — may have left, the story decides` : '';
      return `${name} (${s.characterId}; ${bits.join(', ')}${stale})`;
    })
    .join('; ');
}

function statsState(project: Project, values: Record<string, number>): string {
  if (!project.stats.length) return '(no stats)';
  return project.stats
    .map((s) => {
      const v = values[s.id] ?? s.initial;
      return `- ${s.id} "${s.name}" = ${v} (${s.min}..${s.max})${
        s.visible ? '' : ' [hidden]'
      }: ${s.description}`;
    })
    .join('\n');
}

// БЮДЖЕТ ПАМЯТИ. Память — единственная часть запроса, которая растёт по ходу
// игры, поэтому у неё жёсткие доли бюджета контекста:
//   блок «Память» (MEMORY_SHARE) — снапшот «где мы сейчас» + оглавление ВСЕХ глав
//     + свежие главы целиком;
//   блок «Меморибук» (MEMORYBOOK_SHARE) — постоянные записи + старые главы и
//     события, чьи ключи всплыли в сцене, + найденное в прошлом.
// Что не влезло, не теряется: у каждой главы остаётся строка в оглавлении, а
// полный текст ждёт своего ключа. Ничего не пережимается повторно — растёт только
// оглавление, по строке на главу (~40 токенов), и даже его самые старые строки
// при нехватке места ужимаются до названий, а не выбрасываются.
const MEMORY_SHARE = 0.3;
const MEMORYBOOK_SHARE = 0.1;
const SNAPSHOT_SHARE = 0.4; // доля блока «Память» под снапшот
const TOC_SHARE = 0.2; // доля блока «Память» под оглавление
const MAX_RECENT_FULL = 6;

export function memoryBudgets(budget: number): { memory: number; memorybook: number } {
  return {
    memory: Math.max(1500, Math.round((budget || 80000) * MEMORY_SHARE)),
    memorybook: Math.max(800, Math.round((budget || 80000) * MEMORYBOOK_SHARE)),
  };
}

const turnsLabel = (e: MemoryBookEntry) =>
  e.fromTurn && e.toTurn ? (e.fromTurn === e.toTurn ? `turn ${e.toTurn}` : `turns ${e.fromTurn}–${e.toTurn}`) : e.turn ? `up to turn ${e.turn}` : '';

function tocLine(e: MemoryBookEntry, n: number, withGist: boolean): string {
  const meta = [turnsLabel(e), e.dates].filter(Boolean).join(', ');
  const gist = withGist ? (e.gist || e.text.split('\n').find((l) => l.trim()) || '').replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  return `Ch.${n} «${e.title}»${meta ? ` (${meta})` : ''}${gist ? ` — ${gist}` : ''}`;
}

function renderEntry(e: MemoryBookEntry, n?: number): string {
  const meta = [turnsLabel(e), e.dates].filter(Boolean).join(' · ');
  const head =
    e.kind === 'chapter'
      ? `[Chapter ${n ?? ''} «${e.title}»${meta ? ` · ${meta}` : ''}]`
      : `[${e.kind === 'fact' ? 'Fact' : 'Event'} «${e.title}»${meta ? ` · ${meta}` : ''}]`;
  return `${head}\n${e.text.trim()}`;
}

// Оглавление под потолок: сначала самые старые строки теряют строку сути, потом
// склеиваются в одну строку одних названий. Главы из оглавления не пропадают.
function fitToc(chapters: MemoryBookEntry[], numbers: Map<string, number>, cap: number): string[] {
  const lines = chapters.map((c) => tocLine(c, numbers.get(c.id) || 0, true));
  let total = lines.reduce((n, l) => n + estimateTokens(l), 0);
  for (let i = 0; i < lines.length - 3 && total > cap; i++) {
    const short = tocLine(chapters[i], numbers.get(chapters[i].id) || 0, false);
    total -= estimateTokens(lines[i]) - estimateTokens(short);
    lines[i] = short;
  }
  if (total <= cap) return lines;
  // Всё ещё много — склеиваем старейшие в одну строку названий.
  let k = 0;
  while (k < lines.length - 3 && total > cap) {
    total -= estimateTokens(lines[k]) - Math.ceil(estimateTokens(chapters[k].title) + 2);
    k++;
  }
  if (!k) return lines;
  const first = numbers.get(chapters[0].id) || 1;
  const last = numbers.get(chapters[k - 1].id) || k;
  const merged = `Ch.${first}–${last}: ${chapters.slice(0, k).map((c) => `«${c.title}»`).join(' · ')}`;
  return [merged, ...lines.slice(k)];
}

interface MemoryPlan {
  memory: string;
  memorybook: string;
}

export interface MemorySelection {
  snapText: string;
  tocText: string;
  tocCount: number;
  recent: MemoryBookEntry[];
  numbers: Map<string, number>;
  pick: MemorybookPick;
  budgets: { memory: number; memorybook: number };
  memoryTokens: number;
}

/**
 * ЧТО ИЗ ПАМЯТИ УЙДЁТ МОДЕЛИ — без запросов и поиска по прошлому. Этим же
 * расчётом пользуется панель меморибука: она показывает ровно то, что уйдёт.
 */
export function selectMemory(project: Project, state: RuntimeState, playerMove: string): MemorySelection {
  const m = state.memory;
  const budgets = memoryBudgets(getPresetSettings().contextBudget || 80000);

  // --- Снапшот «где мы сейчас» ---
  let snapText = '';
  if (m.storyState?.trim()) {
    // ВОЗРАСТ — АБСОЛЮТНЫМ НОМЕРОМ ХОДА: «N ходов назад» менялось бы каждый ход и
    // рушило общий префикс запроса (кэш провайдера). Какой ход сейчас — в конце
    // запроса, в блоке STATE RIGHT NOW; модель вычитает сама.
    const at = m.storyStateAtTurn ?? 0;
    const stamp = at ? `taken at turn ${at}` : 'taken at an unknown point';
    const warn = ' Anything after that turn (recent messages, newer chapters) overrides it. Continue from now, not from here.';
    const snapCap = Math.round(budgets.memory * SNAPSHOT_SHARE);
    let body = m.storyState.trim();
    if (estimateTokens(body) > snapCap) {
      const keep = Math.round(body.length * (snapCap / estimateTokens(body)));
      const cut = body.slice(0, keep);
      const lastSection = cut.lastIndexOf('\n##');
      body = (lastSection > keep * 0.5 ? cut.slice(0, lastSection) : cut) + '\n… (снапшот сокращён под бюджет — пересоберите его в Game Master → Саммари)';
    }
    snapText = `STORY STATE SNAPSHOT (${stamp}): who is who, relationships, open threads.${warn}\n${body}`;
  }

  // --- Главы: оглавление + свежие целиком ---
  // Номера — только у действующих глав: выключенная (например, старая запись,
  // которую заменили главы из архива) не должна рвать нумерацию «Ch.1, Ch.3».
  const all = chaptersOf(m).filter((c) => c.mode !== 'off');
  const numbers = new Map(all.map((c, i) => [c.id, i + 1] as const));
  const chapters = all.filter((c) => !isLiveChapter(c, m) && c.text.trim());
  const recent: MemoryBookEntry[] = [];
  let tocText = '';
  if (chapters.length) {
    const tocLines = fitToc(chapters, numbers, Math.max(300, Math.round(budgets.memory * TOC_SHARE)));
    tocText =
      'CHAPTER INDEX (all chapters, oldest → newest; all of it already happened. Older chapters appear in full in MEMORYBOOK when relevant):\n' +
      tocLines.join('\n');
    let room = budgets.memory - estimateTokens(snapText) - estimateTokens(tocText);
    // Постоянные главы уходят блоком меморибука — здесь их не дублируем.
    for (const c of [...chapters].reverse()) {
      if (recent.length >= MAX_RECENT_FULL) break;
      if (c.mode === 'constant') continue;
      const t = estimateTokens(renderEntry(c, numbers.get(c.id)));
      if (t > room && recent.length) break;
      recent.unshift(c);
      room -= t;
    }
  }

  // --- Меморибук ---
  const depth = Math.max(1, project.memoryConfig.memorybookScanDepth ?? 6);
  const scanText = [
    ...state.history.slice(-depth).map((h) => (h.role === 'assistant' ? stripStateBlock(String(h.content)) : String(h.content))),
    playerMove,
  ].join('\n');
  const pick = pickMemorybook(m, scanText, budgets.memorybook, new Set(recent.map((c) => c.id)));
  const memoryTokens =
    estimateTokens(snapText) +
    estimateTokens(tocText) +
    recent.reduce((n, c) => n + estimateTokens(renderEntry(c, numbers.get(c.id))), 0);
  return { snapText, tocText, tocCount: chapters.length, recent, numbers, pick, budgets, memoryTokens };
}

// ПЛАН ПАМЯТИ считается один раз на запрос: блоки «Память» и «Меморибук» могут
// стоять в пресете в любом порядке, а решать, что куда идёт, надо вместе — иначе
// свежая глава попала бы в запрос дважды.
async function buildMemoryPlan(
  project: Project,
  state: RuntimeState,
  playerMove: string,
  skipVector?: boolean
): Promise<MemoryPlan> {
  const m = state.memory;
  const sel = selectMemory(project, state, playerMove);
  const { numbers, pick } = sel;
  const parts: string[] = [];
  if (sel.tocText) parts.push(sel.tocText);
  if (sel.recent.length) {
    parts.push(
      'RECENT CHAPTERS (oldest → newest; already happened — never contradict or replay):\n' +
        sel.recent.map((c) => renderEntry(c, numbers.get(c.id))).join('\n\n')
    );
  }
  if (sel.snapText) parts.push(sel.snapText);
  if (m.liveSummary.trim()) parts.push(`AUTHOR'S ARC NOTE:\n${m.liveSummary}`);
  const facts = m.facts.filter((f) => f.kind !== 'choice');
  if (facts.length) {
    parts.push(
      `KEY FACTS (canon):\n${facts
        .slice(-40)
        .map((f) => `[turn ${f.turn}] ${f.text}`)
        .join('; ')}`
    );
  }
  const memory = parts.join('\n\n') || '(memory is empty — this is the start of the story)';

  const mb: string[] = [];
  if (pick.constant.length) {
    mb.push(pick.constant.map((e) => renderEntry(e, numbers.get(e.id))).join('\n\n'));
  }
  if (pick.triggered.length) {
    mb.push(pick.triggered.map((t) => renderEntry(t.entry, numbers.get(t.entry.id))).join('\n\n'));
  }
  if (pick.constant.length || pick.triggered.length || pick.skipped.length) {
    logEvent(
      'info',
      'prompt',
      `Меморибук: постоянных ${pick.constant.length}` +
        (pick.triggered.length
          ? `; по ключам: ${pick.triggered.map((t) => `«${t.entry.title}» (${t.keys.join(', ')})`).join('; ')}`
          : '') +
        (pick.skipped.length ? `; сработали, но не влезли в бюджет: ${pick.skipped.length} — остались в оглавлении` : '')
    );
  }
  // Поиск по прошлому: дословные отрывки свёрнутых ходов, похожие на текущую сцену.
  if (!skipVector) {
    const lastStory = [...state.history].reverse().find((h) => h.role === 'assistant');
    const query = `${playerMove}\n${lastStory ? stripStateBlock(String(lastStory.content)).slice(-800) : ''}`;
    // Страховка: поиск по прошлому — дополнение, и держать из-за него ход нельзя.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hits = await Promise.race([
      pastRecall(project, state, query, 3).catch(() => []),
      new Promise<[]>((resolve) => {
        timer = setTimeout(() => {
          logEvent('warn', 'memory', 'Поиск по прошлому не уложился в 6 с — ход идёт без него');
          resolve([]);
        }, 6000);
      }),
    ]);
    clearTimeout(timer);
    if (hits.length) {
      mb.push(
        `EARLIER PASSAGES (verbatim, matched to the current scene; already happened):\n${hits
          .map((h) => `[turn ${h.turn}] ${h.text}`)
          .join('\n\n')}`
      );
    }
  }
  const memorybook = mb.length
    ? '== MEMORYBOOK (recalled past; already happened — keep consistent, never replay) ==\n' +
      mb.join('\n\n')
    : '';
  return { memory, memorybook };
}

// КОРОТКИЕ НАПОМИНАНИЯ «НА ГЛУБИНЕ». Правила поведения лежат в начале системной
// части — на длинной истории это примерно 3% от начала запроса, после них идут
// десятки тысяч токенов сюжета. Модель весит свежее сильнее, и правило, прочитанное
// первым, к сороковому ходу перестаёт работать: отсюда «тумблеры как будто
// игнорируются». Полный текст остаётся наверху (там объяснено ПОЧЕМУ), а сюда, в
// самый конец запроса, идёт одна фраза-напоминание — как инжект на глубину в
// Таверне. Выключил блок в пресете — напоминание тоже исчезает.
// Ключи блоков, чьё включение добавляет короткое напоминание в самый конец запроса
// (после всей истории). Новелла и РП называют одни и те же блоки по-разному, поэтому
// у напоминания два ключа — иначе в РП оно бы просто не срабатывало.
const DEPTH_REMINDERS: { keys: string[]; text: string }[] = [
  {
    keys: ['info_hygiene', 'rp_info_hygiene'],
    text: 'Knowledge: characters know only what they witnessed or were told. Thoughts are not heard. Unsure → they do not know.',
  },
  {
    keys: ['realistic_conduct', 'rp_realistic_conduct'],
    text: 'Realism: nobody owes the hero agreement. If someone would refuse, push back, be busy, hurt or jealous — write that and let it stand this turn. Affection is not compliance.',
  },
  {
    // Только РП: в новелле ход игрока приходит выбором, и разворачивать его — работа
    // модели. Здесь наоборот — это единственное, чего делать нельзя, и правило из
    // начала запроса к сороковому ходу перестаёт держать.
    keys: ['rp_no_impersonation'],
    text: "Do not write the player's words, thoughts, actions or feelings. Stop at their move.",
  },
];

// Компактный дамп состояния Game Master для контекста ИИ (Horae-подобная память):
// часы, досье персонажей тегами, сетка отношений, открытые задачи, последние события.
// Сколько внутриигрового времени прошло с начала истории, словами. Нужно, чтобы
// крупный скачок («три года спустя») оставался ФАКТОМ в каждом запросе: запись о
// нём живёт в ленте событий, а лента показывает только последние 12 — через
// десяток ходов таймскип из контекста исчезал, и ИИ снова вёл историю так, будто
// его не было.
function elapsedPhrase(startDate?: string, nowDate?: string): string {
  const a = startDate ? parseDate(startDate) : null;
  const b = nowDate ? parseDate(nowDate) : null;
  if (!a || !b) return '';
  const days = diffDays(a, b);
  if (days < 2) return '';
  const years = Math.floor(days / 365);
  const months = Math.floor((days % 365) / 30);
  const bits: string[] = [];
  if (years) bits.push(`${years} year(s)`);
  if (months) bits.push(`${months} month(s)`);
  if (!years && !months) bits.push(`${days} day(s)`);
  return bits.join(' ');
}

function gameMasterBlock(state: RuntimeState, turnNow = 0): string {
  const gm = state.gm;
  const parts: string[] = [];
  // Часы сюда больше не дублируются — только протяжённость истории, которую больше
  // взять неоткуда и которая обязана быть видна всегда.
  const elapsed = elapsedPhrase(gm.clock.startDate, gm.clock.date);
  if (elapsed) {
    parts.push(
      `Story began ${gm.clock.startDate}; ${elapsed} of in-story time have passed. Apply it: ages advance, children grow, ` +
        `wounds and pregnancies have resolved, jobs, homes and relationships moved on. Cards describe people at the start.`
    );
  }
  if (gm.relations.length) {
    parts.push(
      `Relationship grid:\n${gm.relations.map((r) => `- ${r.from} → ${r.to}: ${r.label}`).join('\n')}`
    );
  }
  if (gm.locations?.length) {
    parts.push(
      `Known locations:\n${gm.locations
        .map((l) => `- ${l.name}${l.description ? `: ${l.description}` : ''}${l.tags.length ? ` [${l.tags.join(', ')}]` : ''}`)
        .join('\n')}`
    );
  }
  const openTasks = gm.agenda.filter((t) => !t.done);
  if (openTasks.length) {
    parts.push(`Open agenda:\n${openTasks.map((t) => `- ${t.text}`).join('\n')}`);
  }
  // Завершённые арки/задачи — чтобы ИИ НЕ повторял уже пройденное (фикс памяти).
  const doneTasks = gm.agenda.filter((t) => t.done).slice(-12);
  if (doneTasks.length) {
    parts.push(
      `Done (never replay):\n${doneTasks.map((t) => `- ${t.text}`).join('\n')}`
    );
  }
  if (gm.events.length) {
    // Как давно это было — относительным сроком. Без него модель видит только даты
    // и не чувствует дистанции: «вчера» и «два года назад» выглядят одинаково.
    const ago = (date?: string): string => {
      const a = date ? parseDate(date) : null;
      const b = gm.clock.date ? parseDate(gm.clock.date) : null;
      if (!a || !b) return '';
      const d = diffDays(a, b);
      if (d <= 0) return ' (today)';
      if (d === 1) return ' (yesterday)';
      if (d < 30) return ` (${d} days ago)`;
      if (d < 365) return ` (${Math.floor(d / 30)} months ago)`;
      return ` (${Math.floor(d / 365)} years ago)`;
    };
    const line = (e: (typeof gm.events)[number]) =>
      `- ${e.date ? `[${e.date}]` : `[t${e.turn}]`}${ago(e.date)} ${e.summary}${e.chars.length ? ` (${e.chars.join(', ')})` : ''}`;

    // ВАЖНОСТЬ, А НЕ СВЕЖЕСТЬ. Ключевые и важные вехи видны ВСЕГДА, сколько бы
    // времени ни прошло; бытовые события — только последние N. Раньше лента резалась
    // просто по свежести, и крупное событие (переезд, роды, таймскип) вытеснялось
    // мелочёвкой — для модели его переставало существовать.
    const milestones = gm.events.filter((e) => e.level === 'key' || e.level === 'important');
    const ordinary = gm.events.filter((e) => e.level !== 'key' && e.level !== 'important').slice(-12);
    // Скачки времени распознаём и по датам — на случай событий, записанных до
    // появления уровней важности (старые сейвы).
    const skips: typeof gm.events = [];
    for (let i = 1; i < gm.events.length; i++) {
      const prev = parseDate(gm.events[i - 1].date);
      const cur = parseDate(gm.events[i].date);
      if (prev && cur && diffDays(prev, cur) >= 30) skips.push(gm.events[i]);
    }
    const always = [...milestones, ...skips].filter((e, i, a) => a.indexOf(e) === i && !ordinary.includes(e));
    if (always.length) {
      parts.push(
        `MILESTONES (the story is past these; never undo or replay):\n${always
          .slice(-20)
          .map(line)
          .join('\n')}`
      );
    }
    if (ordinary.length) {
      parts.push(`Recent events (already happened):\n${ordinary.map(line).join('\n')}`);
    }
  }

  return parts.length
    ? parts.join('\n\n')
    : '(no game-master state yet — establish it in this turn\'s status block)';
}

// Единый WORLD STATE (Batch 8): дата/время/локация, экономика (баланс+долг+прайс-гайд
// +регулярные статьи), инвентарь и правила для управляющих битов времени/денег/вещей.
// Показываем, если есть хоть одна из подсистем (финансы/телефон/инвентарь/дата).
function worldStateBlock(project: Project, state: RuntimeState): string {
  const financeOn = !!project.finance;
  const phoneOn = !!project.phone?.enabled;
  const inv = state.inventory || [];
  const clock = state.gm.clock;
  const hasDate = !!clock.date;
  // Проектные статы показываем ВСЕГДА (не только в блоке пресета «Current State» —
  // его можно отключить/удалить в редакторе пресета, и тогда ИИ переставал видеть
  // id статов и не мог их обновлять).
  const hasStats = project.stats.length > 0;
  if (!financeOn && !phoneOn && !inv.length && !hasDate && !hasStats) return '';

  const cur = project.phone?.currencyName || '$';
  const bal = state.statValues[PHONE_BALANCE_STAT];
  const hasEconomy = financeOn || phoneOn;
  const parts: string[] = [];

  // Время и место НЕ печатаем здесь. Раньше дата и локация повторялись в промпте
  // трижды — тут, в блоке Game Master и в финальной сводке, — и три копии могли
  // разойтись между собой. Значения теперь ровно в одном месте: в блоке STATE RIGHT
  // NOW в самом конце запроса, то есть там, где модель читает их последними.
  if (clock.date || clock.location) {
    parts.push(
      'Current date, time and place: see STATE RIGHT NOW at the end of the request (the only authoritative copy).'
    );
  }

  // Проектные статы с ТЕКУЩИМИ значениями и точными id — чтобы модель могла и читать,
  // и обновлять их через statChanges (частая жалоба: «в тексте стат вырос, в статах нет»).
  if (hasStats) {
    parts.push(
      `PROJECT STATS (update via statChanges with the exact statId; if the story changes one, emit the statChange this turn):\n${project.stats
        .map((s) => {
          const v = state.statValues[s.id] ?? s.initial;
          return `  - statId: ${s.id} | "${s.name}" = ${v} (${s.min}..${s.max})${s.description ? ` — ${s.description}` : ''}`;
        })
        .join('\n')}`
    );
  }

  // Экономика.
  if (hasEconomy && typeof bal === 'number') {
    const debt = bal < 0 ? ' — the hero is IN DEBT; make it a real pressure in the story.' : '';
    parts.push(`Balance: ${bal} ${cur}.${debt}`);
    const pg = project.phone?.priceGuide?.trim();
    if (pg) parts.push(`Price guide (keep amounts at this scale): ${pg}`);
    // Регулярные статьи — чтобы ИИ упоминал зарплату/аренду по датам.
    const rec = project.finance?.recurringEntries.filter((e) => e.enabled) || [];
    if (rec.length) {
      parts.push(
        `Recurring: ${rec
          .map((e) => `${e.name} ${e.kind === 'income' ? '+' : '-'}${e.amount} (every ${e.periodDays}d, next ${e.nextChargeDate})`)
          .join('; ')}`
      );
    }
  }

  // Инвентарь. Список пересказывается ЦЕЛИКОМ каждый ход и точными названиями —
  // по ним же движок ищет вещь при inventory_remove. Раньше он шёл строкой через
  // запятую, и модель переписывала название по-своему («платье» вместо «красное
  // платье»), а движок такую вещь не находил и молча ничего не убирал.
  if (inv.length) {
    parts.push(
      `INVENTORY (everything the hero owns):\n${inv
        .map((it) => {
          // Откуда и с какого числа вещь у героя. Персонажи ссылаются на подарки
          // («то платье, что я тебе подарил»), а по дате видно, что снаряжение
          // взято ещё до таймскипа, а не появилось сейчас.
          const origin = [it.source, it.acquiredDate && `с ${it.acquiredDate}`].filter(Boolean).join(', ');
          return `  - ${it.emoji} ${it.name}${it.quantity > 1 ? ` ×${it.quantity}` : ''}${origin ? ` — ${origin}` : ''}`;
        })
        .join('\n')}`
    );
  } else {
    parts.push('INVENTORY: empty.');
  }

  // Когда протагонист последний раз виделся с персонажами (Batch 8 §VI) — чтобы ИИ
  // отражал разлуку («давно не виделись»). Только для тех, у кого дата известна.
  if (hasDate) {
    // Дата берётся из ОБОИХ мест, где движок её отмечает: досье и запись реестра.
    // Читалось только досье — а у человека без досье (реестр знает, анкеты нет)
    // отметка писалась в реестр и не доходила до модели вообще. Одна и та же
    // правда лежала в двух местах, и половина её была мёртвой.
    const seen = new Map<string, string>();
    for (const c of state.gm.characters) if (c.lastSeenDate) seen.set(c.name, c.lastSeenDate);
    for (const e of state.gm.registry || []) {
      if (!e.lastSeenDate) continue;
      const who = resolvePerson(project, state, { id: e.id });
      const nm = who?.name || e.canonicalName;
      if (!seen.has(nm)) seen.set(nm, e.lastSeenDate);
    }
    const lines = [...seen].map(([nm, d]) => `${nm}: ${d}`);
    if (lines.length) parts.push(`Last seen (today is ${clock.date}): ${lines.join('; ')}`);
  }

  // Правила.
  const rules: string[] = [
    'This block is authoritative for numbers and possessions: the hero cannot use items they lack or spend money they do not have. Reflect it in scenes (clothing noticed, time since last meeting, wealth or debt).',
    'Date, time and place are only as fresh as your last update. If the story has moved on, the story wins: continue from where it is and correct the record this turn.',
    'Hero changes place (trip, another room, city, country) → emit {"type":"location_change","location":"<where now>"} at that point. Mandatory.',
    'Time passes (night, "a week later", a jump) → emit {"type":"time_advance","newDate":"DD/MM/YYYY","newTime":"HH:MM"}. Mandatory: prose alone does not move the engine clock. Dates only as DD/MM/YYYY.',
    'Money moves only through the transaction beat. Never also put it into statChanges on the balance stat (double charge).',
    'Inventory: the hero owns exactly the list above. Gains → {"type":"inventory_add","name":"<short name>","emoji":"<emoji>","quantity":1,"category":...,"source":"куплено|получено|найдено"}; used, spent, lost, given → {"type":"inventory_remove","name":...,"quantity":1} with the name copied exactly from the list. Narrated-only changes did not happen. Never invent items or re-add owned ones.',
  ];
  if (hasEconomy) {
    rules.push(
      'Money spent or received → {"type":"transaction","amount":<negative spend / positive receive>,"vendor":"<where/from whom>","item":"<what>","time":"HH:MM"}; vendor, item, time required. Not also in statChanges.',
      'Check the balance before a purchase. Cannot afford → no transaction; write the shortfall (declined card, no cash). Recurring bills may push the balance into debt.'
    );
  }
  parts.push('RULES:\n- ' + rules.join('\n- '));

  return `== CURRENT WORLD STATE ==\n${parts.join('\n')}`;
}

// Телефон-коммуникации: контакты и входящие СМС. Деньги/прайс-гайд теперь
// в WORLD STATE. Возвращаем '' если телефон выключен.
function phoneBlock(project: Project, state: RuntimeState): string {
  const cfg = project.phone;
  if (!cfg?.enabled) return '';
  const parts = [
    'The hero has a smartphone. Phone beats (no display text):',
    '  - {"type":"sms_incoming","characterId":"<id>","text":"<message>"} — someone elsewhere texts the hero. People in the scene talk, not text (exception: a deliberate secret text, shown in narration).',
    '  - {"type":"sms_outgoing","characterId":"<id>","text":"<message>"} — the hero texts that person. The hero\'s words never go into sms_incoming.',
    '  - {"type":"contact_added","characterId":"<id>"} — the hero saves a number (only for someone met off-screen; others are added automatically).',
    '  - {"type":"sms_photo","characterId":"<id>","caption":"<optional text>","photo":"<what the photo shows, from their side>"} — a character sends a photo; the engine draws it.',
  ];

  // ПЕРЕПИСКА — часть сюжета. Без этого блока всё, что игрок написал персонажу в
  // мессенджере, для основного движка не существовало: следующий ход шёл так,
  // будто разговора не было. Берём последние сообщения по всем веткам в
  // хронологическом порядке (по времени), помечая их как уже произошедшие.
  const heroName = state.protagonistName || 'the hero';
  const nameOfContact = (contactId: string): string => {
    const c = state.phone?.contacts.find((x) => x.id === contactId || x.characterId === contactId);
    if (c?.name?.trim()) return c.name.trim();
    const proj = project.characters.find((x) => x.id === (c?.characterId || contactId));
    if (proj) return proj.name;
    const reg = state.gm.registry?.find((r) => r.id === c?.registryId);
    return reg?.canonicalName || contactId;
  };
  // Отдельного списка контактов здесь БОЛЬШЕ НЕТ. Он был четвёртым перечнем людей
  // в одном запросе (после карточек, реестра и досье) — ровно та дубликация, из-за
  // которой одни и те же персонажи расходились между собой. Кто есть в телефоне,
  // помечено прямо в картотеке, рядом с самим человеком.
  const groups = (state.phone?.chats || []).filter((c) => c.kind === 'group' && !c.archived);
  if (groups.length) {
    parts.push(
      `Group chats on the phone: ${groups
        .map((g) => `"${g.title || 'без названия'}" (${g.participantIds.map(nameOfContact).join(', ')})${g.topic ? ` — ${g.topic}` : ''}`)
        .join('; ')}.`
    );
  }

  const chatLines: { at: number; line: string }[] = [];
  for (const chat of state.phone?.chats || []) {
    const where =
      chat.kind === 'group'
        ? `[group "${chat.title || 'без названия'}": ${chat.participantIds.map(nameOfContact).join(', ')}]`
        : '';
    for (const m of chat.messages) {
      const body =
        m.text?.trim() ||
        (m.attachedAssetId || m.photoPrompt ? `[sent a photo${m.photoPrompt ? `: ${m.photoPrompt.slice(0, 80)}` : ''}]` : '');
      if (!body) continue;
      const who =
        m.from === 'protagonist'
          ? heroName
          : nameOfContact(m.senderId || chat.participantIds[0] || '');
      const to = chat.kind === 'group' ? where : m.from === 'protagonist' ? `→ ${nameOfContact(chat.participantIds[0] || '')}` : `→ ${heroName}`;
      // Метка внутриигрового времени: переписка стоит на одной оси со сценами,
      // а не отдельным потоком «когда-то».
      const when = m.storyDate ? `[${m.storyDate}${m.storyTime ? ` ${m.storyTime}` : ''}] ` : '';
      chatLines.push({ at: m.at || 0, line: `  ${when}${who} ${to}: ${body.slice(0, 200)}` });
    }
  }
  if (chatLines.length) {
    const tail = chatLines.sort((a, b) => a.at - b.at).slice(-14);
    parts.push(
      'RECENT TEXT MESSAGES (already delivered, canon; never resend — react to them in the scene; sms_incoming only for new messages):\n' +
        tail.map((x) => x.line).join('\n')
    );
  }
  return `== PHONE ==\n${parts.filter(Boolean).join('\n')}`;
}

export interface BuiltRequest {
  system: string;
  messages: LlmMessage[];
  prefill?: string;
  // Сколько ЕЩЁ НЕ СВЁРНУТЫХ сообщений пришлось выбросить, чтобы уложиться в
  // бюджет. Больше нуля — значит образовалась «слепая зона»: этих ходов нет ни в
  // контексте, ни в памяти. Движок отвечает на это немедленной свёрткой.
  droppedUnfolded?: number;
  // Неизменяемая часть запроса (системный промпт + блоки пресета + ход игрока)
  // в токенах — для индикатора памяти и расчёта места под живую историю.
  fixedTokens?: number;
  // Системная часть больше всего бюджета. Свёртку в этом случае форсировать
  // вредно (она наращивает журнал) — надо уплотнять память, а не историю.
  systemOverBudget?: boolean;
  // Режим, которым собран запрос, и ждать ли в ответе служебный блок состояния.
  // Движок читает это, чтобы не пытаться разобрать прозу как JSON и наоборот.
  mode: NarrativeMode;
  expectStateBlock: boolean;
}

export async function buildRequest(
  project: Project,
  state: RuntimeState,
  playerMove: string,
  opts?: { skipVector?: boolean; extraDirective?: string; preview?: boolean }
): Promise<BuiltRequest> {
  const cfg = project.aiConfig;
  const ps = getPresetSettings(); // ГЛОБАЛЬНЫЙ пресет/настройки генерации (не на проект)
  // Режим повествования решает, ЧЕМ собирать запрос: у новеллы и текстового РП
  // разные пресеты (см. presetForMode) и разный контракт ответа.
  const mode = normalizeNarrativeMode(project.mode);
  const ctx: MacroContext = { project, state };
  const onScreenIds = state.onScreen.map((s) => s.characterId);

  const recentText =
    state.history
      .slice(-cfg.maxContextMessages)
      .map((m) => m.content)
      .join('\n') +
    '\n' +
    playerMove;
  const lore = matchLorebook(project.lorebook, recentText);
  const lorebookText = lore.length
    ? lore.map((e) => `[${e.title}] ${expandMacros(e.content, ctx)}`).join('\n')
    : '(no active entries)';

  const currentBg =
    project.assets.find((a) => a.id === state.currentBackgroundId)?.name || 'not set';

  const protagonistLine = state.protagonistName
    ? `The player's hero is named: ${state.protagonistName}.`
    : '';

  let planPromise: Promise<MemoryPlan> | null = null;
  const memoryPlan = () => (planPromise ||= buildMemoryPlan(project, state, playerMove, opts?.skipVector));

  // Content generators for the preset's dynamic blocks.
  const dynamicContent: Record<DynamicSource, () => Promise<string> | string> = {
    world: () =>
      `== WORLD ==\n${expandMacros(project.lore.worldDescription, ctx)}\n\nNARRATIVE RULES:\n${expandMacros(
        project.lore.narrativeRules,
        ctx
      )}${protagonistLine ? `\n${protagonistLine}` : ''}`,
    plot: () =>
      project.lore.plotOutline ? `== PLOT ARC ==\n${expandMacros(project.lore.plotOutline, ctx)}` : '',
    lorebook: () => `== ACTIVE LOREBOOK ENTRIES ==\n${lorebookText}`,
    characters: () => `== WHO'S WHO (single roster: identity + card + current state) ==\n${whoIsWhoBlock(project, state, onScreenIds, ctx, mode, recentText)}`,
    manifest: () => `== ASSET MANIFEST ==\n${assetManifest(project)}`,
    state: () =>
      mode === 'rp'
        ? // В текстовом РП фона и музыки нет — остаются только статы проекта.
          `== CURRENT STATE ==\nStats:\n${statsState(project, state.statValues)}`
        : `== CURRENT STATE ==\nStats:\n${statsState(project, state.statValues)}\nCurrent background: ${currentBg} (${
            state.currentBackgroundId ?? 'null'
          })\nMusic mood: ${state.currentMusicMood ?? 'none'}`,
    voice: () => voiceSamplesText(project, state, onScreenIds, mode, recentText, ctx),
    memory: async () => `== MEMORY ==\n${(await memoryPlan()).memory}`,
    memorybook: async () => (await memoryPlan()).memorybook,
    gamemaster: () => gameMasterBlock(state, state.turnCount),
    // История вставляется как СООБЩЕНИЯ, а не текст: обработчик выше перехватывает
    // этот блок раньше и запоминает позицию. Заглушка нужна лишь для полноты типа.
    history: () => '',
  };

  // Собираем промпт из редактируемого пресета (Batch 3 §8): по порядку, только
  // включённые блоки; статичные — их текст (с макросами), динамические — от движка.
  // Роль блока (как в Таверне): 'system' идёт в системный промпт; 'user'/'assistant'
  // становятся отдельными сообщениями ПЕРЕД живой историей.
  const preset = presetForMode(ps, mode);
  const systemParts: string[] = [];
  const presetMessages: LlmMessage[] = [];
  const renderedDynamics = new Set<DynamicSource>();
  // Куда вставлять живую историю. null — блока «История переписки» в пресете нет
  // (старые пресеты): тогда, как раньше, история идёт после всех блоков.
  let historyAt: number | null = null;
  // Блоки, которые пользователь ВЫКЛЮЧИЛ осознанно. Их надо отличать от блоков,
  // которых в пресете нет вовсе (импорт из Таверны): первые уважаем, вторые
  // добавляем сами, иначе память или манифест выпадали из контекста целиком.
  const disabledDynamics = new Set<DynamicSource>();
  // Какие встроенные блоки включены — нужно для коротких напоминаний «на глубине»
  // (см. DEPTH_REMINDERS ниже).
  const enabledBuiltins = new Set(
    preset.blocks.filter((b) => b.enabled && b.builtinKey).map((b) => b.builtinKey as string)
  );
  for (const block of preset.blocks) {
    if (!block.enabled) {
      if (block.dynamic) disabledDynamics.add(block.dynamic);
      continue;
    }
    // История переписки — не текст, а МЕСТО в ленте сообщений. Запоминаем, сколько
    // блоков пресета оказалось выше неё: всё, что после, уйдёт ПОСЛЕ живой истории
    // и будет прочитано моделью как более свежее.
    if (block.dynamic === 'history') {
      historyAt = presetMessages.length;
      renderedDynamics.add('history');
      continue;
    }
    let text: string;
    if (block.dynamic) {
      const gen = dynamicContent[block.dynamic];
      text = gen ? await gen() : '';
      renderedDynamics.add(block.dynamic);
    } else {
      text = expandMacros(block.content, ctx);
    }
    if (!text.trim()) continue;
    const role = block.role || 'system';
    // ПОЛОЖЕНИЕ БЛОКА РЕШАЕТ, КУДА ОН УЙДЁТ. Раньше решала только роль: любой
    // system-блок улетал в системную часть, то есть в самое начало запроса, —
    // и опустить его ниже истории было НЕВОЗМОЖНО. Пользователь переставлял блок
    // в панели, порядок сохранялся, а в запросе не менялось ничего: движок молча
    // возвращал блок наверх. Теперь всё, что стоит ниже «Истории переписки», едет
    // после неё отдельным сообщением — со своей ролью, как выбрано в панели.
    // (Строгим шлюзам системное сообщение посреди диалога не нравится — на этот
    // случай в пресете есть «Обработка промпта»: «Полустрогая» превратит его в
    // user-сообщение, как это делает Таверна.)
    if (role === 'system' && historyAt === null) systemParts.push(text);
    else presetMessages.push({ role, content: text });
  }

  // ГАРАНТИЯ ДВИЖКОВЫХ БЛОКОВ (фикс «память не инжектится»): если блока НЕТ в
  // пресете — например, пресет импортирован из Таверны и содержит только статичный
  // текст, — мир/персонажи/манифест/состояние/ПАМЯТЬ выпадали из контекста целиком.
  // Такие блоки движок добавляет сам, в каноническом порядке.
  // НО: раньше сюда же попадали блоки, ВЫКЛЮЧЕННЫЕ галочкой, — движок молча
  // возвращал их обратно, и отключить, скажем, Game Master было невозможно.
  // Осознанное «выключить» теперь уважается: это ваш пресет, а не наш.
  // 'history' сюда НЕ входит: её отсутствие в пресете означает «как раньше,
  // в конце», а не «блок потерялся».
  const REQUIRED_DYNAMICS: DynamicSource[] = [
    'world', 'plot', 'lorebook', 'characters', 'manifest', 'state', 'gamemaster', 'memory', 'memorybook',
  ];
  const turnedOff = REQUIRED_DYNAMICS.filter((k) => disabledDynamics.has(k));
  if (turnedOff.length) {
    logEvent(
      'info',
      'prompt',
      `Блоки [${turnedOff.join(', ')}] выключены в пресете — в контекст не идут. Это ваш выбор, движок их не подставляет.`
    );
  }
  const missing = REQUIRED_DYNAMICS.filter((k) => !renderedDynamics.has(k) && !disabledDynamics.has(k));
  if (missing.length) {
    logEvent('info', 'prompt', `В пресете нет динамических блоков [${missing.join(', ')}] — добавлены движком`);
    for (const k of missing) {
      const text = await dynamicContent[k]();
      if (text.trim()) systemParts.push(text);
    }
  }

  // Авторитетная длина хода (ползунок/ввод в пресете) — переопределяет любые числа
  // в тексте блоков. Ставим последней в системном промпте, чтобы имела приоритет.
  //
  // Вариантов ДВА, и это не косметика. Одно время в РП этой директивы не было вовсе
  // (её сняли вместе с языком про биты, characterId и спрайты — в РП ответ обычная
  // проза, и биты там ни при чём), а от длины оставалась одна строка-напоминание в
  // хвосте. Строка проигрывала пресету: «write a substantial reply», «let scenes
  // breathe» звучат авторитетнее вежливого «stay within», и ход выходил одинаково
  // средним, куда бы ни двигали ползунок. Поэтому в РП стоит своя директива — с тем
  // же весом, что в новелле, но про абзацы прозы вместо бит.
  const tl = ps.turnLength || DEFAULT_TURN_LENGTH;
  systemParts.push(
    mode === 'rp'
      ? `TURN LENGTH (authoritative; overrides every other length or pacing instruction): ${tl.min}–${tl.max} words of story.
- ${tl.max} is a hard ceiling; stop at a natural pause inside the range, do not pad.
- ${tl.min} is a real floor: if short, add a beat that moves something (an action, a reveal, a shift), never filler.
- Reach the length with more paragraphs, not longer ones.
- The range is the author's choice; do not drift toward a "normal" reply length.`
      : `TURN LENGTH & BEATS (authoritative; overrides other length guidance): ${tl.min}–${tl.max} words total; stop at a natural pause, do not overshoot. Medium beats of 1–3 sentences; grow the turn with more beats, not bigger ones. Mix dialogue and narration: present characters speak via "dialogue" beats with their characterId (this shows their sprite).`
  );
  // Частота выборов. По умолчанию (gap = 0) выборы обязательны КАЖДЫЙ ход — иначе
  // игрок упирается в экран без вариантов. Ползунок в пресете (gap > 0) — осознанный
  // отказ пользователя от этого: тогда просим модель придерживать выборы.
  //
  // ТОЛЬКО новелла. В РП выборов нет вовсе — это как раз и была причина, почему
  // модель писала «выборы» в конце ответа даже при пустом rp_no_impersonation:
  // здесь стояла БЕЗУСЛОВНАЯ директива «EVERY turn ends with 2–4 choices», да ещё
  // и помеченная «overrides any other guidance above» — она перебивала весь
  // РП-пресет и заставляла модель предлагать выбор каждый ход.
  if (mode !== 'rp') {
    const gap = ps.choiceMinGap ?? 0;
    systemParts.push(
      gap > 0
        ? `CHOICES (authoritative): offer choices at most once every ~${gap} turns, only at a real decision point; otherwise choices: [].`
        : `CHOICES (authoritative): every turn ends with 2–4 choices; never an empty array. From the hero's side, different in intent or tone, actions in *italics*, no move tags, no bare "Continue".`
    );
  }
  // Язык повествования (пресет). Управляет языком ТЕКСТА истории; ключи JSON и
  // id/настроения ассетов остаются английскими.
  const narr = ps.narrativeLanguage === 'en' ? 'English' : 'Russian (русский)';
  systemParts.push(
    mode === 'rp'
      ? `LANGUAGE (authoritative): all story text in ${narr}, whatever the language of instructions or cards. Keep names and proper nouns as given.`
      : `LANGUAGE (authoritative): all story text (narration, thoughts, dialogue, choices) in ${narr}, whatever the language of instructions or cards. JSON keys, ids, emotion keys, outfit tags, moods and background ids stay exactly as given.`
  );
  // Реестр персонажей (patch character-registry) — идентичность по id + правило.
  // Единый WORLD STATE (Batch 8) — дата/деньги/долг/инвентарь + правила.
  const worldCtx = worldStateBlock(project, state);
  if (worldCtx) systemParts.push(worldCtx);
  // Телефон-коммуникации (Batch 7) — только если расширение включено.
  const phoneCtx = phoneBlock(project, state);
  if (phoneCtx) systemParts.push(phoneCtx);

  // ГРАНИЦА КОНТЕКСТА — последним блоком системной части, вплотную к живой истории.
  // Порядок у нас правильный (фон и память → недавние ходы дословно → ход игрока),
  // но модели об этом никто не говорил: она видела снапшот с «CURRENT SITUATION» и
  // отдельно поток сообщений, не понимая, что новее. Отсюда и откаты состояния —
  // модель принимала снапшот (срез на момент прошлой свёртки) за самое свежее.
  systemParts.push(
    `=== CONTEXT ORDER ===\n` +
      `Above: background — world, characters, memory (chapters oldest → newest; the snapshot is from the last memory fold). ` +
      `Below: the recent story verbatim, newer than everything above; the last user message is the move to answer. ` +
      `If recent messages contradict the background, the recent messages win: continue from them, never rewind.`
  );
  const system = systemParts.join('\n\n');

  // Живое окно истории. КЛЮЧЕВОЕ (фикс памяти): шлём ВСЮ ещё-не-свёрнутую историю,
  // а не только последние liveWindow ходов. Иначе между свёртками (summaryEveryN)
  // возникает «слепая зона» — ходы старше окна, но ещё не попавшие в саммари,
  // выпадают из контекста, и игра ведёт себя так, будто событий не было. История уже
  // ограничена свёрткой (~summaryEveryN + liveWindow ходов), а ходы ассистента идут
  // сжатой прозой (лёгкие по токенам). Кап — на случай сбоя саммаризации.
  const K = Math.max(2, ps.liveWindow);
  const everyN = Math.max(4, project.memoryConfig.summaryEveryN);
  const histCap = (everyN + K + 6) * 2; // сообщений (2 на ход)
  // Ходы ассистента едут в контекст сжатыми: в новелле — прозой, вынутой из JSON;
  // в РП проза и так лежит в истории, но со служебной сводкой <state> на хвосте —
  // её вырезаем. Пересылать модели её собственную сводку незачем: актуальная версия
  // приезжает динамическим блоком Game Master, а старая с ним ещё и спорит.
  // Правила-регэкспы со scope 'prompt' правят ровно то, что уезжает модели, и
  // ничего больше: на экране игрока текст остаётся исходным.
  const rx = (text: string, role: 'ai' | 'user') =>
    applyRegexRules(text, ps.regexRules, { role, scope: 'prompt' });
  let window: LlmMessage[] = state.history.slice(-histCap).map((m) =>
    m.role === 'assistant'
      ? {
          role: 'assistant' as const,
          content: rx(
            mode === 'rp'
              ? stripStateBlock(m.content)
              : condenseAssistantTurn(m.content, project, state) ?? m.content,
            'ai'
          ),
        }
      : { role: m.role, content: rx(m.content, 'user') }
  );

  // ЖЁСТКИЙ БЮДЖЕТ КОНТЕКСТА. «Бюджет контекста» из пресета раньше был только
  // индикатором: запрос собирался без оглядки на него и на длинной истории уходил
  // в 40–60k токенов. Провайдеры отвечают на это 400/413/429/504 («апи рабочий, а
  // ошибки сыплются»). Теперь бюджет реально ограничивает ЖИВУЮ ИСТОРИЮ: системная
  // часть и ход игрока неприкосновенны, старые сообщения срезаются с начала, пока
  // запрос не уложится. Что срезано — уже в саммари (журнал эпизодов + снапшот).
  const budget = Math.max(2000, ps.contextBudget || 8000);
  const fixedTokens =
    estimateTokens(system) +
    presetMessages.reduce((n, m) => n + estimateTokens(m.content), 0) +
    estimateTokens(playerMove) +
    400; // заметки автора, ремайндеры, директивы
  // Минимум 6 ходов живой истории: при 2 ходах (как раньше) модель выглядела
  // амнезиком — «забывала», что было парой сообщений раньше, стоило системной
  // части (память+реестр+world state+переписка) перерасти бюджет.
  // preview — сборка «начерно» (индикатор токенов, панель памяти). Такой замер не
  // должен подменять настоящий: по нему свёртка решает, сколько истории живёт
  // дословно, а начерно считается без векторного подсоса и с фиктивным ходом.
  if (!opts?.preview) lastFixed = fixedTokens;
  let overloaded = false;
  const MIN_WINDOW = 12;
  let winTokens = window.reduce((n, m) => n + estimateTokens(m.content), 0);
  let dropped = 0;
  while (window.length > MIN_WINDOW && fixedTokens + winTokens > budget) {
    winTokens -= estimateTokens(window[0].content);
    window = window.slice(1);
    dropped++;
  }
  // Первым в диалоге должно идти сообщение игрока: Gemini (и часть шлюзов) отвечают
  // 400/пустотой, если история начинается с assistant. Срез сверху может оставить
  // «висящий» ответ ИИ — убираем его. Это ПРОТОКОЛЬНАЯ правка, а не нехватка места:
  // в droppedUnfolded её не считаем, иначе движок форсировал бы свёртку каждый ход
  // на истории, которая открывается ходом ИИ (бывает после возврата архива).
  // Требование ПРОТОКОЛЬНОЕ, и чинить его надо протокольно: раньше висящий ответ
  // просто ВЫБРАСЫВАЛСЯ, а это стирание сюжета. В РП история теперь штатно
  // открывается ответом модели — стартовую сцену рассказывает она, а не игрок, —
  // и старая логика молча удаляла её из контекста КАЖДЫЙ ход: модель не помнила
  // собственного начала истории. Вместо удаления подставляем недостающий ход
  // игрока: требование шлюза выполнено, а текст остаётся на месте.
  if (window.length && window[0].role === 'assistant') {
    // Подставляемый ход коротаем: бюджет уже посчитан выше, и длинная стартовая
    // сцена целиком вышла бы за него. Модели тут нужен повод, а не пересказ —
    // сама сцена и так лежит в системной части (== WORLD ==).
    const opening = expandMacros(project.lore.openingScene, ctx).trim().slice(0, 600);
    window = [
      { role: 'user', content: opening ? `[GAME START] ${opening}` : '[GAME START]' },
      ...window,
    ];
    logEvent(
      'info',
      'prompt',
      'Окно истории открывалось ответом ИИ — подставлен ход игрока «[GAME START]» (шлюзы вроде Gemini ' +
        'не принимают историю, начинающуюся с ассистента). Сам ответ остался в контексте.'
    );
  }
  if (dropped) {
    // ВАЖНО: всё, что лежит в state.history, ещё НЕ свёрнуто в память. Выбросив
    // такое сообщение, мы стираем кусок сюжета для модели полностью — он не
    // попадёт ни в контекст, ни в журнал эпизодов до следующей свёртки. Раньше
    // это было тихой записью 'info', и игра выглядела амнезиком: «в прошлом ходу
    // был в больнице — а теперь снова туда едет». Теперь это предупреждение, а
    // движок по этому же счётчику форсирует свёртку сразу после хода.
    logEvent(
      'warn',
      'prompt',
      `Живая история не влезла в бюджет ${budget} ток.: выброшено ${dropped} ещё не свёрнутых сообщений ` +
        `(осталось ${window.length}). Свёртка памяти будет запущена немедленно, чтобы эти события не потерялись.`
    );
  }
  // Системная часть сама по себе больше бюджета — живая история зажата в минимум.
  // Это надо видеть: иначе жалоба выглядит как «память не работает».
  if (fixedTokens > budget) {
    // Системная часть сама перерос­ла бюджет. Форсировать свёртку здесь НЕЛЬЗЯ:
    // она дописывает в журнал ещё один эпизод, то есть системная часть станет
    // только больше — получался порочный круг «зажали историю → свернули →
    // память выросла → зажали сильнее». Сигналим отдельным флагом.
    overloaded = true;
    logEvent(
      'warn',
      'prompt',
      `Системная часть запроса (~${fixedTokens} ток.) БОЛЬШЕ бюджета контекста (${budget}). ` +
        `Живая история зажата до минимума (${window.length} сообщ.). Поднимите «Бюджет контекста» в пресете (🎚) ` +
        `или сократите снапшот/журнал в Game Master → Саммари.`
    );
  }

  const messages: LlmMessage[] =
    historyAt === null
      ? [...presetMessages, ...window]
      : [...presetMessages.slice(0, historyAt), ...window, ...presetMessages.slice(historyAt)];

  // Продвинутые кастомные вставки на заданной глубине от конца (author's note style).
  // Блоки без режима — общие (так вели себя все до появления второго режима);
  // с режимом — только в своём. Без этого блок, написанный под новеллу, молча
  // уезжал и в РП и тянул ответ обратно к формату новеллы.
  const blocks = (ps.advancedBlocks || []).filter(
    (b) => b.content.trim() && (!b.mode || b.mode === mode)
  );
  // НЕВИДИМАЯ OOC-ЗАПИСКА — последним, что модель прочтёт ПЕРЕД ходом игрока.
  //
  // Место выбрано не «примерно рядом», а точно: сразу после этого сообщения идёт
  // сам ход, и всё, что стоит здесь, читается как условие, при котором ход надо
  // отыграть. Авторские заметки живут в общем хвосте директив и делят внимание с
  // длиной хода, форматом и напоминаниями; записка не делит его ни с чем.
  //
  // В ленте её нет и в историю она не попадает: собирается заново каждый ход из
  // состояния (buildRequest вызывается на каждый ход с нуля), поэтому и накопиться
  // в переписке не может.
  const withMove: LlmMessage[] = [...messages];
  const ooc = expandMacros((state.oocNote || '').trim(), ctx);
  if (ooc) {
    withMove.push({
      role: 'user',
      content:
        '[OOC from the player to you, the narrator. Not in the story: nobody hears it; never answer or mention it. ' +
        'A binding condition for how you write this turn:]\n' +
        ooc,
    });
  }
  withMove.push({ role: 'user', content: rx(playerMove, 'user') });
  for (const b of blocks) {
    const depth = Math.max(0, Math.floor(b.depth));
    const insertAt = Math.max(0, withMove.length - depth);
    withMove.splice(insertAt, 0, { role: 'user', content: expandMacros(b.content, ctx) });
  }

  // ХВОСТ ПОСЛЕ ХОДА ИГРОКА — ОДНИМ сообщением. Раньше заметки, директива события,
  // реролл и ремайндер шли 2–4 ОТДЕЛЬНЫМИ user-сообщениями, и ход игрока оказывался
  // за несколько сообщений до конца. Модели, сильнее весящие последнее сообщение,
  // отвечали на ремайндер и «забывали» сам ход. Теперь после хода ровно один блок.
  const tail: string[] = [];

  // СВЕЖИЕ ФАКТЫ — ПОСЛЕДНИМИ. Всё «состояние мира» (часы, досье, снапшот) лежит в
  // системной части, то есть ДО истории. Модели читают системный промпт как высшую
  // истину, и устаревшая строчка оттуда («status: беременна») перебивала полсотни
  // свежих сообщений: отсюда «дочка уже давно есть, а она снова беременна».
  // В Таверне это решают инжектом на глубину; делаем так же — короткая сводка того,
  // что меняется чаще всего, идёт в самый конец, после всей истории.
  const nowBits: string[] = [];
  // Номер текущего хода — ЗДЕСЬ, в самом конце запроса, и больше нигде. Всё, что
  // выше, датируется абсолютными номерами ходов; свежесть модель считает отсюда.
  // Так «сейчас» меняется в одной строке в хвосте, а не в начале системной части,
  // где каждая правка обнуляет кэш префикса у провайдера и заставляет пересчитывать
  // весь контекст с нуля каждый ход.
  nowBits.push(`Current turn: ${state.turnCount}. Anything stamped with an earlier turn is older.`);
  const clockNow = formatClock(state.gm.clock);
  if (clockNow) {
    const el = elapsedPhrase(state.gm.clock.startDate, state.gm.clock.date);
    nowBits.push(`Date/time/place: ${clockNow}${el ? ` (${el} since the story began)` : ''}`);
  }
  const locAt = state.gm.clock.locationAtTurn ?? 0;
  const locAge = locAt ? state.turnCount - locAt : null;
  if (locAge !== null && locAge > 2) {
    nowBits.push(
      `(place recorded ${locAge} turns ago — if the story moved since, follow the story and emit location_change)`
    );
  }
  if (state.onScreen.length) nowBits.push(`In the scene: ${onScreenState(project, state)}`);
  // Статусы тех, кто сейчас на сцене, — только свежие: старые пусть остаются
  // наверху с пометкой возраста, дублировать их здесь незачем.
  const onIds = new Set(state.onScreen.map((o) => o.characterId));
  const freshDossiers = state.gm.characters
    .filter((c) => c.status?.trim() && (!c.updatedAtTurn || state.turnCount - c.updatedAtTurn <= 10))
    .filter((c) => !c.charId || onIds.has(c.charId))
    .slice(0, 6)
    .map((c) => `${c.name}: ${c.status}`);
  if (freshDossiers.length) nowBits.push(`Current status: ${freshDossiers.join('; ')}`);
  if (nowBits.length) {
    tail.push(
      `[STATE RIGHT NOW — overrides older values above]\n${nowBits.join('\n')}`
    );
  }

  // Заметки для ИИ (Author's Note, см. CR v2 §M): универсальные + проектные.
  // Пометка приоритета обязательна: заметка соревнуется с планом (plotOutline,
  // адженда, крючки снапшота) и без явного «перекрывает» проигрывала ему.
  const notes = [...getGlobalNotes(), ...state.authorNotes].filter((n) => n.text.trim());
  if (notes.length) {
    tail.push(
      '[AUTHOR NOTES — highest priority; override the plot outline, agenda, memory hooks and your plans. ' +
        'A prohibition holds until the player removes it; never work around it (other character, near-miss, dream, talk about it):]\n' +
        notes.map((n) => `- ${expandMacros(n.text, ctx)}`).join('\n')
    );
  }

  // Напоминания по включённым блокам поведения — перед директивами хода, но уже
  // после всей истории: это последнее, что модель читает про то, КАК себя вести.
  const depth = DEPTH_REMINDERS.filter((r) => r.keys.some((k) => enabledBuiltins.has(k))).map((r) => r.text);
  if (depth.length) tail.push(depth.join('\n'));

  // Стоп-слова. undefined = список по умолчанию, пустая строка = осознанно
  // выключено (тогда ни блока, ни пункта проверки в чек-листе размышления).
  const banWords = (ps.banWords ?? DEFAULT_BAN_WORDS).trim();
  if (banWords) {
    tail.push(
      'BANNED PHRASES — never write these in any language or form, including rewordings and synonyms of the same image. ' +
        'Use a different image or drop the beat:\n' +
        banWords
    );
  }

  // Скрытая директива случайного события/СМС/реролла — игрок её не видит и она НЕ
  // сохраняется в истории (buildRequest собирает сообщения заново каждый ход).
  if (opts?.extraDirective?.trim()) tail.push(opts.extraDirective.trim());

  // Ремайндер формата + длины — последним в блоке. В РП он другой: там нет ни
  // JSON, ни битов, ни characterId, и старый текст прямо просил бы модель писать
  // служебную разметку в прозу.
  const stateOn = mode === 'rp' && enabledBuiltins.has(RP_STATE_BLOCK_KEY);
  const lengthReminder =
    mode === 'rp'
      ? `Length: ${tl.min}–${tl.max} words of story. Paragraphs; no walls of text, no one-liners.`
      : `Length: ${tl.min}–${tl.max} words in beats of 1–3 sentences; mix dialogue (with the speaker's characterId) and narration.`;
  const formatReminder =
    mode === 'rp'
      ? 'Reply with the story only: plain prose, no JSON, no headers, no OOC text, nothing written for the player.' +
        // Сам контракт сводки лежит блоком пресета — далеко наверху, за всей
        // историей. Одной строки-упоминания в хвосте не хватало: модель дописывала
        // прозу и на этом останавливалась, а сводка «терялась» — с ней переставали
        // обновляться часы, досье и память. Поэтому здесь не напоминание, а сам
        // каркас: его остаётся заполнить, а не вспомнить.
        (stateOn
          ? `\nThen append the status block (required, hidden from the player, last thing in the reply):\n` +
            `${RP_STATE_OPEN}\n{ "clock": { "day": "...", "month": "...", "year": "...", "time": "...", "location": "..." },\n` +
            `  "characters": [ { "name": "...", "status": "...", "mood": "...", "location": "..." } ] }\n` +
            `${RP_STATE_CLOSE}\n` +
            `clock and characters every turn, even if unchanged; other fields per the contract above.`
          : '')
      : FORMAT_REMINDER;

  // Управляемое размышление: короткий план в <thinking> вместо медленной родной
  // «думалки». Префилл открывает тег, инструкция задаёт короткий шаблон плана,
  // после закрытия тега — только ответ. Парсер вырезает <thinking>…</thinking>.
  let prefill = ps.prefill?.trim() || undefined;
  // …но только там, где родную думалку РЕАЛЬНО можно заглушить. У моделей, которые
  // думают всегда (GLM-5.x, Kimi, DeepSeek-R1), наш план не заменяет родное
  // размышление, а ложится ПОВЕРХ него: модель сперва думает про себя минуту-две,
  // потом пишет ещё и наш план, и только потом прозу. Ровно отсюда «китайские
  // модели тупят, а Gemini с Claude резвые» — у тех двоих думалка отключается.
  // Родное размышление теперь видно в ленте по мере набора, так что смысл
  // управляемого плана (видеть, что модель планирует) там и так закрыт.
  const nativeThinker = modelAlwaysThinks();
  if (ps.guidedThinking) {
    // Чек-лист по умолчанию зависит и от режима, и от ПРОФИЛЯ модели: под DeepSeek он
    // начинается с разбора собственного прошлого ответа, и без этого пункта запрет
    // «не повторяйся» повисает в воздухе — модель не считает, что повторяется.
    // Берём профильный именно как ДЕФОЛТ: свой текст автора всегда важнее.
    const planDefault =
      mode !== 'rp'
        ? DEFAULT_THINKING_PLAN
        : ps.modelProfile === 'deepseek'
          ? DEEPSEEK_THINKING_PLAN
          : DEFAULT_RP_THINKING_PLAN;
    let plan = ps.thinkingPlan?.trim() || planDefault;
    // Пункт про стоп-слова осмыслен, только если список есть. С пустым списком он
    // просил бы сверяться с пустотой — модель отвечала бы «clean», не проверив
    // ничего, и приучалась бы отвечать так же на соседние пункты.
    if (!banWords) plan = plan.split('\n').filter((l) => !/^\s*\d+\.\s*BAN LIST/i.test(l)).join('\n');

    if (nativeThinker) {
      // У этой модели своя думалка, и выключить её нельзя. Свой <thinking> здесь
      // ложился бы ПОВЕРХ родного размышления — ход обдумывался бы дважды, отсюда
      // и полторы минуты ожидания. Но сами проверки нужны ей ровно так же, поэтому
      // отдаём чек-лист без тегов и без префилла: пусть пройдёт его в своём
      // размышлении, а в ответ напишет только сцену.
      tail.push(
        'SELF-CHECK: before writing, go through this checklist in your own reasoning, in order; let the answers shape the turn.\n' +
          // Просьбы «не пиши это в ответ» мало: список с заголовками выглядит как
          // форма, и модель её заполняет. Gemini 3.x делает это особенно охотно и
          // особенно неудобно — JSON-объектом с нашими же ключами прямо перед
          // сценой. Поэтому запрет конкретный, названы обе формы, и оставлен
          // выход: если удержаться невозможно — в теги, откуда движок это вырежет.
          'The reply contains only the story: never write these steps or their answers, and never a JSON object with these labels as keys. ' +
          'If reasoning must appear, put it in <thinking></thinking> before the prose:\n' +
          plan
      );
      tail.push(`${formatReminder}\n${lengthReminder}`);
      logEvent(
        'info',
        'prompt',
        'Своё размышление в <thinking> для этой модели отключено: она думает всегда, и наш план лёг бы ' +
          'поверх её собственного. Чек-лист ушёл к ней как SELF-CHECK — проверки те же, но в её родной думалке.'
      );
    } else {
      const after =
        mode === 'rp'
          ? 'Then close </thinking> and write the scene only.'
          : 'Then close </thinking> and output the one JSON object, nothing after it.';
      tail.push(
        'REASONING: start the reply with one <thinking></thinking> block. One short line per step, in order, in the story language. ' +
          'Checklist, not prose: no drafting, no second pass. Clean step → "clean"/"ok"; otherwise name the fix.\n' +
          `${plan}\n${after}\n${lengthReminder}\n${formatReminder}`
      );
      prefill = '<thinking>\n';
    }
  } else {
    tail.push(`${formatReminder}\n${lengthReminder}`);
  }

  withMove.push({
    role: 'user',
    content:
      `(Engine directives for this turn. Answer the player's move above; this block only constrains how.)\n\n` +
      tail.join('\n\n'),
  });

  return {
    system,
    messages: withMove,
    prefill,
    droppedUnfolded: dropped,
    fixedTokens,
    systemOverBudget: overloaded,
    mode,
    expectStateBlock: stateOn,
  };
}

// Живой счётчик токенов/контекста (см. CR v2 §J) — считает по РЕАЛЬНО собранному
// промпту (без векторного подсоса, чтобы не гонять эмбеддинги ради индикатора).
export async function estimateContextTokens(
  project: Project,
  state: RuntimeState,
  playerMove: string
): Promise<number> {
  try {
    const req = await buildRequest(project, state, playerMove || '(next turn)', {
      skipVector: true,
      preview: true,
    });
    const text = req.system + req.messages.map((m) => m.content).join('\n');
    return estimateTokens(text);
  } catch {
    return 0;
  }
}
