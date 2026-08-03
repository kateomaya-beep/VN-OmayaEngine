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
import { expandMacros, type MacroContext } from './macros';
import { retrieveRelevant } from './vectorEngine';
import { buildRegistryView, registryContextBlock } from './characterRegistry';
import { estimateTokens } from '../shared/utils';

// Builds the full request as a system string (layered core → style → jailbreak →
// dynamic context) plus the live-window history and the player's move.

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

function characterBlocks(
  project: Project,
  onScreenIds: string[],
  ctx: MacroContext
): string {
  const roleLabel: Record<string, string> = {
    protagonist: "PLAYER'S HERO",
    love_interest: 'love interest',
    important_character: 'important character',
    npc: 'minor',
  };
  const rels = ctx.state?.relationship || {};
  const relLine = (c: (typeof project.characters)[number]) => {
    if (c.role === 'protagonist') return '';
    const r = rels[c.id] || c.relationship;
    return `\nRelationship toward the hero (ids for statChanges): ❤️ rel:${c.id}:affection=${r.affection}, 🔥 rel:${c.id}:passion_stat=${r.passion_stat}, 🍀 rel:${c.id}:friendship=${r.friendship}, 🎖 rel:${c.id}:respect=${r.respect} (range -100..100)`;
  };
  const desc = (c: (typeof project.characters)[number]) => {
    const emotions = Object.keys(c.sprites);
    const emo = emotions.length ? emotions.join(', ') : '(no sprites — render as name + text)';
    // Наряды (Batch 5.3): показываем строку только если у персонажа есть выбор
    // (>1 наряда). Каждый наряд — с его триггером-описанием (когда его надевать),
    // чтобы модель уверенно мапила сцену на тег (напр. «в белье» → underwear).
    const outfitLine = hasExtraOutfits(c)
      ? `\nAvailable outfits — set "outfit" to the tag whose situation matches the scene (default when nothing special: "${defaultOutfitTag(
          c
        )}"):\n${characterOutfits(c)
          .map((tag) => {
            if (tag === defaultOutfitTag(c)) return `  - ${tag} (default everyday look)`;
            const desc = c.outfits?.find((o) => o.outfit === tag)?.description?.trim();
            return `  - ${tag}${desc ? ` — use when: ${desc}` : ''}`;
          })
          .join('\n')}`
      : '';
    // Внешность/предыстория — опциональные поля (могут быть пустыми, если всё в описании).
    const appLine = c.card.appearance.trim() ? `\nAppearance: ${expandMacros(c.card.appearance, ctx)}` : '';
    const backLine = c.card.backstory.trim() ? `\nBackstory: ${expandMacros(c.card.backstory, ctx)}` : '';
    return `### ${c.name} (id: ${c.id}, role: ${roleLabel[c.role] || c.role})
Description: ${expandMacros(c.card.personality, ctx)}${appLine}${backLine}
Speech style: ${expandMacros(c.card.speechStyle, ctx)}${
      c.card.relationshipArc ? `\nRelationship arc: ${expandMacros(c.card.relationshipArc, ctx)}` : ''
    }${relLine(c)}
Available emotions: ${emo}${outfitLine}`;
  };

  const present = project.characters.filter((c) => onScreenIds.includes(c.id));
  const protagonist = project.characters.find(
    (c) => c.role === 'protagonist' && !present.includes(c)
  );
  const fullList = protagonist ? [protagonist, ...present] : present;
  const others = project.characters.filter(
    (c) => !fullList.includes(c)
  );

  let out = '';
  if (fullList.length) out += `Characters in focus (full cards):\n${fullList.map(desc).join('\n\n')}\n`;
  if (others.length) {
    out += `\nOther characters (brief):\n${others
      .map((c) => `- ${c.name} (id: ${c.id}, ${c.role}): ${c.card.personality.slice(0, 80)}`)
      .join('\n')}`;
  }
  if (!fullList.length && !others.length) {
    out = '(no predefined characters — introduce NPCs via name)';
  }
  return out;
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

async function memoryBlock(
  project: Project,
  state: RuntimeState,
  playerMove: string,
  skipVector?: boolean
): Promise<string> {
  const m = state.memory;
  const parts: string[] = [];
  // Журнал эпизодов — хронологически, от старых к новым, с явной нумерацией периодов.
  if (m.chronicle.length) {
    parts.push(
      `EPISODE LOG (chronological, oldest → newest; ALL of this has already happened — never contradict it and NEVER replay these events as if new):\n${m.chronicle
        .map((c, i) => `[Period ${i + 1}${c.atTurn ? `, up to turn ${c.atTurn}` : ''}]\n${c.text}`)
        .join('\n\n')}`
    );
  }
  // Живой снапшот состояния — единственное «текущее положение дел».
  if (m.storyState?.trim()) {
    parts.push(`CURRENT STORY STATE (authoritative living snapshot — the single source of truth for where things stand NOW):\n${m.storyState.trim()}`);
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
function gameMasterBlock(state: RuntimeState): string {
  const gm = state.gm;
  const parts: string[] = [];
  const clockStr = formatClock(gm.clock);
  if (clockStr) parts.push(`Now: ${clockStr}`);
  if (gm.characters.length) {
    const lines = gm.characters.map((c) => {
      const bits = [
        c.roleToHero && `to hero: ${c.roleToHero}`,
        c.status && `status: ${c.status}`,
        c.mood && `mood: ${c.mood}`,
        c.outfit && `outfit: ${c.outfit}`,
        c.location && `at: ${c.location}`,
      ].filter(Boolean);
      const tags = c.tags.length ? ` [${c.tags.join(', ')}]` : '';
      const dossier = c.dossier ? ` — ${c.dossier}` : '';
      return `- ${c.name}${dossier}${bits.length ? ` (${bits.join('; ')})` : ''}${tags}`;
    });
    parts.push(`Characters (dossiers):\n${lines.join('\n')}`);
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
    const recent = gm.events.slice(-12);
    parts.push(
      `Recent events (chronological — these already happened):\n${recent
        .map((e) => `- ${e.date ? `[${e.date}] ` : `[t${e.turn}] `}${e.summary}${e.chars.length ? ` (${e.chars.join(', ')})` : ''}`)
        .join('\n')}`
    );
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

  // Время/место.
  const when = [clock.date, clock.time].filter(Boolean).join(', ');
  if (when) parts.push(`Date/time: ${when}`);
  if (clock.location) parts.push(`Location: ${clock.location}`);

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

  // Инвентарь.
  if (inv.length) {
    parts.push(
      `Inventory: ${inv.map((it) => `${it.emoji} ${it.name}${it.quantity > 1 ? ` (${it.quantity})` : ''}`).join(', ')}`
    );
  } else {
    parts.push('Inventory: (empty)');
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
    'This state is AUTHORITATIVE — do not contradict it. Reflect it: characters notice the hero\'s clothing, remember when they last met, react to wealth or debt. Never let the hero use an item they do not have.',
    'TIME: the in-story date is always DD/MM/YYYY. When time passes (a night, "a week later", a jump), emit {"type":"time_advance","newDate":"DD/MM/YYYY","newTime":"HH:MM"}. Never write a date in any other format.',
    'INVENTORY: emit {"type":"inventory_add","name":...,"emoji":"<one emoji>","quantity":1,"category":...,"source":"куплено|получено|найдено"} when the hero acquires something meaningful, and {"type":"inventory_remove","name":...,"quantity":1} when they consume/lose/give it away. Consumables are really spent.',
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

// Телефон-коммуникации (Batch 7): контакты, входящие СМС, заказы доставки. Деньги/
// прайс-гайд теперь в WORLD STATE. Возвращаем '' если телефон выключен.
function phoneBlock(project: Project, state: RuntimeState): string {
  const cfg = project.phone;
  if (!cfg?.enabled) return '';
  const contacts = (state.phone?.contacts || [])
    .filter((c) => !c.hidden)
    .map((c) => {
      const nm = project.characters.find((x) => x.id === c.characterId)?.name || c.characterId;
      return `${nm} (${c.characterId})`;
    });
  const parts = [
    'The hero carries a smartphone. Phone control beats (no display text):',
    '  - {"type":"sms_incoming","characterId":"<id>","text":"<message>"} — a known character texts the hero off-screen (appears in Messages).',
    '  - {"type":"contact_added","characterId":"<id>"} — the hero saves someone\'s number (characters who appear are auto-added; use only for someone met off-screen).',
  ];
  if (contacts.length) parts.push(`Saved phone contacts: ${contacts.join(', ')}.`);

  // ПЕРЕПИСКА — часть сюжета. Без этого блока всё, что игрок написал персонажу в
  // мессенджере, для основного движка не существовало: следующий ход шёл так,
  // будто разговора не было. Берём последние сообщения по всем веткам в
  // хронологическом порядке (по времени), помечая их как уже произошедшие.
  const heroName = state.protagonistName || 'the hero';
  const chatLines: { at: number; line: string }[] = [];
  for (const [charId, msgs] of Object.entries(state.phone?.conversations || {})) {
    const nm = project.characters.find((x) => x.id === charId)?.name || charId;
    for (const m of msgs) {
      const body = m.text?.trim() || (m.attachedAssetId ? '[sent a photo]' : '');
      if (!body) continue;
      chatLines.push({
        at: m.at || 0,
        line: `  ${m.from === 'protagonist' ? `${heroName} → ${nm}` : `${nm} → ${heroName}`}: ${body.slice(0, 200)}`,
      });
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
  const orders = state.phone?.activeOrders || [];
  if (orders.length) {
    parts.push(
      `PENDING DELIVERIES (ordered via a delivery app — have them arrive in the story naturally, then move on): ${orders
        .map((o) => `${o.name} (${o.category})`)
        .join(', ')}.`
    );
  }
  return `== PHONE ==\n${parts.filter(Boolean).join('\n')}`;
}

export interface BuiltRequest {
  system: string;
  messages: LlmMessage[];
  prefill?: string;
}

export async function buildRequest(
  project: Project,
  state: RuntimeState,
  playerMove: string,
  opts?: { skipVector?: boolean; extraDirective?: string }
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
    characters: () => `== CHARACTERS ==\n${characterBlocks(project, onScreenIds, ctx)}`,
    manifest: () => `== ASSET MANIFEST ==\n${assetManifest(project)}`,
    state: () =>
      `== CURRENT STATE ==\nStats:\n${statsState(project, state.statValues)}\nCurrent background: ${currentBg} (${
        state.currentBackgroundId ?? 'null'
      })\nMusic mood: ${state.currentMusicMood ?? 'none'}\nOn screen (current emotion & outfit — keep them unless the scene changes): ${onScreenState(
        project,
        state
      )}`,
    memory: async () => `== MEMORY ==\n${await memoryBlock(project, state, playerMove, opts?.skipVector)}`,
    gamemaster: () => gameMasterBlock(state),
  };

  // Собираем промпт из редактируемого пресета (Batch 3 §8): по порядку, только
  // включённые блоки; статичные — их текст (с макросами), динамические — от движка.
  // Роль блока (как в Таверне): 'system' идёт в системный промпт; 'user'/'assistant'
  // становятся отдельными сообщениями ПЕРЕД живой историей.
  const preset = ps.preset;
  const systemParts: string[] = [];
  const presetMessages: LlmMessage[] = [];
  const renderedDynamics = new Set<DynamicSource>();
  for (const block of preset.blocks) {
    if (!block.enabled) continue;
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

  // ГАРАНТИЯ ДВИЖКОВЫХ БЛОКОВ (фикс «память не инжектится»): если в пресете нет
  // (или отключён) какой-то из динамических блоков — например, пресет импортирован
  // из Таверны и содержит только статичный текст, — мир/персонажи/манифест/состояние/
  // ПАМЯТЬ выпадали из контекста целиком. Теперь недостающие блоки добавляются
  // движком всегда, в каноническом порядке; пресет управляет их положением и
  // текстом ВОКРУГ, но не может молча лишить ИИ память или манифест.
  const REQUIRED_DYNAMICS: DynamicSource[] = [
    'world', 'plot', 'lorebook', 'characters', 'manifest', 'state', 'gamemaster', 'memory',
  ];
  const missing = REQUIRED_DYNAMICS.filter((k) => !renderedDynamics.has(k));
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
  const regView = buildRegistryView(project, state.gm);
  const regBlock = registryContextBlock(regView);
  if (regBlock) {
    systemParts.push(
      `${regBlock}\n\nCHARACTER IDENTITY — CRITICAL:\n` +
        `- The Character Registry above is the single source of truth for who exists.\n` +
        `- Before introducing or describing anyone, check the registry. If the person already exists under ANY name or alias, reuse their existing id — do NOT invent a second character for the same person (names drift: "Дэмиан"/"Дэм"/"Блэк"/"парень из бара" are one person).\n` +
        `- Emit {"type":"character_new","canonicalName":...,"aliases":[...],"role":...} ONLY for a genuinely new person absent from the registry. If they are already known under a new nickname, emit {"type":"character_alias_add","id":"<existing id>","alias":"<nickname>"} instead.\n` +
        `- When a known character's situation changes, emit {"type":"character_update","id":"<id>","status":"..."} — never create a second entry for the same person.`
    );
  }

  // Единый WORLD STATE (Batch 8) — дата/деньги/долг/инвентарь + правила.
  const worldCtx = worldStateBlock(project, state);
  if (worldCtx) systemParts.push(worldCtx);
  // Телефон-коммуникации (Batch 7) — только если расширение включено.
  const phoneCtx = phoneBlock(project, state);
  if (phoneCtx) systemParts.push(phoneCtx);
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
  const MIN_WINDOW = 4; // минимум 2 хода живой истории — иначе теряется связность
  let winTokens = window.reduce((n, m) => n + estimateTokens(m.content), 0);
  let dropped = 0;
  while (window.length > MIN_WINDOW && fixedTokens + winTokens > budget) {
    winTokens -= estimateTokens(window[0].content);
    window = window.slice(1);
    dropped++;
  }
  // Первым в диалоге должно идти сообщение игрока: Gemini (и часть шлюзов) отвечают
  // 400/пустотой, если история начинается с assistant. Срез сверху может оставить
  // «висящий» ответ ИИ — убираем его.
  while (window.length && window[0].role === 'assistant') {
    window = window.slice(1);
    dropped++;
  }
  if (dropped) {
    logEvent(
      'info',
      'prompt',
      `Контекст ужат под бюджет ${budget} ток.: убрано ${dropped} старых сообщений (осталось ${window.length})`
    );
  }

  const messages: LlmMessage[] = [...presetMessages, ...window];

  // Продвинутые кастомные вставки на заданной глубине от конца (author's note style).
  const blocks = (ps.advancedBlocks || []).filter((b) => b.content.trim());
  const withMove: LlmMessage[] = [...messages, { role: 'user', content: playerMove }];
  for (const b of blocks) {
    const depth = Math.max(0, Math.floor(b.depth));
    const insertAt = Math.max(0, withMove.length - depth);
    withMove.splice(insertAt, 0, { role: 'user', content: expandMacros(b.content, ctx) });
  }

  // Заметки для ИИ (Author's Note, см. CR v2 §M) — слот глубины 0, свой UI.
  // Две категории: УНИВЕРСАЛЬНЫЕ (общие для всех проектов, из localStorage) идут
  // первыми как постоянные правила подачи, затем ПРОЕКТНЫЕ (из сейва) — они
  // конкретнее и стоят ближе к ходу, поэтому весят больше. Пусто — не инжектится.
  const notes = [...getGlobalNotes(), ...state.authorNotes].filter((n) => n.text.trim());
  if (notes.length) {
    // Пометка приоритета обязательна: заметка соревнуется с планом (plotOutline,
    // адженда, крючки снапшота), и без явного «перекрывает» модель раз за разом
    // возвращалась к запланированному событию, несмотря на запрет игрока.
    withMove.push({
      role: 'user',
      content:
        '[AUTHOR NOTES — HIGHEST PRIORITY] The following directions come from the player and OVERRIDE ' +
        'the plot outline, the open agenda, any plot hooks in memory and your own plans. A prohibition here ' +
        'applies now and in later turns until the player changes it — never satisfy it indirectly ' +
        '(through another character, a near-miss, a dream or a conversation about it):\n' +
        notes.map((n) => `- ${expandMacros(n.text, ctx)}`).join('\n'),
    });
  }

  // Скрытая директива случайного события (Batch 6 §3) — игрок её не видит и она НЕ
  // сохраняется в истории (buildRequest собирает сообщения заново каждый ход).
  if (opts?.extraDirective?.trim()) {
    withMove.push({ role: 'user', content: opts.extraDirective });
  }

  // Ремайндер формата + длины на глубине 0 (в самый конец) — модели сильнее
  // весят последнее сообщение, поэтому длину дублируем здесь.
  const lengthReminder = `Stay WITHIN ~${tl.min}–${tl.max} words (do not overshoot) as medium beats of 1–3 sentences each — mix dialogue (with the speaking character's characterId, so their sprite shows) and narration. No walls of text, no bare one-liners.`;

  // Управляемое размышление: короткий план в <thinking> вместо медленной родной
  // «думалки». Префилл открывает тег, инструкция задаёт короткий шаблон плана,
  // после закрытия тега — только JSON. Парсер вырезает <thinking>…</thinking>.
  let prefill = ps.prefill?.trim() || undefined;
  if (ps.guidedThinking) {
    const plan = (ps.thinkingPlan?.trim() || DEFAULT_THINKING_PLAN);
    withMove.push({
      role: 'user',
      content: `REASONING PROTOCOL: Do ALL planning ONLY inside a single <thinking></thinking> block at the very start of your reply, and keep it SHORT — a brief bullet per line following this template, nothing more:\n${plan}\nThen immediately close </thinking> and output the ONE JSON object per the schema and nothing after it.\n${lengthReminder}\n${FORMAT_REMINDER}`,
    });
    prefill = '<thinking>\n';
  } else {
    withMove.push({ role: 'user', content: `${FORMAT_REMINDER}\n${lengthReminder}` });
  }

  return { system, messages: withMove, prefill };
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
    });
    const text = req.system + req.messages.map((m) => m.content).join('\n');
    return estimateTokens(text);
  } catch {
    return 0;
  }
}
