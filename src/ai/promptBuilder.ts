import type { Project, RuntimeState, LlmMessage } from '../shared/types';
import { AUDIO_MOODS, DEFAULT_TURN_LENGTH, DEFAULT_THINKING_PLAN, PHONE_BALANCE_STAT } from '../shared/types';
import { FORMAT_REMINDER } from './directorPrompt';
import { type DynamicSource } from './promptPreset';
import { getPresetSettings } from './presetSettings';
import { matchLorebook } from './lorebookEngine';
import { logEvent } from '../shared/logStore';
import { getGlobalNotes } from '../shared/globalNotes';
import { characterOutfits, defaultOutfitTag, hasExtraOutfits } from '../shared/outfits';
import { extractJson } from './responseParser';
import { formatClock } from './gameMaster';
import { parseDate, diffDays } from '../shared/gameDate';
import { expandMacros, type MacroContext } from './macros';
import { retrieveRelevant } from './vectorEngine';
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
  const lines = obj.beats
    .map((b: any) => {
      const text = typeof b?.text === 'string' ? b.text : '';
      if (!text) return '';
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
  return `Phone: saved as a contact (id ${contact.id}${talk})${groups.length ? `; in group chats: ${groups.join(', ')}` : ''} — reachable via sms_incoming / sms_photo.`;
}

function whoIsWhoBlock(
  project: Project,
  state: RuntimeState,
  onScreenIds: string[],
  ctx: MacroContext
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
  const nowLine = (id: string | undefined, name: string): string => {
    const d = dossierOf(id, name);
    const os = id ? onScreenOf(id) : undefined;
    // ДВА РАЗНЫХ ПО СВЕЖЕСТИ ИСТОЧНИКА, и путать их нельзя. Присутствие на сцене
    // движок знает точно на этот ход. Статус/настроение/место — запись из досье,
    // сделанная когда-то и с тех пор не подтверждённая. Раньше они склеивались в
    // одну строку, и если персонаж стоял на сцене, отметка возраста пропадала —
    // «беременна» столетней давности выглядело как факт этого хода.
    const out: string[] = [];
    if (os) out.push(`Present in the scene right now (emotion: ${os.emotion}${os.outfit ? `, outfit: ${os.outfit}` : ''})`);
    const age = d?.updatedAtTurn && turnNow ? turnNow - d.updatedAtTurn : null;
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
      const stamp =
        age === null
          ? ' [age unknown — verify against the story]'
          : age <= 1
            ? ' [recorded this turn]'
            : ` [recorded ${age} turns ago — may be stale]`;
      out.push(`Last recorded: ${recorded.join('; ')}${stamp}`);
    }
    return out.join('\n');
  };

  const entries: string[] = [];
  const seen = new Set<string>();

  // 1) Персонажи проекта — с карточкой. В фокусе (на сцене + герой) карточка полная.
  const present = project.characters.filter((c) => onScreenIds.includes(c.id));
  const hero = project.characters.find((c) => c.role === 'protagonist' && !present.includes(c));
  const focus = hero ? [hero, ...present] : present;
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
      if (c.card.backstory.trim()) lines.push(`Backstory: ${expandMacros(c.card.backstory, ctx)}`);
      lines.push(`Speech: ${expandMacros(c.card.speechStyle, ctx)}`);
      if (c.card.relationshipArc) lines.push(`Arc: ${expandMacros(c.card.relationshipArc, ctx)}`);
    } else {
      lines.push(`Who they are: ${c.card.personality.slice(0, 110)}`);
    }
    const d = dossierOf(c.id, c.name);
    if (d?.roleToHero) lines.push(`To the hero: ${d.roleToHero}`);
    const ph = phoneNote(state, whoIs(c.id, c.name));
    if (ph) lines.push(ph);
    const now = nowLine(c.id, c.name);
    if (now) lines.push(now);
    if (c.role !== 'protagonist') {
      const r = rels[c.id] || c.relationship;
      lines.push(
        `Feelings toward the hero (ids for statChanges): ❤️ rel:${c.id}:affection=${r.affection}, 🔥 rel:${c.id}:passion_stat=${r.passion_stat}, 🍀 rel:${c.id}:friendship=${r.friendship}, 🎖 rel:${c.id}:respect=${r.respect} (range -100..100)`
      );
    }
    if (inFocus) {
      const emotions = Object.keys(c.sprites);
      lines.push(`Emotions available: ${emotions.length ? emotions.join(', ') : '(no sprites — render as name + text)'}`);
      if (hasExtraOutfits(c)) {
        lines.push(
          `Outfits — pick the tag matching the scene (default "${defaultOutfitTag(c)}"):\n${characterOutfits(c)
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
    if (d?.roleToHero) lines.push(`To the hero: ${d.roleToHero}`);
    const ph = phoneNote(state, whoIs(e.id, e.canonicalName));
    if (ph) lines.push(ph);
    const now = nowLine(e.id, e.canonicalName) || (e.status ? `Now: status: ${e.status}` : '');
    if (now) lines.push(now);
    entries.push(lines.join('\n'));
  }

  if (!entries.length) return '(no characters yet — introduce them via character_new)';

  return (
    entries.join('\n\n') +
    `\n\nHOW TO USE THIS SECTION — it is the ONLY roster; there is no second list of people anywhere.\n` +
    `- Identity is the id, never the bare name: nicknames drift ("Дэмиан"/"Дэм"/"парень из бара" are one person). ` +
    `Before introducing anyone, look here. Already present under any name or alias → reuse that id.\n` +
    `- "Now:" lines are a snapshot YOU maintain, and each carries its age. They are NOT eternal truth: if the recent ` +
    `messages or the episode log show something newer — a pregnancy that ended in a birth, a wound that healed, a move, ` +
    `a death — THE STORY WINS. Do not act on a stale line; describe the current reality and send the corrected value in ` +
    `worldState.characters this turn.\n` +
    `- Genuinely new person → {"type":"character_new",...}. Known person under a new nickname → ` +
    `{"type":"character_alias_add","id":"<existing id>","alias":"..."}. Situation changed → ` +
    `{"type":"character_update","id":"<id>","status":"..."}. Never create a second entry for the same person.`
  );
}

// Текущие спрайты на сцене с эмоцией и нарядом — чтобы модель вела непрерывность
// (держала эмоцию/наряд между ходами и меняла осознанно, а не заново угадывала).
function onScreenState(project: Project, state: RuntimeState): string {
  if (!state.onScreen.length) return 'nobody';
  return state.onScreen
    .map((s) => {
      const c = project.characters.find((x) => x.id === s.characterId);
      const name = c?.name || s.characterId;
      const bits = [`emotion: ${s.emotion}`];
      if (s.outfit) bits.push(`outfit: ${s.outfit}`);
      return `${name} (${s.characterId}; ${bits.join(', ')})`;
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

// Доля бюджета, которую вправе занять БЛОК ПАМЯТИ (журнал эпизодов + снапшот).
// Раньше потолка не было вообще: живую историю мы ограничили, а память росла
// бесконечно — каждая свёртка дописывает эпизод, снапшот пухнет, и системная часть
// в итоге перерастала весь бюджет. Тогда живая история зажималась в минимум, движок
// форсировал свёртку, свёртка добавляла ЕЩЁ один эпизод — и так по кругу.
const MEMORY_SHARE = 0.35;

// Ужимаем журнал под потолок: свежие эпизоды оставляем целиком (они важнее для
// продолжения), самые старые сокращаем до начала записи. Ничего не удаляем
// насовсем — полные тексты лежат в состоянии и правятся в Game Master → Саммари.
function fitChronicle(
  chronicle: { text: string; atTurn?: number }[],
  budgetTokens: number
): { text: string; trimmed: number } {
  const render = (c: { text: string; atTurn?: number }, i: number) =>
    `[Period ${i + 1}${c.atTurn ? `, up to turn ${c.atTurn}` : ''}]\n${c.text}`;
  const full = chronicle.map(render);
  let total = full.reduce((n, t) => n + estimateTokens(t), 0);
  if (total <= budgetTokens) return { text: full.join('\n\n'), trimmed: 0 };

  // Режем с самых старых, пока не влезем. Минимум — заголовок и первые строки,
  // чтобы хронология не рвалась и модель видела, что период был.
  const out = [...full];
  let trimmed = 0;
  for (let i = 0; i < out.length - 1 && total > budgetTokens; i++) {
    const short = `${render({ ...chronicle[i], text: chronicle[i].text.slice(0, 300) }, i)}\n… (запись сокращена, полный текст — в Game Master → Саммари)`;
    if (estimateTokens(short) >= estimateTokens(out[i])) continue;
    total -= estimateTokens(out[i]) - estimateTokens(short);
    out[i] = short;
    trimmed++;
  }
  return { text: out.join('\n\n'), trimmed };
}

async function memoryBlock(
  project: Project,
  state: RuntimeState,
  playerMove: string,
  skipVector?: boolean
): Promise<string> {
  const m = state.memory;
  const parts: string[] = [];
  // Потолок памяти в токенах. Снапшот приоритетнее журнала (он описывает «сейчас»),
  // поэтому сначала считаем его, а журналу отдаём остаток.
  const memBudget = Math.max(1500, Math.round((getPresetSettings().contextBudget || 80000) * MEMORY_SHARE));
  const snapTokens = m.storyState?.trim() ? estimateTokens(m.storyState) : 0;
  const chronBudget = Math.max(600, memBudget - Math.min(snapTokens, Math.round(memBudget * 0.6)));

  // Журнал эпизодов — хронологически, от старых к новым, с явной нумерацией периодов.
  if (m.chronicle.length) {
    const fitted = fitChronicle(m.chronicle, chronBudget);
    if (fitted.trimmed) {
      logEvent(
        'info',
        'prompt',
        `Журнал эпизодов не влезал в свою долю бюджета (~${chronBudget} ток.): ${fitted.trimmed} самых старых записей сокращены до начала. ` +
          `Полные тексты целы — уплотните журнал в Game Master → Саммари, если это мешает.`
      );
    }
    parts.push(
      `EPISODE LOG (chronological, oldest → newest; ALL of this has already happened — never contradict it and NEVER replay these events as if new):\n${fitted.text}`
    );
  }
  // Снапшот состояния — с ЯВНЫМ возрастом. Раньше он объявлял себя «положением дел
  // СЕЙЧАС» независимо от того, когда снят. Замороженный снапшот (обрыв ответа при
  // свёртке) описывал момент десятки ходов назад — и модель продолжала историю
  // оттуда: «ход идёт сразу после старого саммари», сюжет ходил по кругу.
  if (m.storyState?.trim()) {
    const at = m.storyStateAtTurn ?? 0;
    const age = at ? state.turnCount - at : null;
    const stamp =
      age === null
        ? 'taken at an unknown point'
        : age <= 0
          ? 'taken at the current turn'
          : `taken at turn ${at}; the story has since advanced to turn ${state.turnCount} — ${age} turn(s) of newer events happened AFTER it`;
    const warn =
      age !== null && age > 0
        ? ' Anything in the recent messages or the newest episode-log entries OVERRIDES this snapshot: continue from where the story is NOW, not from the situation described here.'
        : '';
    const snapCap = Math.round(memBudget * 0.6);
    let snapText = m.storyState.trim();
    if (estimateTokens(snapText) > snapCap) {
      // Обрезаем по границе секции, чтобы не оборвать на полуслове.
      const keep = Math.round(snapText.length * (snapCap / estimateTokens(snapText)));
      const cut = snapText.slice(0, keep);
      const lastSection = cut.lastIndexOf('\n##');
      snapText = (lastSection > keep * 0.5 ? cut.slice(0, lastSection) : cut) + '\n… (снапшот сокращён под бюджет — пересоберите его в Game Master → Саммари)';
      logEvent(
        'info',
        'prompt',
        `Снапшот состояния больше своей доли бюджета (~${snapCap} ток.) — в запрос ушла сокращённая версия. ` +
          `Нажмите «пересобрать» в Game Master → Саммари или уменьшите лимит токенов саммари.`
      );
    }
    parts.push(
      `STORY STATE SNAPSHOT (${stamp}) — background on who is who, relationships and open threads.${warn}\n${snapText}`
    );
  }
  if (m.liveSummary.trim()) {
    parts.push(`CURRENT ARC NOTE (from the author):\n${m.liveSummary}`);
  }
  if (m.facts.length) {
    const facts = m.facts
      .slice(-40)
      .map((f) => `[turn ${f.turn}] ${f.text}`)
      .join('; ');
    parts.push(`KEY DECISIONS AND FACTS (canon — do not distort):\n${facts}`);
  }

  // Меморибук: закреплённые записи всегда, остальные — последние по времени.
  const pinned = m.memorybook.filter((e) => e.pinned);
  const recent = m.memorybook.filter((e) => !e.pinned).slice(-10);
  const mb = [...pinned, ...recent];
  if (mb.length) {
    parts.push(`MEMORYBOOK (important events so far):\n${mb.map((e) => `- ${e.text}`).join('\n')}`);
  }

  // Векторный подсос релевантного из свёрнутого сырого архива (см. §E3).
  if (!skipVector && project.memoryConfig.vectorization !== 'off' && m.rawArchive.length) {
    const corpus = m.rawArchive.map((r, i) => ({ id: String(i), text: r.text }));
    const hits = await retrieveRelevant(project, playerMove, corpus, 3);
    if (hits.length) {
      parts.push(
        `RELEVANT FROM THE PAST (matched to the player move):\n${hits
          .map((h) => `- ${h.text.slice(0, 400)}`)
          .join('\n')}`
      );
    }
  }

  return parts.join('\n\n') || '(memory is empty — this is the start of the story)';
}

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
      `The story began on ${gm.clock.startDate} — ${elapsed} of in-story time have passed since then.\n` +
        `APPLY THAT ELAPSED TIME to everyone and everything, every turn: ages advance (someone who was 20 at the start ` +
        `is now ${elapsed} older), children grow up and can walk and talk, wounds and pregnancies have long resolved, ` +
        `jobs, homes and relationships have moved on, seasons turned. A character card describes who someone WAS when ` +
        `it was written — add the elapsed time yourself instead of replaying the beginning.`
    );
  }
  if (gm.relations.length) {
    parts.push(
      `Relationship grid:\n${gm.relations.map((r) => `- ${r.from} → ${r.to}: ${r.label}`).join('\n')}`
    );
  }
  if (gm.locations?.length) {
    parts.push(
      `Known locations (keep descriptions consistent):\n${gm.locations
        .map((l) => `- ${l.name}${l.description ? `: ${l.description}` : ''}${l.tags.length ? ` [${l.tags.join(', ')}]` : ''}`)
        .join('\n')}`
    );
  }
  const openTasks = gm.agenda.filter((t) => !t.done);
  if (openTasks.length) {
    parts.push(`Open agenda (unresolved — still to happen):\n${openTasks.map((t) => `- ${t.text}`).join('\n')}`);
  }
  // Завершённые арки/задачи — чтобы ИИ НЕ повторял уже пройденное (фикс памяти).
  const doneTasks = gm.agenda.filter((t) => t.done).slice(-12);
  if (doneTasks.length) {
    parts.push(
      `Already resolved / DONE (do NOT replay these as if they haven't happened):\n${doneTasks.map((t) => `- ${t.text}`).join('\n')}`
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
        `MILESTONES (major turning points — these NEVER scroll out of view; the story is past them, never undo or replay them):\n${always
          .slice(-20)
          .map(line)
          .join('\n')}`
      );
    }
    if (ordinary.length) {
      parts.push(`Recent events (chronological — these already happened):\n${ordinary.map(line).join('\n')}`);
    }
  }

  return parts.length
    ? parts.join('\n\n')
    : '(no game-master state yet — establish it via worldState this turn)';
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
      'Current date, time and place are given ONCE, in the STATE RIGHT NOW block at the very end of this request. ' +
        'That block is the only authoritative copy — do not reconstruct time or place from anything above it.'
    );
  }

  // Проектные статы с ТЕКУЩИМИ значениями и точными id — чтобы модель могла и читать,
  // и обновлять их через statChanges (частая жалоба: «в тексте стат вырос, в статах нет»).
  if (hasStats) {
    parts.push(
      `PROJECT STATS (update these via statChanges using the EXACT statId; if your narration says one of them changed, you MUST emit the matching statChange this same turn):\n${project.stats
        .map((s) => {
          const v = state.statValues[s.id] ?? s.initial;
          return `  - statId: ${s.id} | "${s.name}" = ${v} (${s.min}..${s.max})${s.description ? ` — ${s.description}` : ''}`;
        })
        .join('\n')}`
    );
  }

  // Экономика.
  if (hasEconomy && typeof bal === 'number') {
    const debt = bal < 0 ? ' — THE HERO IS IN DEBT (negative balance): weave this into the story as a real pressure.' : '';
    parts.push(`Balance: ${bal} ${cur}.${debt}`);
    const pg = project.phone?.priceGuide?.trim();
    if (pg) parts.push(`Price guide (keep all amounts in this order of magnitude, consistent between turns): ${pg}`);
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
      `INVENTORY — everything the hero owns, and the ONLY truth about it:\n${inv
        .map((it) => `  - ${it.emoji} ${it.name}${it.quantity > 1 ? ` ×${it.quantity}` : ''}`)
        .join('\n')}`
    );
  } else {
    parts.push('INVENTORY: empty — the hero carries nothing.');
  }

  // Когда протагонист последний раз виделся с персонажами (Batch 8 §VI) — чтобы ИИ
  // отражал разлуку («давно не виделись»). Только для тех, у кого дата известна.
  if (hasDate) {
    const seen = state.gm.characters
      .filter((c) => c.lastSeenDate)
      .map((c) => `${c.name}: ${c.lastSeenDate}`);
    if (seen.length) parts.push(`Last seen (today is ${clock.date}): ${seen.join('; ')}`);
  }

  // Правила.
  const rules: string[] = [
    'This block is the engine\'s RECORD of the world, kept by you. Treat numbers and possessions as authoritative (never let the hero use an item they do not have or spend money they lack) and reflect it in the scene: characters notice the hero\'s clothing, remember when they last met, react to wealth or debt.',
    // Место/время — самая частая рассинхронизация: их обновляет сама модель через
    // worldState, и если она забыла, запись остаётся старой. Раньше блок объявлял
    // себя «авторитетным» целиком, и модель возвращала героя в прежний город,
    // противореча уже сыгранным сценам. Теперь на месте/времени сюжет главнее.
    'DATE, TIME AND LOCATION are only as fresh as your last update. If the story (recent turns, memory, the episode log) says the hero has since moved elsewhere or time has passed, the STORY WINS: continue from where the story actually is and CORRECT this record the same turn — never drag the hero back to the location written here.',
    'WHENEVER the hero changes place — a trip, a flight, moving to another room, city or country — emit the control beat {"type":"location_change","location":"<where they are NOW>"} at that point in the beat flow. This is mandatory, not optional bookkeeping: without it the engine keeps showing the old place to you and to the player, and the story gets dragged back there.',
    'TIME (MANDATORY, same weight as the story text): the in-story date is always DD/MM/YYYY. ' +
      'Whenever time moves — a night passes, "a week later", "three years later", a montage, a jump — you MUST emit ' +
      '{"type":"time_advance","newDate":"DD/MM/YYYY","newTime":"HH:MM"} with the NEW date. ' +
      'Writing the jump only in prose is NOT enough: the engine keeps its own clock, and if you skip this beat the clock ' +
      'stays frozen at the old date. A few turns later the frozen clock is all that is left in context, and the story ' +
      'silently rewinds to before the skip — characters un-age, events un-happen. Never write a date in any other format.',
    'MONEY MOVES THROUGH THE TRANSACTION BEAT ONLY. Never also put the same amount into statChanges on the balance stat — the engine would apply both and charge the hero twice. One purchase = one beat.',
    'INVENTORY (same weight as the story text): the hero owns exactly what the list above says — nothing more. ' +
      'The moment the story gives them something, emit {"type":"inventory_add","name":"<short plain name>","emoji":"<one emoji>","quantity":1,"category":...,"source":"куплено|получено|найдено"}; ' +
      'the moment they eat, spend, lose, break or hand something over, emit {"type":"inventory_remove","name":...,"quantity":1}. ' +
      'A change you only narrated and did not send as a beat DID NOT HAPPEN: the engine keeps its own list, and next turn you will read the old one back. ' +
      'For inventory_remove copy the name EXACTLY as it stands in the list above — that is how the engine finds the thing. ' +
      'Never invent an item the hero does not have, and never re-add something they already carry.',
  ];
  if (hasEconomy) {
    rules.push(
      'MONEY: when the hero spends or receives money, emit {"type":"transaction","amount":<neg to spend / pos to receive>,"vendor":"<where/from whom>","item":"<what for>","time":"HH:MM"} — vendor/item/time are required (they form the bank statement). Do NOT also mirror it in statChanges.',
      'ZERO/LOW BALANCE: check the balance before a purchase. If the hero cannot afford it, do NOT emit a negative transaction for that purchase — write the scene with the shortfall (declined card, no cash). Recurring bills may still push the balance negative into debt.'
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
    'The hero carries a smartphone. Phone control beats (no display text):',
    '  - {"type":"sms_incoming","characterId":"<id>","text":"<message>"} — a known character texts the hero off-screen (appears in Messages).',
    '  - {"type":"contact_added","characterId":"<id>"} — the hero saves someone\'s number (characters who appear are auto-added; use only for someone met off-screen).',
    '  - {"type":"sms_photo","characterId":"<id>","caption":"<what they write with it>","photo":"<what the photo shows, from THEIR side: a selfie, their room, the street they are on>"} — a character sends the hero a PHOTO. The engine draws it. Use it when someone would naturally snap something (showing off, proof, a view, a joke); the caption is optional.',
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
      'RECENT TEXT MESSAGES (these already happened on the phone — both sides remember them; ' +
        'treat them as canon, refer back to them naturally, and do NOT replay them as new):\n' +
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
}

export async function buildRequest(
  project: Project,
  state: RuntimeState,
  playerMove: string,
  opts?: { skipVector?: boolean; extraDirective?: string; preview?: boolean }
): Promise<BuiltRequest> {
  const cfg = project.aiConfig;
  const ps = getPresetSettings(); // ГЛОБАЛЬНЫЙ пресет/настройки генерации (не на проект)
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
    characters: () => `== WHO'S WHO (single roster: identity + card + current state) ==\n${whoIsWhoBlock(project, state, onScreenIds, ctx)}`,
    manifest: () => `== ASSET MANIFEST ==\n${assetManifest(project)}`,
    state: () =>
      `== CURRENT STATE ==\nStats:\n${statsState(project, state.statValues)}\nCurrent background: ${currentBg} (${
        state.currentBackgroundId ?? 'null'
      })\nMusic mood: ${state.currentMusicMood ?? 'none'}`,
    memory: async () => `== MEMORY ==\n${await memoryBlock(project, state, playerMove, opts?.skipVector)}`,
    gamemaster: () => gameMasterBlock(state, state.turnCount),
    // История вставляется как СООБЩЕНИЯ, а не текст: обработчик выше перехватывает
    // этот блок раньше и запоминает позицию. Заглушка нужна лишь для полноты типа.
    history: () => '',
  };

  // Собираем промпт из редактируемого пресета (Batch 3 §8): по порядку, только
  // включённые блоки; статичные — их текст (с макросами), динамические — от движка.
  // Роль блока (как в Таверне): 'system' идёт в системный промпт; 'user'/'assistant'
  // становятся отдельными сообщениями ПЕРЕД живой историей.
  const preset = ps.preset;
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
    if (role === 'system') systemParts.push(text);
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
    'world', 'plot', 'lorebook', 'characters', 'manifest', 'state', 'gamemaster', 'memory',
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
  const tl = ps.turnLength || DEFAULT_TURN_LENGTH;
  systemParts.push(
    `TURN LENGTH & BEAT SIZE (authoritative — overrides any other length/beat guidance above): land the turn WITHIN ${tl.min}–${tl.max} words TOTAL — that is the target, do NOT overshoot it; once you reach a natural pause inside the range, stop rather than padding. Split the turn into medium beats: each beat a readable 1–3 sentence chunk (a short paragraph) — never a wall of text, never a bare one-liner. Fill the range with the NUMBER of medium beats, not by inflating any single beat. Keep a real mix of dialogue and narration: characters who are present must actually SPEAK — emit "dialogue" beats with that character's characterId (a dialogue beat with a valid characterId is what puts the character's sprite on screen), interleaved with narration/thought.`
  );
  // Частота выборов. По умолчанию (gap = 0) выборы обязательны КАЖДЫЙ ход — иначе
  // игрок упирается в экран без вариантов. Ползунок в пресете (gap > 0) — осознанный
  // отказ пользователя от этого: тогда просим модель придерживать выборы.
  const gap = ps.choiceMinGap ?? 0;
  systemParts.push(
    gap > 0
      ? `CHOICE FREQUENCY (authoritative): offer a choices block at most about once every ${gap} turns. On all other turns return choices: [] and let the player type. Only surface choices at a real decision point.`
      : `CHOICES (authoritative — overrides any other guidance above): EVERY turn ends with 2–4 choices. Returning an empty choices array is never acceptable, not even on a quiet or transitional turn — there is always something to choose between (speak / stay silent / leave / look closer / change the subject). Write them from the hero's side, meaningfully different in intent or tone, actions in *italics*, no move tags, no bare "Continue".`
  );
  // Язык повествования (пресет). Управляет языком ТЕКСТА истории; ключи JSON и
  // id/настроения ассетов остаются английскими.
  const narr = ps.narrativeLanguage === 'en' ? 'English' : 'Russian (русский)';
  systemParts.push(
    `NARRATIVE LANGUAGE (authoritative): write ALL story text — narration, thoughts, character dialogue and choice texts — in ${narr}, regardless of the language of these instructions or of the character cards. Do NOT translate JSON keys, character ids, emotion keys, outfit tags, music moods or background ids — those stay exactly as given.`
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
    `=== HOW THIS CONTEXT IS ORDERED (read before answering) ===
` +
      `Everything ABOVE is background: world, characters, and MEMORY of what happened EARLIER — ` +
      `the episode log runs oldest → newest, and the story-state snapshot describes where things stood at the LAST fold, not necessarily now.
` +
      `The messages that FOLLOW are the recent story itself, verbatim and in chronological order. They are NEWER than everything above. ` +
      `The final user message is the player's move you must answer now.
` +
      `If the recent messages contradict the background — someone travelled, an item changed hands, time passed, a relationship shifted — ` +
      `THE RECENT MESSAGES WIN. Continue from them and correct the record; never rewind the story to an older state described above.`
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
  let window: LlmMessage[] = state.history.slice(-histCap).map((m) =>
    m.role === 'assistant'
      ? { role: 'assistant' as const, content: condenseAssistantTurn(m.content, project, state) ?? m.content }
      : m
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
  let strippedLead = 0;
  while (window.length && window[0].role === 'assistant') {
    window = window.slice(1);
    strippedLead++;
  }
  if (strippedLead) {
    logEvent('info', 'prompt', `Срезан висящий ответ ИИ в начале окна (${strippedLead}) — история должна открываться ходом игрока`);
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
  const blocks = (ps.advancedBlocks || []).filter((b) => b.content.trim());
  const withMove: LlmMessage[] = [...messages, { role: 'user', content: playerMove }];
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
  const clockNow = formatClock(state.gm.clock);
  if (clockNow) {
    const el = elapsedPhrase(state.gm.clock.startDate, state.gm.clock.date);
    nowBits.push(`Date/time/place: ${clockNow}${el ? ` (${el} since the story began)` : ''}`);
  }
  const locAt = state.gm.clock.locationAtTurn ?? 0;
  const locAge = locAt ? state.turnCount - locAt : null;
  if (locAge !== null && locAge > 2) {
    nowBits.push(
      `(the place above was recorded ${locAge} turns ago — if the story has moved since, THE STORY WINS: continue from where it actually is and emit location_change)`
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
      `[STATE RIGHT NOW — the freshest values the engine has, they override anything older above]\n${nowBits.join('\n')}`
    );
  }

  // Заметки для ИИ (Author's Note, см. CR v2 §M): универсальные + проектные.
  // Пометка приоритета обязательна: заметка соревнуется с планом (plotOutline,
  // адженда, крючки снапшота) и без явного «перекрывает» проигрывала ему.
  const notes = [...getGlobalNotes(), ...state.authorNotes].filter((n) => n.text.trim());
  if (notes.length) {
    tail.push(
      '[AUTHOR NOTES — HIGHEST PRIORITY] The following directions come from the player and OVERRIDE ' +
        'the plot outline, the open agenda, any plot hooks in memory and your own plans. A prohibition here ' +
        'applies now and in later turns until the player changes it — never satisfy it indirectly ' +
        '(through another character, a near-miss, a dream or a conversation about it):\n' +
        notes.map((n) => `- ${expandMacros(n.text, ctx)}`).join('\n')
    );
  }

  // Скрытая директива случайного события/СМС/реролла — игрок её не видит и она НЕ
  // сохраняется в истории (buildRequest собирает сообщения заново каждый ход).
  if (opts?.extraDirective?.trim()) tail.push(opts.extraDirective.trim());

  // Ремайндер формата + длины — последним в блоке.
  const lengthReminder = `Stay WITHIN ~${tl.min}–${tl.max} words (do not overshoot) as medium beats of 1–3 sentences each — mix dialogue (with the speaking character's characterId, so their sprite shows) and narration. No walls of text, no bare one-liners.`;

  // Управляемое размышление: короткий план в <thinking> вместо медленной родной
  // «думалки». Префилл открывает тег, инструкция задаёт короткий шаблон плана,
  // после закрытия тега — только JSON. Парсер вырезает <thinking>…</thinking>.
  let prefill = ps.prefill?.trim() || undefined;
  if (ps.guidedThinking) {
    const plan = (ps.thinkingPlan?.trim() || DEFAULT_THINKING_PLAN);
    tail.push(
      `REASONING PROTOCOL: Do ALL planning ONLY inside a single <thinking></thinking> block at the very start of your reply, and keep it SHORT — a brief bullet per line following this template, nothing more:\n${plan}\nThen immediately close </thinking> and output the ONE JSON object per the schema and nothing after it.\n${lengthReminder}\n${FORMAT_REMINDER}`
    );
    prefill = '<thinking>\n';
  } else {
    tail.push(`${FORMAT_REMINDER}\n${lengthReminder}`);
  }

  withMove.push({
    role: 'user',
    content:
      `(Engine directives for THIS turn. Reply to the player's move ABOVE — this block only constrains how.)\n\n` +
      tail.join('\n\n'),
  });

  return { system, messages: withMove, prefill, droppedUnfolded: dropped, fixedTokens, systemOverBudget: overloaded };
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
