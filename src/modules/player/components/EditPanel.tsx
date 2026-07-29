import { useMemo, useState } from 'react';
import { usePlayerStore } from '../playerStore';
import { Modal } from '../../../shared/ui';
import { uid } from '../../../shared/utils';
import { emptyRelationship, RELATIONSHIP_FIELDS, RELATIONSHIP_META } from '../../../shared/types';
import type { CharacterRole, Project, RuntimeState } from '../../../shared/types';
import { parseAiResponse } from '../../../ai/responseParser';

// Собирает уникальные имена эпизодических NPC, встреченных в истории (dialogue-beat
// с name, но без characterId) — см. CR v2 §K.
function collectEncounteredNpcNames(project: Project, state: RuntimeState): string[] {
  const known = new Set(project.characters.map((c) => c.name.toLowerCase()));
  const seen = new Set<string>();
  for (const msg of state.history) {
    if (msg.role !== 'assistant') continue;
    const parsed = parseAiResponse(msg.content, project, null, null);
    if (!parsed.ok || !parsed.turn) continue;
    for (const b of parsed.turn.beats) {
      if (b.type === 'dialogue' && !b.characterId && b.name) {
        const name = b.name.trim();
        if (name && !known.has(name.toLowerCase())) seen.add(name);
      }
    }
  }
  return [...seen];
}

