import type { Project, RuntimeState, AiTurn, CanonicalFact, AudioMood, MemoryBookEntry, PhoneState, InventoryItem } from '../shared/types';
import { RELATIONSHIP_META, DEFAULT_TURN_LENGTH, PHONE_BALANCE_STAT, initialPhoneState } from '../shared/types';
import { pushToast } from '../shared/toast';
import { resolveEmoji } from '../shared/emojiDict';
import { parseDate, addDays, diffDays, formatDate } from '../shared/gameDate';
import { syncRegistry, findRegistryMatch, newRegistryId, normName } from './characterRegistry';
import { buildRequest } from './promptBuilder';
import { runCompletion } from './providers';
import { getPresetSettings } from './presetSettings';
import { parseAiResponse, applyStatChanges, applyRelationshipChanges } from './responseParser';
import { mergeWorldState } from './gameMaster';
import { selectAssets } from './assetSelector';
import { maybeCompress } from './memoryEngine';
import { rollRandomEvent, rollRandomSms } from './randomEvents';
import { uid } from '../shared/utils';

// Порог, с которого сдвиг отношений считается «заметным событием» и попадает
// в Меморибук автоматически (обычный шаг ±1..5 — см. CR v2 §C.3).
const NOTABLE_RELATIONSHIP_DELTA = 5;

export interface TurnResult {
  turn: AiTurn;
  state: RuntimeState;
}

const RETRY_HINT =
  '\n\nThe response failed validation. Reply with EXACTLY one JSON object per the schema — no markdown, no text outside the JSON.';

// Подбор трека под настроение: ротация среди треков этого настроения; нет треков →
// пробуем 'calm'; ничего нет → null (тишина). Не крашит.
export function pickTrackForMood(
  project: Project,
  mood: AudioMood | string | null,
  prevAssetId: string | null
): string | null {
  if (!mood) return prevAssetId;
  const pool = project.assets.filter((a) => a.type === 'music' && a.audioMood === mood);
  const chosen = pool.length ? pool : project.assets.filter((a) => a.type === 'music' && a.audioMood === 'calm');
  if (!chosen.length) return null;
  if (chosen.length === 1) return chosen[0].id;
  // Ротация: избегаем повтора текущего трека.
  const candidates = chosen.filter((a) => a.id !== prevAssetId);
  const pickFrom = candidates.length ? candidates : chosen;
  return pickFrom[Math.floor(Math.random() * pickFrom.length)].id;
}

// Регулярные начисления за прошедший период (Batch 8 §III.3). Без сохранения
// состояния: считаем, сколько дат вида anchor + k*period попадают в (oldDate, newDate].
// Каждая — отдельная транзакция со своей датой. Долг (баланс < 0) не блокируется.
export interface Accrual {
  amount: number; // со знаком (доход +, расход −)
  name: string;
  date: string; // ДД/ММ/ГГГГ
}
export function computeAccruals(project: Project, oldDate: string, newDate: string): Accrual[] {
  const fin = project.finance;
  if (!fin) return [];
  const oldY = parseDate(oldDate);
  const newY = parseDate(newDate);
  if (!oldY || !newY) return [];
  if (diffDays(oldY, newY) <= 0) return []; // время не шло вперёд
  const out: Accrual[] = [];
  for (const e of fin.recurringEntries) {
    if (!e.enabled) continue;
    const anchor = parseDate(e.nextChargeDate);
    const p = e.periodDays;
    if (!anchor || !p || p <= 0) continue;
    const dOld = diffDays(anchor, oldY);
    const dNew = diffDays(anchor, newY);
    // k*p ∈ (dOld, dNew], k ≥ 0
    const kMin = Math.max(0, Math.floor(dOld / p) + 1);
    const kMax = Math.floor(dNew / p);
    for (let k = kMin; k <= kMax; k++) {
      const when = addDays(anchor, k * p);
      out.push({
        amount: e.kind === 'expense' ? -e.amount : e.amount,
        name: e.name,
        date: formatDate(when),
      });
    }
  }
  return out;
}

