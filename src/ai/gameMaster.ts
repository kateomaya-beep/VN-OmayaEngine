import type { GameMasterState, WorldStateUpdate, GmCharacter } from '../shared/types';
import { uid } from '../shared/utils';

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
    showClockInGame: gm.showClockInGame,
    characters: gm.characters.map((c) => ({ ...c, tags: [...c.tags] })),
    relations: gm.relations.map((r) => ({ ...r })),
    events: [...gm.events],
    agenda: gm.agenda.map((t) => ({ ...t })),
  };

  // Часы/дата.
  if (update.clock) {
    if (update.clock.date) next.clock.date = update.clock.date;
    if (update.clock.time) next.clock.time = update.clock.time;
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

  // Анализ сцены → событие.
  if ((update.event && update.event.trim()) || (update.mood && update.mood.trim())) {
    next.events.push({ turn, summary: (update.event || '').trim(), mood: (update.mood || '').trim() });
    if (next.events.length > 200) next.events = next.events.slice(-200);
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