// Всплывающая панель быстрой правки проекта прямо в игре (см. доработка §7).
// Пишет в общий стор проекта (patchProject) → изменения сразу в манифесте
// следующего хода и сохраняются в IndexedDB.
export function EditPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const s = usePlayerStore();
  const [newChar, setNewChar] = useState('');
  const [newCharRole, setNewCharRole] = useState<CharacterRole>('important_character');
  const [statName, setStatName] = useState('');

  const encounteredNpcs = useMemo(
    () => (s.project && s.state ? collectEncounteredNpcNames(s.project, s.state) : []),
    [s.project, s.state?.history.length]
  );

  if (!open || !s.project || !s.state) return null;
  const project = s.project;
  // Персонажи со статами отношений (протагонист их не имеет).
  const relChars = project.characters.filter((c) => c.role !== 'protagonist');

  // Промоушен NPC → полноценный персонаж (Блок K): статы отношений активируются сразу.
  function promoteNpc(name: string, role: CharacterRole) {
    const cid = uid('char');
    s.patchProject((p) =>
      p.characters.push({
        id: cid,
        name,
        role,
        card: { appearance: '', personality: '', backstory: '', speechStyle: '' },
        sprites: {},
        relationship: emptyRelationship(),
        importedFrom: 'promoted_npc',
      })
    );
    usePlayerStore.setState((st) => ({
      state: st.state
        ? { ...st.state, relationship: { ...st.state.relationship, [cid]: emptyRelationship() } }
        : st.state,
    }));
  }

  function addCharacter() {
    const name = newChar.trim();
    if (!name) return;
    const cid = uid('char');
    s.patchProject((p) =>
      p.characters.push({
        id: cid,
        name,
        role: newCharRole,
        card: { appearance: '', personality: '', backstory: '', speechStyle: '' },
        sprites: {},
        relationship: emptyRelationship(),
      })
    );
    // Сидим живые значения отношений, чтобы стат сразу работал.
    usePlayerStore.setState((st) => ({
      state: st.state
        ? { ...st.state, relationship: { ...st.state.relationship, [cid]: emptyRelationship() } }
        : st.state,
    }));
    setNewChar('');
  }

  function renameCharacter(id: string, name: string) {
    s.patchProject((p) => {
      const c = p.characters.find((c) => c.id === id);
      if (c) c.name = name;
    });
  }

  function addStat() {
    const name = statName.trim();
    if (!name) return;
    const id = uid('stat');
    s.patchProject((p) =>
      p.stats.push({ id, name, min: 0, max: 100, initial: 0, visible: true, description: '' })
    );
    // Seed runtime value так, чтобы стат сразу работал в текущей игре.
    usePlayerStore.setState((st) => ({
      state: st.state
        ? { ...st.state, statValues: { ...st.state.statValues, [id]: 0 } }
        : st.state,
    }));
    setStatName('');
  }

  return (
    <Modal open={open} onClose={onClose} title="Правка в игре" wide>
      <p className="text-xs text-gray-500 mb-4">
        Изменения сразу попадают в манифест и сохраняются. Полное редактирование — в конструкторе.
      </p>

      {encounteredNpcs.length > 0 && (
        <>
          <h4 className="font-semibold text-sm mb-2">Встреченные NPC</h4>
          <p className="text-xs text-gray-500 mb-2">
            Эпизодические персонажи из истории. Добавьте как полноценного — активируются статы
            отношений, можно будет догрузить спрайты в конструкторе.
          </p>
          <div className="flex flex-wrap gap-2 mb-5">
            {encounteredNpcs.map((name) => (
              <div key={name} className="chip !py-1.5 gap-2">
                <span>{name}</span>
                <button
                  className="text-accent2 hover:text-white text-xs"
                  onClick={() => promoteNpc(name, 'important_character')}
                  title="Добавить как важного персонажа"
                >
                  ★+
                </button>
                <button
                  className="text-accent hover:text-white text-xs"
                  onClick={() => promoteNpc(name, 'love_interest')}
                  title="Добавить как любовный интерес"
                >
                  ♥+
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      <h4 className="font-semibold text-sm mb-2">Персонажи</h4>
      <div className="space-y-2 mb-3">
        {project.characters.map((c) => (
          <div key={c.id} className="flex items-center gap-2">
            <input
              className="input text-sm flex-1"
              value={c.name}
              onChange={(e) => renameCharacter(c.id, e.target.value)}
            />
            <select
              className="input text-sm w-44"
              value={c.role}
              onChange={(e) =>
                s.patchProject((p) => {
                  const ch = p.characters.find((x) => x.id === c.id);
                  if (ch) ch.role = e.target.value as CharacterRole;
                })
              }
            >
              <option value="protagonist">Протагонист</option>
              <option value="love_interest">Любовный интерес</option>
              <option value="important_character">Важный</option>
              <option value="npc">NPC</option>
            </select>
          </div>
        ))}
      </div>
      <div className="flex gap-2 mb-5">
        <input
          className="input text-sm flex-1"
          placeholder="Имя нового персонажа"
          value={newChar}
          onChange={(e) => setNewChar(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addCharacter()}
        />
        <select
          className="input text-sm w-44"
          value={newCharRole}
          onChange={(e) => setNewCharRole(e.target.value as CharacterRole)}
        >
          <option value="important_character">Важный</option>
          <option value="love_interest">Любовный интерес</option>
          <option value="npc">NPC</option>
          <option value="protagonist">Протагонист</option>
        </select>
        <button className="btn-primary" onClick={addCharacter}>
          +
        </button>
      </div>

      <h4 className="font-semibold text-sm mb-1">Статы</h4>
      <p className="text-[11px] text-gray-500 mb-2">
        Значения правятся вручную — если ИИ забыл начислить по сюжету. Изменения сразу уходят в контекст.
      </p>
      <div className="space-y-1.5 mb-3 text-sm">
        {project.stats.map((st) => {
          const val = s.state!.statValues[st.id] ?? st.initial;
          return (
            <div key={st.id} className="flex items-center gap-2">
              <span className="flex-1 truncate" title={st.description || undefined}>
                {st.name}
              </span>
              <button
                className="btn-ghost !px-2 !py-0.5 text-xs"
                onClick={() => s.setStatValue(st.id, val - 1)}
                title="−1"
              >
                −
              </button>
              <input
                type="number"
                className="input !py-1 w-20 text-center"
                value={val}
                min={st.min}
                max={st.max}
                onChange={(e) => s.setStatValue(st.id, Number(e.target.value))}
              />
              <button
                className="btn-ghost !px-2 !py-0.5 text-xs"
                onClick={() => s.setStatValue(st.id, val + 1)}
                title="+1"
              >
                +
              </button>
              <span className="text-[11px] text-gray-500 w-16 text-right">
                {st.min}..{st.max}
              </span>
            </div>
          );
        })}
        {project.stats.length === 0 && <div className="text-gray-600">— нет статов —</div>}
      </div>

      {/* Статы отношений — их ИИ тоже иногда пропускает. */}
      {relChars.length > 0 && (
        <>
          <h4 className="font-semibold text-sm mb-2">Отношения</h4>
          <div className="space-y-2 mb-3">
            {relChars.map((c) => {
              const r = s.state!.relationship[c.id] ?? emptyRelationship();
              return (
                <div key={c.id} className="rounded-lg border border-white/10 p-2">
                  <div className="text-sm mb-1.5">{c.name}</div>
                  <div className="grid grid-cols-2 gap-1.5">
                    {RELATIONSHIP_FIELDS.map((f) => (
                      <label key={f} className="flex items-center gap-1.5 text-xs">
                        <span className="w-5 text-center">{RELATIONSHIP_META[f].icon}</span>
                        <input
                          type="number"
                          className="input !py-1 flex-1 text-center"
                          value={r[f]}
                          min={-100}
                          max={100}
                          onChange={(e) => s.setRelationshipStat(c.id, f, Number(e.target.value))}
                        />
                      </label>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
      <div className="flex gap-2">
        <input
          className="input text-sm flex-1"
          placeholder="Название нового стата (0..100)"
          value={statName}
          onChange={(e) => setStatName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addStat()}
        />
        <button className="btn-primary" onClick={addStat}>
          +
        </button>
      </div>
    </Modal>
  );
}