// Применяет разобранный ход к state: статы, отношения, канон-факты, меморибук,
// спрайты на сцене, музыку, историю, память. Общая часть для обычного и
// потокового пути (см. Batch 3 §7). `raw` — сырой ответ ИИ для истории.
export async function applyTurn(
  project: Project,
  state: RuntimeState,
  playerMove: string,
  turn: AiTurn,
  raw: string,
  opts?: { eventFired?: boolean; smsFired?: boolean }
): Promise<RuntimeState> {
  const nextTurnNumber = state.turnCount + 1;

  // Частота выборов: если задан минимальный интервал (choiceMinGap) и с прошлого
  // показа выбора прошло меньше N ходов — глушим choices этого хода. Модель считать
  // ходы не умеет, поэтому решает движок (детерминированно). turn.choices мутируем,
  // чтобы и немедленный рендер, и сохранённый lastTurn отражали троттлинг.
  const choiceGap = getPresetSettings().choiceMinGap ?? 0;
  let lastChoiceTurn = state.lastChoiceTurn ?? -1e9;
  if (choiceGap > 0 && turn.choices.length > 0 && nextTurnNumber - lastChoiceTurn < choiceGap) {
    turn.choices = [];
  }
  if (turn.choices.length > 0) lastChoiceTurn = nextTurnNumber;

  // Apply stat changes (clamped) and collect canonical facts (turn-indexed, not chapter-indexed).
  const { values, effective } = applyStatChanges(project, state.statValues, turn.statChanges);
  // Баланс телефона — виртуальный стат (не в project.stats), applyStatChanges его
  // пропускает; если ИИ прислал дельту на него — применяем вручную (учтётся ниже,
  // после подготовки phone-состояния).
  const economyOn = !!project.phone?.enabled || !!project.finance;
  const balanceDeltas = economyOn
    ? turn.statChanges.filter((ch) => ch.statId === PHONE_BALANCE_STAT)
    : [];
  const rel = applyRelationshipChanges(project, state.relationship, turn.statChanges);
  // Гарантируем запись отношений для КАЖДОГО персонажа проекта — чтобы персонажи,
  // добавленные по ходу игры, сразу отслеживались, эволюционировали и сохранялись
  // (а не оставались статичными). Протагонист статов отношений не имеет.
  for (const c of project.characters) {
    if (c.role !== 'protagonist' && !rel.relationship[c.id]) {
      rel.relationship[c.id] = { ...c.relationship };
    }
  }
  const facts: CanonicalFact[] = [
    ...state.memory.facts,
    { turn: nextTurnNumber, kind: 'choice', text: `выбор: ${playerMove}` },
  ];
  const memorybookAdds: MemoryBookEntry[] = [];
  for (const ch of turn.statChanges) {
    const orig = effective.find((e) => e.statId === ch.statId);
    if (orig) {
      const name = project.stats.find((s) => s.id === ch.statId)?.name || ch.statId;
      facts.push({
        turn: nextTurnNumber,
        kind: 'stat',
        text: `${name} ${orig.delta > 0 ? '+' : ''}${orig.delta} (${ch.reason})`,
      });
    }
  }
  for (const e of rel.effective) {
    const cName = project.characters.find((c) => c.id === e.charId)?.name || e.charId;
    const text = `${cName}: ${RELATIONSHIP_META[e.field].ru} ${e.delta > 0 ? '+' : ''}${e.delta}`;
    facts.push({ turn: nextTurnNumber, kind: 'stat', text });
    // Заметные сдвиги отношений — авто-запись в Меморибук (см. CR v2 §E1).
    if (Math.abs(e.delta) >= NOTABLE_RELATIONSHIP_DELTA) {
      memorybookAdds.push({ id: uid('mem'), text, turn: nextTurnNumber, source: 'auto', pinned: false });
    }
  }
  if (turn.chapterEvent === 'cg_moment') {
    const gist = turn.beats.find((b) => b.type === 'narration')?.text || 'Ключевой момент сюжета';
    memorybookAdds.push({
      id: uid('mem'),
      text: gist.slice(0, 200),
      turn: nextTurnNumber,
      source: 'auto',
      pinned: true, // CG-моменты — крупная веха, продвигается в постоянные сразу
    });
  }

  // Единый проход по beats (Batch 6 §1): управляющие биты scene_change/outfit_change
  // применяются В ТОЧКЕ появления в потоке, их эффект «протягивается» на последующие
  // content-биты (эффективные bg/mood), а сами управляющие биты убираются из потока
  // (текста не несут). Наряд персонажа — СОСТОЯНИЕ: сеем из onScreen, обновляем сменами,
  // сохраняем вперёд (персонаж остаётся в новом наряде и на следующие ходы).
  const outfitByChar = new Map<string, string | undefined>();
  for (const os of state.onScreen) outfitByChar.set(os.characterId, os.outfit);
  const onScreenMap = new Map(state.onScreen.map((s) => [s.characterId, s]));

  // Телефон (Batch 7): состояние правится управляющими битами. Мутируем копию только
  // если расширение включено.
  const phoneOn = !!project.phone?.enabled;
  const phone: PhoneState = JSON.parse(JSON.stringify(state.phone ?? initialPhoneState()));
  const addContact = (cid: string) => {
    if (!phoneOn) return;
    if (!phone.contacts.some((c) => c.characterId === cid)) phone.contacts.push({ characterId: cid });
  };

  // Инвентарь (Batch 8 §IV) — работает и без телефона. Мутируем копию.
  const inventory: InventoryItem[] = JSON.parse(JSON.stringify(state.inventory ?? []));
  const curDateStr = state.gm.clock.date || '';
  const addItem = (name: string, opts: { emoji?: string; quantity?: number; category?: string; source?: string }) => {
    const qty = opts.quantity && opts.quantity > 0 ? opts.quantity : 1;
    const exist = inventory.find((it) => it.name.toLowerCase() === name.toLowerCase());
    if (exist) {
      exist.quantity += qty;
      return;
    }
    inventory.push({
      id: uid('inv'),
      name,
      emoji: resolveEmoji(name, opts.emoji),
      quantity: qty,
      category: opts.category,
      acquiredDate: curDateStr || undefined,
      source: opts.source,
    });
  };
  const removeItem = (name: string, qty: number) => {
    const idx = inventory.findIndex((it) => it.name.toLowerCase() === name.toLowerCase());
    if (idx < 0) return;
    const it = inventory[idx];
    if (qty >= it.quantity) inventory.splice(idx, 1);
    else it.quantity -= qty;
  };

  // Баланс (Batch 8): долг разрешён (без клампа ≥0). Запись в выписку — только при
  // включённом телефоне; сам баланс меняется всегда.
  const recordMoney = (
    amount: number,
    meta: { vendor?: string; item?: string; time?: string; reason?: string; date?: string }
  ) => {
    if (!amount) return;
    values[PHONE_BALANCE_STAT] = (values[PHONE_BALANCE_STAT] ?? 0) + amount;
    if (phoneOn) {
      phone.transactions.push({
        amount,
        reason: meta.reason || [meta.vendor, meta.item].filter(Boolean).join(' — ') || 'Транзакция',
        vendor: meta.vendor,
        item: meta.item,
        time: meta.time,
        date: meta.date || curDateStr || undefined,
        at: Date.now(),
      });
    }
  };

  // Дельты баланса из statChanges (transaction/money_change-биты — в цикле ниже).
  for (const ch of balanceDeltas) recordMoney(ch.delta, { reason: ch.reason || '' });

  // Продвижение времени (Batch 8 §II): собираем целевую дату/время из time_advance-битов.
  let pendingDate: string | undefined;
  let pendingTime: string | undefined;

  let runBg: string | null = turn.scene.backgroundId ?? state.currentBackgroundId;
  let runMood: string | null = turn.scene.musicMood ?? state.currentMusicMood;

  // Реестр персонажей (patch character-registry): собираем управляющие биты и
  // применяем после сборки gm (реестр живёт в gm).
  const charBeats: typeof turn.beats = [];

  const contentBeats: typeof turn.beats = [];
  for (const b of turn.beats) {
    if (b.type === 'scene_change') {
      if (b.bg) runBg = b.bg;
      if (b.musicMood) runMood = b.musicMood;
      continue;
    }
    if (b.type === 'outfit_change') {
      outfitByChar.set(b.characterId, b.outfit);
      const cur = onScreenMap.get(b.characterId);
      if (cur) onScreenMap.set(b.characterId, { ...cur, outfit: b.outfit });
      continue;
    }
    // Телефон/финансы: transaction / money_change — движение денег (долг разрешён).
    if (b.type === 'transaction') {
      recordMoney(b.amount, { vendor: b.vendor, item: b.item, time: b.time });
      continue;
    }
    if (b.type === 'money_change') {
      recordMoney(b.amount, { reason: b.reason });
      continue;
    }
    // Время (Batch 8 §II): последняя дата/время в потоке — целевые. Начисления — после цикла.
    if (b.type === 'time_advance') {
      if (b.newDate) pendingDate = b.newDate;
      if (b.newTime) pendingTime = b.newTime;
      continue;
    }
    // Инвентарь (Batch 8 §IV): расходники реально расходуются.
    if (b.type === 'inventory_add') {
      addItem(b.name, { emoji: b.emoji, quantity: b.quantity, category: b.category, source: b.source });
      continue;
    }
    if (b.type === 'inventory_remove') {
      removeItem(b.name, b.quantity ?? 1);
      continue;
    }
    if (b.type === 'character_new' || b.type === 'character_alias_add' || b.type === 'character_update') {
      charBeats.push(b);
      continue;
    }
    if (b.type === 'sms_incoming') {
      if (phoneOn) {
        addContact(b.characterId);
        (phone.conversations[b.characterId] ||= []).push({ from: 'contact', text: b.text, at: Date.now() });
        if (!phone.unreadFrom.includes(b.characterId)) phone.unreadFrom.push(b.characterId);
        if (project.phone?.popupNotifications) {
          const nm = project.characters.find((c) => c.id === b.characterId)?.name || 'Сообщение';
          pushToast('info', `💬 ${nm}: ${b.text.slice(0, 60)}`);
        }
      }
      continue;
    }
    if (b.type === 'contact_added') {
      addContact(b.characterId);
      continue;
    }
    // Пустой нарратив (артефакт невалидного управляющего бита) — тоже отбрасываем.
    if (b.type === 'narration' && !b.text.trim() && !b.bg && !b.mood) continue;

    // Content-бит: печём эффективные фон и настроение на его момент.
    if (b.bg) runBg = b.bg;
    else b.bg = runBg ?? undefined;
    if (b.mood) runMood = b.mood;
    else if (runMood) b.mood = runMood;

    if (b.type === 'dialogue' && b.characterId) {
      // Встреченный персонаж → авто-контакт в телефоне (Batch 7 §3.1).
      addContact(b.characterId);
      // Наряд бита приоритетнее; иначе — текущий наряд персонажа из состояния.
      if (b.outfit) outfitByChar.set(b.characterId, b.outfit);
      else if (outfitByChar.get(b.characterId)) b.outfit = outfitByChar.get(b.characterId);
      onScreenMap.set(b.characterId, {
        characterId: b.characterId,
        emotion: b.emotion,
        outfit: b.outfit,
        position: b.position,
      });
    }
    contentBeats.push(b);
  }
  turn.beats = contentBeats;
  const onScreen = [...onScreenMap.values()].slice(-3);
  const finalBackgroundId = runBg ?? state.currentBackgroundId;

  // Заказы доставки «прибывают» за пару ходов: ИИ видит их в контексте как ожидаемые,
  // затем движок их снимает (считаем доставленными). Инвентарь добавлен при заказе.
  if (phoneOn && phone.activeOrders.length) {
    phone.activeOrders = phone.activeOrders.filter((o) => nextTurnNumber - o.placedAtTurn < 2);
  }

  // Музыка: финальное настроение хода -> конкретный трек (мид-турн смены играет плеер).
  const nextMood = runMood ?? state.currentMusicMood;
  const nextTrack =
    nextMood === state.currentMusicMood
      ? state.currentMusicAssetId
      : pickTrackForMood(project, nextMood, state.currentMusicAssetId);

  const history = [
    ...state.history,
    { role: 'user' as const, content: playerMove },
    { role: 'assistant' as const, content: raw },
  ];

  if (turn.chapterEvent === 'chapter_end') {
    facts.push({ turn: nextTurnNumber, kind: 'event', text: 'сюжетная веха' });
  }

  // Game Master: мержим дельту мира от ИИ (досье/статусы/часы/отношения/адженда).
  const gm = mergeWorldState(state.gm, turn.worldState, nextTurnNumber);

  // Продвижение времени (Batch 8 §II): time_advance-биты — авторитетны для даты/времени.
  const oldDate = state.gm.clock.date || '';
  if (pendingDate) gm.clock.date = pendingDate;
  if (pendingTime) gm.clock.time = pendingTime;
  const newDate = gm.clock.date || '';
  // Регулярные начисления за прошедшие периоды (Batch 8 §III.3) — датированные транзакции.
  if (pendingDate && oldDate) {
    for (const a of computeAccruals(project, oldDate, newDate)) {
      recordMoney(a.amount, { vendor: a.name, reason: a.name, date: a.date });
    }
  }

  // Реестр персонажей (patch character-registry): синхронизируем с персонажами проекта
  // (миграция + поддержание), затем применяем управляющие биты с защитой от дублей.
  const registry = syncRegistry(project, gm);
  for (const b of charBeats) {
    if (b.type === 'character_new') {
      // Дедуп на стороне движка: если имя совпадает (точно или частично) с существующим —
      // не создаём дубль, а добавляем алиас к найденному (безопаснее склеить).
      const match = findRegistryMatch(registry, b.canonicalName);
      if (match) {
        if (!match.entry.aliases.some((a) => normName(a) === normName(b.canonicalName))) {
          match.entry.aliases.push(b.canonicalName);
        }
        for (const al of b.aliases || []) {
          if (!match.entry.aliases.some((a) => normName(a) === normName(al))) match.entry.aliases.push(al);
        }
      } else {
        registry.push({
          id: b.id && !registry.some((e) => e.id === b.id) ? b.id : newRegistryId(),
          canonicalName: b.canonicalName,
          aliases: [b.canonicalName, ...(b.aliases || [])].filter((a, i, arr) => arr.findIndex((x) => normName(x) === normName(a)) === i),
          role: b.role || 'npc',
          status: '',
          firstSeenDate: newDate || undefined,
          lastSeenDate: newDate || undefined,
        });
      }
      continue;
    }
    if (b.type === 'character_alias_add') {
      const e = registry.find((x) => x.id === b.id);
      if (e && !e.aliases.some((a) => normName(a) === normName(b.alias))) e.aliases.push(b.alias);
      continue;
    }
    if (b.type === 'character_update') {
      const e = registry.find((x) => x.id === b.id);
      if (!e) continue;
      if (b.canonicalName) e.canonicalName = b.canonicalName;
      if (b.status && b.status !== e.status) {
        e.status = b.status;
        (e.statusLog ||= []).push({ status: b.status, date: newDate || undefined });
      }
      // sheetPatch — best-effort в досье GM (правку карточки проекта движок не пишет).
      if (b.sheetPatch && e.sheetId) {
        const gc = gm.characters.find((c) => c.charId === e.sheetId);
        if (gc) {
          for (const [k, v] of Object.entries(b.sheetPatch)) {
            if (k in gc && typeof (gc as any)[k] === 'string') (gc as any)[k] = v;
            else if (k === 'backstory' || k === 'dossier') gc.dossier = v;
          }
        }
      }
      continue;
    }
  }

  // lastSeenDate (Batch 8 §VI): персонажи в кадре «увидены» текущей внутриигровой датой.
  if (newDate) {
    for (const os of onScreen) {
      let gc = gm.characters.find((c) => c.charId === os.characterId);
      if (!gc) {
        const proj = project.characters.find((c) => c.id === os.characterId);
        if (proj) {
          gc = {
            charId: proj.id,
            name: proj.name,
            dossier: '',
            appearance: '',
            personality: '',
            roleToHero: '',
            outfit: '',
            mood: '',
            status: '',
            location: '',
            tags: [],
          };
          gm.characters.push(gc);
        }
      }
      if (gc) gc.lastSeenDate = newDate;
      // Реестр тоже отмечаем.
      const re = registry.find((x) => x.id === os.characterId || x.sheetId === os.characterId);
      if (re) {
        re.lastSeenDate = newDate;
        if (!re.firstSeenDate) re.firstSeenDate = newDate;
      }
    }
  }

  let nextState: RuntimeState = {
    ...state,
    statValues: values,
    relationship: rel.relationship,
    currentBackgroundId: finalBackgroundId,
    currentMusicMood: nextMood,
    currentMusicAssetId: nextTrack,
    onScreen,
    history,
    gm,
    phone: phoneOn ? phone : state.phone,
    inventory,
    lastTurn: turn,
    turnCount: nextTurnNumber,
    lastChoiceTurn,
    // Кулдаун случайных событий (Batch 6 §3): сброс при срабатывании, иначе +1.
    turnsSinceLastEvent: opts?.eventFired ? 0 : (state.turnsSinceLastEvent ?? 999) + 1,
    // Кулдаун случайных СМС (Batch 8-fix): отдельный счётчик.
    turnsSinceLastSms: opts?.smsFired ? 0 : (state.turnsSinceLastSms ?? 999) + 1,
    memory: {
      ...state.memory,
      facts,
      memorybook: [...state.memory.memorybook, ...memorybookAdds],
      messagesSinceSummary: state.memory.messagesSinceSummary + 2,
    },
  };

  // «Веха» из ИИ (бывший chapter_end) — форсируем немедленную свёртку живого окна,
  // не дожидаясь счётчика (глав больше нет, но крупный сюжетный рубеж всё ещё
  // повод подытожить историю — см. CR v2 §E).
  nextState = await maybeCompress(project, nextState, turn.chapterEvent === 'chapter_end');

  return nextState;
}

