import type { GameMasterState, WorldStateUpdate, GmCharacter, GmClock } from '../shared/types';
import { uid } from '../shared/utils';
import { findRegistryMatch, normName, nameHit } from './characterRegistry';

// Человекочитаемая внутриигровая дата/время: "3 March 1024 · 14:30 · Plaza".
export function formatClock(c: GmClock): string {
  const date = [c.day, c.month, c.year].filter(Boolean).join(' ');
  return [date, c.time, c.location].filter(Boolean).join(' · ');
}

// Событие, случившееся В ПЕРЕПИСКЕ телефона, — в ту же ленту, что и события
// сцены. Отдельной ленты для телефона нет и быть не должно: это одна история,
// и то, что персонаж сказал в чате, обязано помниться так же, как сказанное
// вслух. Раньше сказанное в переписке жило ровно до того момента, когда
// сообщения уезжали из окна контекста, и дальше не существовало ни для
// рассказчика, ни для самих ботов.
export function recordChatEvent(
  gm: GameMasterState,
  event: { summary: string; level?: 'general' | 'important' | 'key' },
  chars: string[],
  turn: number
): GameMasterState {
  const summary = event.summary.trim();
  if (!summary) return gm;
  return mergeWorldState(
    gm,
    { event: summary, eventChars: chars.filter(Boolean), eventLevel: event.level },
    turn
  );
}

