import { useState } from 'react';
import { usePlayerStore } from '../playerStore';
import { Modal } from '../../../shared/ui';
import { uid } from '../../../shared/utils';
import type { CharacterRole } from '../../../shared/types';

// Всплывающая панель быстрой правки проекта прямо в игре (см. доработка §7).
// Пишет в общий стор проекта (patchProject) → изменения сразу в манифесте
// следующего хода и сохраняются в IndexedDB.
export function EditPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const s = usePlayerStore();
  const [newChar, setNewChar] = useState('');
  const [newCharRole, setNewCharRole] = useState<CharacterRole>('important_character');
  const [statName, setStatName] = useState('');

  if (!open || !s.project || !s.state) return null;
  const project = s.project;

  function addCharacter() {
    const name = newChar.trim();
    if (!name) return;
    s.patchProject((p) =>
      p.characters.push({
        id: uid('char'),
        name,
        role: newCharRole,
        card: { appearance: '', personality: '', backstory: '', speechStyle: '' },
        sprites: {},
      })
    );
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

      <h4 className="font-semibold text-sm mb-2">Статы</h4>
      <div className="space-y-1 mb-3 text-sm">
        {project.stats.map((st) => (
          <div key={st.id} className="flex items-center justify-between">
            <span>{st.name}</span>
            <span className="text-gray-400">
              {s.state!.statValues[st.id] ?? st.initial} ({st.min}..{st.max})
            </span>
          </div>
        ))}
        {project.stats.length === 0 && <div className="text-gray-600">— нет статов —</div>}
      </div>
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
