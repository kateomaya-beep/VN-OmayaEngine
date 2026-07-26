import type { Project, RuntimeState, LlmMessage } from '../shared/types';
import { AUDIO_MOODS, DEFAULT_TURN_LENGTH, DEFAULT_THINKING_PLAN, PHONE_BALANCE_STAT } from '../shared/types';
import { FORMAT_REMINDER } from './directorPrompt';
import { type DynamicSource } from './promptPreset';
import { getPresetSettings } from './presetSettings';
import { matchLorebook } from './lorebookEngine';
import { characterOutfits, defaultOutfitTag, hasExtraOutfits } from '../shared/outfits';
import { extractJson } from './responseParser';
import { formatClock } from './gameMaster';
import { expandMacros, type MacroContext } from './macros';
import { retrieveRelevant } from './vectorEngine';
import { estimateTokens } from '../shared/utils';

// Builds the full request as a system string (layered core → style → jailbreak →
// dynamic context) plus the live-window history and the player's move.

// Сжимает сырой JSON-ход ассистента до чистой прозы (что видел игрок): нарратив/
// мысли как есть, реплики как «Имя: текст». Возвращает null при неразборе — тогда
// вызывающий оставит сырой контент. Снимает дублирование JSON-обвязки в контексте.
function condenseAssistantTurn(raw: string, project: Project, state: RuntimeState): string | null {
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
    return `### ${c.name} (id: ${c.id}, role: ${roleLabel[c.role] || c.role})
Appearance: ${expandMacros(c.card.appearance, ctx)}
Personality: ${expandMacros(c.card.personality, ctx)}
Backstory: ${expandMacros(c.card.backstory, ctx)}
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
  if (m.chronicle.length) {
    parts.push(`CHRONICLE (compressed past events):\n${m.chronicle.map((c, i) => `[${i + 1}] ${c.text}`).join('\n')}`);
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
    parts.push(`Open agenda:\n${openTasks.map((t) => `- ${t.text}`).join('\n')}`);
  }
  if (gm.events.length) {
    const recent = gm.events.slice(-6);
    parts.push(
      `Recent events (chronological):\n${recent
        .map((e) => `- ${e.date ? `[${e.date}] ` : `[t${e.turn}] `}${e.summary}${e.chars.length ? ` (${e.chars.join(', ')})` : ''}`)
        .join('\n')}`
    );
  }
  return parts.length
    ? parts.join('\n\n')
    : '(no game-master state yet — establish it via worldState this turn)';
}

// Контекст телефона (Batch 7 §7.3 + ревизия блока 6): баланс, валюта, прайс-гайд,
// управляющие биты (transaction / sms_incoming / contact_added), правило нулевого
// баланса и активные заказы доставки. Возвращаем '' если расширение выключено.
function phoneBlock(project: Project, state: RuntimeState): string {
  const cfg = project.phone;
  if (!cfg?.enabled) return '';
  const bal = state.statValues[PHONE_BALANCE_STAT] ?? 0;
  const cur = cfg.currencyName || '$';
  const contacts = (state.phone?.contacts || [])
    .filter((c) => !c.hidden)
    .map((c) => {
      const nm = project.characters.find((x) => x.id === c.characterId)?.name || c.characterId;
      return `${nm} (${c.characterId})`;
    });
  const parts = [
    `The hero carries a smartphone. Current wallet balance: ${bal} ${cur}.`,
    cfg.priceGuide?.trim()
      ? `PRICE GUIDE (setting's price levels — keep every amount in this order of magnitude, stay consistent between turns, never invent prices outside this scale):\n${cfg.priceGuide.trim()}`
      : '',
    `MONEY RULE: whenever the hero spends or receives money in the narrative, emit a "transaction" control beat: {"type":"transaction","amount":<negative to spend / positive to receive>,"vendor":"<where or from whom>","item":"<what for>","time":"<in-story time>"}. vendor, item and time are required — together they form the hero's bank statement. Do NOT also mirror the same amount in statChanges (the engine already applies it).`,
    `Other phone control beats (no display text, removed from the visible flow):`,
    `  - {"type":"sms_incoming","characterId":"<id>","text":"<message>"} — a known character texts the hero off-screen (appears in the Messages app).`,
    `  - {"type":"contact_added","characterId":"<id>"} — the hero saves someone's number (characters who appear are auto-added; use only for someone met off-screen).`,
    `ZERO-BALANCE RULE: check the balance before letting the hero buy anything. If they cannot afford it, do NOT emit a negative transaction — write the scene accordingly (declined card, no cash, has to skip it).`,
  ];
  if (contacts.length) parts.push(`Saved phone contacts: ${contacts.join(', ')}.`);
  // Активные заказы доставки — ИИ должен ввести их в сцену (еда приезжает, вещь пришла).
  const orders = state.phone?.activeOrders || [];
  if (orders.length) {
    parts.push(
      `PENDING DELIVERIES (the hero ordered these via a delivery app — have them arrive in the story naturally, then move on): ${orders
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
  for (const block of preset.blocks) {
    if (!block.enabled) continue;
    let text: string;
    if (block.dynamic) {
      const gen = dynamicContent[block.dynamic];
      text = gen ? await gen() : '';
    } else {
      text = expandMacros(block.content, ctx);
    }
    if (!text.trim()) continue;
    const role = block.role || 'system';
    if (role === 'system') systemParts.push(text);
    else presetMessages.push({ role, content: text });
  }

  // Авторитетная длина хода (ползунок/ввод в пресете) — переопределяет любые числа
  // в тексте блоков. Ставим последней в системном промпте, чтобы имела приоритет.
  const tl = ps.turnLength || DEFAULT_TURN_LENGTH;
  systemParts.push(
    `TURN LENGTH & BEAT SIZE (authoritative — overrides any other length/beat guidance above): land the turn WITHIN ${tl.min}–${tl.max} words TOTAL — that is the target, do NOT overshoot it; once you reach a natural pause inside the range, stop rather than padding. Split the turn into medium beats: each beat a readable 1–3 sentence chunk (a short paragraph) — never a wall of text, never a bare one-liner. Fill the range with the NUMBER of medium beats, not by inflating any single beat. Keep a real mix of dialogue and narration: characters who are present must actually SPEAK — emit "dialogue" beats with that character's characterId (a dialogue beat with a valid characterId is what puts the character's sprite on screen), interleaved with narration/thought.`
  );
  const gap = ps.choiceMinGap ?? 0;
  if (gap > 0) {
    systemParts.push(
      `CHOICE FREQUENCY (authoritative): offer a choices block at most about once every ${gap} turns. On all other turns return choices: [] and let the player type. Only surface choices at a real decision point.`
    );
  }
  // Язык повествования (пресет). Управляет языком ТЕКСТА истории; ключи JSON и
  // id/настроения ассетов остаются английскими.
  const narr = ps.narrativeLanguage === 'en' ? 'English' : 'Russian (русский)';
  systemParts.push(
    `NARRATIVE LANGUAGE (authoritative): write ALL story text — narration, thoughts, character dialogue and choice texts — in ${narr}, regardless of the language of these instructions or of the character cards. Do NOT translate JSON keys, character ids, emotion keys, outfit tags, music moods or background ids — those stay exactly as given.`
  );
  // Телефон (Batch 7) — контекст только если расширение включено.
  const phoneCtx = phoneBlock(project, state);
  if (phoneCtx) systemParts.push(phoneCtx);
  const system = systemParts.join('\n\n');

  // Live window of history. Прошлые ходы ассистента храним сырым JSON (для реплея),
  // но в контекст ИИ шлём только ПРОЗУ этих ходов — так вход в разы легче (в
  // истории иначе едет весь JSON со worldState/статами, дублируя текущие блоки).
  const K = Math.max(2, ps.liveWindow);
  const window = state.history.slice(-K * 2).map((m) =>
    m.role === 'assistant'
      ? { role: 'assistant' as const, content: condenseAssistantTurn(m.content, project, state) ?? m.content }
      : m
  );

  const messages: LlmMessage[] = [...presetMessages, ...window];

  // Продвинутые кастомные вставки на заданной глубине от конца (author's note style).
  const blocks = (ps.advancedBlocks || []).filter((b) => b.content.trim());
  const withMove: LlmMessage[] = [...messages, { role: 'user', content: playerMove }];
  for (const b of blocks) {
    const depth = Math.max(0, Math.floor(b.depth));
    const insertAt = Math.max(0, withMove.length - depth);
    withMove.splice(insertAt, 0, { role: 'user', content: expandMacros(b.content, ctx) });
  }

  // Заметка для ИИ (Author's Note, см. CR v2 §M) — тот же слот глубины 0, что и
  // кастомные вставки Блока F, но со своим UI. Пусто — ничего не инжектится.
  for (const note of state.authorNotes) {
    if (note.text.trim()) {
      withMove.push({ role: 'user', content: `[AUTHOR NOTE] ${expandMacros(note.text, ctx)}` });
    }
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