// Мержит дельту состояния мира от ИИ (WorldStateUpdate) в GameMasterState.
// Вызывается каждый ход — так Game Master остаётся динамическим (Horae-подобно).
export function mergeWorldState(
  gm: GameMasterState,
  update: WorldStateUpdate | undefined,
  turn: number
): GameMasterState {
  if (!update) return gm;
  const next: GameMasterState = {
    clock: { ...gm.clock },
    calendar: { months: [...gm.calendar.months] },
    showClockInGame: gm.showClockInGame,
    characters: gm.characters.map((c) => ({ ...c, tags: [...c.tags] })),
    relations: gm.relations.map((r) => ({ ...r })),
    events: [...gm.events],
    agenda: gm.agenda.map((t) => ({ ...t })),
    locations: (gm.locations || []).map((l) => ({ ...l, tags: [...l.tags] })),
    // Реестр персонажей копируется вместе с остальным. Раньше он тут молча
    // терялся: объект собирался по полям, и registry в перечень не попал. Дальше
    // по ходу его пересобирал syncRegistry, поэтому потеря была незаметна снаружи —
    // но ВНУТРИ этой функции реестра не существовало, и опознать человека по
    // алиасу было нечем. Отсюда и вторая запись в досье на то же лицо.
    registry: (gm.registry || []).map((e) => ({ ...e, aliases: [...e.aliases] })),
  };

  // Часы/дата/локация.
  if (update.clock) {
    if (update.clock.day) next.clock.day = update.clock.day;
    if (update.clock.month) next.clock.month = update.clock.month;
    if (update.clock.year) next.clock.year = update.clock.year;
    if (update.clock.time) next.clock.time = update.clock.time;
    if (update.clock.location) next.clock.location = update.clock.location;
  }

  // Досье персонажей — upsert по charId, иначе по имени (без регистра).
  for (const u of update.characters || []) {
    if (!u || !u.name) continue;
    // ОПОЗНАНИЕ ЧЕЛОВЕКА — ОДНО ПРАВИЛО НА ВСЮ ИГРУ. Раньше досье искалось строго
    // по точному совпадению имени в нижнем регистре, тогда как реестр персонажей
    // умеет алиасы и близкие написания. Модель называет человека «Дэм» вместо
    // «Дэмиан» — реестр видит того же, а список досье заводит ВТОРУЮ запись.
    // Отсюда и дубликаты персонажей в Game Master. Теперь досье пользуется тем же
    // сопоставлением, что и реестр: id → алиас в реестре → похожее имя.
    let idx = u.charId ? next.characters.findIndex((c) => c.charId === u.charId) : -1;
    // Анкета, которую реестр знает под этим именем/прозвищем. Нужна и для поиска
    // существующей записи, и для привязки НОВОЙ: досье, заведённое под прозвищем
    // без charId, оставалось сиротой — в панели Game Master запись видна, а в
    // ростере персонаж без досье, потому что связать их было нечем.
    const viaRegistry = findRegistryMatch(next.registry || [], u.name);
    if (idx === -1 && viaRegistry) {
      const names = [viaRegistry.entry.canonicalName, ...viaRegistry.entry.aliases].map(normName);
      idx = next.characters.findIndex(
        (c) => (c.charId && c.charId === viaRegistry.entry.id) || names.includes(normName(c.name))
      );
    }
    if (idx === -1) idx = next.characters.findIndex((c) => normName(c.name) === normName(u.name));
    const set = (cur: GmCharacter, key: keyof GmCharacter, val: unknown) => {
      if (typeof val === 'string' && val.trim()) (cur as any)[key] = val;
    };
    if (idx === -1) {
      const c: GmCharacter = {
        charId: u.charId || viaRegistry?.entry.sheetId || undefined,
        name: u.name,
        dossier: u.dossier || '',
        appearance: u.appearance || '',
        personality: u.personality || '',
        roleToHero: u.roleToHero || '',
        outfit: u.outfit || '',
        mood: u.mood || '',
        status: u.status || '',
        location: u.location || '',
        tags: Array.isArray(u.tags) ? u.tags : [],
      };
      c.updatedAtTurn = turn;
      next.characters.push(c);
    } else {
      const c = next.characters[idx];
      set(c, 'dossier', u.dossier);
      set(c, 'appearance', u.appearance);
      set(c, 'personality', u.personality);
      set(c, 'roleToHero', u.roleToHero);
      set(c, 'outfit', u.outfit);
      set(c, 'mood', u.mood);
      set(c, 'status', u.status);
      set(c, 'location', u.location);
      if (Array.isArray(u.tags) && u.tags.length) c.tags = u.tags;
      if (!c.charId) c.charId = u.charId || viaRegistry?.entry.sheetId || c.charId;
      // Отмечаем ход обновления только если что-то реально пришло: иначе досье
      // выглядело бы свежим каждый ход, даже когда ИИ его не трогал.
      if (u.dossier || u.status || u.mood || u.outfit || u.location || u.roleToHero) c.updatedAtTurn = turn;
    }
  }

  // Память локаций — upsert по имени (без регистра): дополняем описание/теги.
  for (const u of update.locations || []) {
    if (!u || !u.name || !u.name.trim()) continue;
    // Сравниваем нормализованно: «Кафе «Уют»» и «кафе Уют» — одно место.
    // Точное совпадение строк заводило вторую запись на ту же локацию, и память
    // мест распухала дублями с разными описаниями.
    const idx = next.locations.findIndex((l) => normName(l.name) === normName(u.name));
    if (idx === -1) {
      next.locations.push({
        id: uid('loc'),
        name: u.name.trim(),
        description: (u.description || '').trim(),
        tags: Array.isArray(u.tags) ? u.tags.filter((t) => typeof t === 'string') : [],
        source: 'auto',
      });
    } else {
      const l = next.locations[idx];
      if (u.description && u.description.trim()) l.description = u.description.trim();
      if (Array.isArray(u.tags) && u.tags.length) l.tags = u.tags.filter((t) => typeof t === 'string');
    }
  }

  // Сетка отношений между персонажами — upsert по (from,to). Имена сверяем с
  // точностью до падежа: «Дэмиан → Кейт» и «Дэмиану → Кейт» это одно ребро, а не
  // два. Прозвища ловит реестр — приводим концы ребра к каноничному имени, иначе
  // «Дэм → Кейт» жило параллельно «Дэмиан → Кейт» и сетка распухала дублями.
  const canonEnd = (n: string): string => {
    const m = findRegistryMatch(next.registry || [], n);
    return m?.exact ? m.entry.canonicalName : n;
  };
  for (const r of update.relations || []) {
    if (!r || !r.from || !r.to) continue;
    const from = canonEnd(r.from);
    const to = canonEnd(r.to);
    const idx = next.relations.findIndex((e) => nameHit(e.from, from) && nameHit(e.to, to));
    if (idx === -1) next.relations.push({ from, to, label: r.label || '' });
    else if (r.label) next.relations[idx].label = r.label;
  }

  // Анализ сцены → событие (штампуем внутриигровой датой + участниками, чтобы ИИ
  // не путался в хронологии — см. правку про календарь).
  if ((update.event && update.event.trim()) || (update.mood && update.mood.trim())) {
    const date = formatClock(next.clock);
    const chars =
      update.eventChars && update.eventChars.length
        ? update.eventChars
        : (update.characters || []).map((c) => c.name).filter(Boolean);
    next.events.push({
      id: uid('evt'),
      turn,
      date,
      chars,
      summary: (update.event || '').trim(),
      mood: (update.mood || '').trim(),
      source: 'auto',
      level: update.eventLevel === 'key' || update.eventLevel === 'important' ? update.eventLevel : 'general',
    });
    if (next.events.length > 300) next.events = next.events.slice(-300);
  }

  // Адженда: новые задачи (без дублей по тексту) и отметка выполненных.
  for (const text of update.agendaAdd || []) {
    const t = (text || '').trim();
    if (!t) continue;
    if (!next.agenda.some((x) => x.text.toLowerCase() === t.toLowerCase()))
      next.agenda.push({ id: uid('task'), text: t, done: false, source: 'auto' });
  }
  for (const text of update.agendaDone || []) {
    const t = (text || '').trim().toLowerCase();
    if (!t) continue;
    for (const task of next.agenda) {
      if (task.text.toLowerCase() === t || task.text.toLowerCase().includes(t)) task.done = true;
    }
  }

  return next;
}