// Run one player turn: build context -> call LLM -> parse/repair -> apply to state.
export async function runTurn(
  project: Project,
  state: RuntimeState,
  playerMove: string,
  signal?: AbortSignal
): Promise<TurnResult> {
  // Случайное событие (Batch 6 §3) и случайное СМС (Batch 8-fix) — независимые роллы.
  // Обе скрытые директивы могут прийти в один ход (событие + отдельное входящее СМС).
  const evt = rollRandomEvent(project, state);
  const sms = rollRandomSms(project, state);
  const extraDirective = [evt.directive, sms.directive].filter(Boolean).join('\n\n') || undefined;
  const req = await buildRequest(project, state, playerMove, { extraDirective });

  // Потолок токенов — под верхнюю границу длины хода (слова→токены ≈ ×2.2 для
  // кириллицы) + запас на JSON-обвязку/worldState. Держим НЕ слишком большим,
  // иначе модель выбирает весь бюджет и уходит в «полотно» (медленно). Но и не
  // ниже дефолта шлюза, который иначе режет ход.
  const ps = getPresetSettings();
  const tl = ps.turnLength || DEFAULT_TURN_LENGTH;
  const maxTokens = Math.min(6000, Math.max(1200, Math.round(tl.max * 2.2) + 700));
  // При управляемом размышлении родную «думалку» глушим (none) — иначе она сложится
  // с нашим планом и станет только медленнее.
  const reasoningEffort = ps.guidedThinking ? 'none' : ps.reasoningEffort;

  let raw = await runCompletion({
    system: req.system,
    messages: req.messages,
    prefill: req.prefill,
    temperature: ps.temperature,
    maxTokens,
    reasoningEffort,
    signal,
  });

  let parsed = parseAiResponse(raw, project, state.currentBackgroundId, state.currentMusicMood);

  // One automatic retry on invalid JSON.
  if (!parsed.ok) {
    raw = await runCompletion({
      system: req.system,
      messages: [...req.messages, { role: 'user', content: RETRY_HINT }],
      prefill: req.prefill,
      temperature: Math.min(ps.temperature, 0.5),
      maxTokens,
      reasoningEffort,
      signal,
    });
    parsed = parseAiResponse(raw, project, state.currentBackgroundId, state.currentMusicMood);
  }

  if (!parsed.ok || !parsed.turn) {
    throw new Error(parsed.error || 'Не удалось разобрать ответ ИИ');
  }

  // Разделение ролей ИИ (Batch 5.4): если настроен отдельный Селектор ассетов
  // ('custom'/'local'), он переопределяет emotion/наряд/музыку из закрытых списков.
  // source==='main' или ошибка → ход без изменений (выбор Рассказчика).
  const turn = await selectAssets(project, state, parsed.turn);
  const nextState = await applyTurn(project, state, playerMove, turn, raw, { eventFired: evt.fired, smsFired: sms.fired });
  return { turn, state: nextState };
}
