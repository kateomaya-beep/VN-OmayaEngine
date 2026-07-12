import type { GameMasterState, WorldStateUpdate, GmCharacter, GmClock } from '../shared/types';
import { uid } from '../shared/utils';

// Человекочитаемая внутриигровая дата/время: "3 March 1024 · 14:30 · Plaza".
export function formatClock(c: GmClock): string {
  const date = [c.day, c.month, c.year].filter(Boolean).join(' ');
  return [date, c.time, c.location].filter(Boolean).join(' · ');
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
    const idx = next.characters.findIndex((c) =>
      u.charId ? c.charId === u.charId : c.name.toLowerCase() === u.name.toLowerCase()
    );
    const set = (cur: GmCharacter, key: keyof GmCharacter, val: unknown) => {
      if (typeof val === 'string' && val.trim()) (cur as any)[key] = val;
    };
    if (idx === -1) {
      const c: GmCharacter = {
        charId: u.charId || undefined,
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
      if (u.charId && !c.charId) c.charId = u.charId;
    }
  }

  // Сетка отношений между персонажами — upsert по (from,to).
  for (const r of update.relations || []) {
    if (!r || !r.from || !r.to) continue;
    const idx = next.relations.findIndex(
      (e) => e.from.toLowerCase() === r.from.toLowerCase() && e.to.toLowerCase() === r.to.toLowerCase()
    );
    if (idx === -1) next.relations.push({ from: r.from, to: r.to, label: r.label || '' });
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
