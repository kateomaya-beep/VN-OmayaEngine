import { useEffect, useState } from 'react';
import type { Project, RuntimeState, SaveSlot, MemoryBookEntry } from '../../../shared/types';
import { Modal } from '../../../shared/ui';
import { listSaves } from '../../../storage/db';
import { formatDate, uid } from '../../../shared/utils';
import { parseAiResponse } from '../../../ai/responseParser';

// Backlog of past turns, reconstructed from the LLM history (see ТЗ §9).
export function HistoryLog({
  open,
  onClose,
  project,
  state,
}: {
  open: boolean;
  onClose: () => void;
  project: Project;
  state: RuntimeState;
}) {
  const entries: { speaker: string; text: string }[] = [];
  for (const msg of state.history) {
    if (msg.role === 'user') {
      const clean = msg.content.replace(/^\[(НАЧАЛО ИГРЫ|ВЫБОР|ДОСЛОВНО|OOC|ПРОДОЛЖИТЬ)\]\s*/, '');
      if (clean.trim()) entries.push({ speaker: '▸ Вы', text: clean });
    } else {
      const parsed = parseAiResponse(msg.content, project, null, null);
      if (parsed.ok && parsed.turn) {
        for (const b of parsed.turn.beats) {
          let speaker = '';
          if (b.type === 'dialogue') {
            const ch = b.characterId
              ? project.characters.find((c) => c.id === b.characterId)
              : undefined;
            speaker =
              ch?.role === 'protagonist' && state.protagonistName
                ? state.protagonistName
                : ch?.name || b.name || '???';
          } else if (b.type === 'thought') {
            speaker = '(мысли)';
          }
          entries.push({ speaker, text: b.text });
        }
      }
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="История" wide>
      <div className="space-y-2 text-sm">
        {entries.length === 0 && <p className="text-gray-500">Пока пусто.</p>}
        {entries.map((e, i) => (
          <p key={i} className={e.speaker === '▸ Вы' ? 'text-accent2' : ''}>
            {e.speaker && <span className="font-semibold text-gray-400">{e.speaker}: </span>}
            {e.text}
          </p>
        ))}
      </div>
    </Modal>
  );
}

export function SaveLoadPanel({
  open,
  onClose,
  project,
  onSave,
  onLoad,
}: {
  open: boolean;
  onClose: () => void;
  project: Project;
  onSave: (slot: number) => void;
  onLoad: (slot: number) => void;
}) {
  const [saves, setSaves] = useState<SaveSlot[]>([]);
  async function refresh() {
    setSaves(await listSaves(project.id));
  }
  useEffect(() => {
    if (open) refresh();
  }, [open]);

  const slots = Array.from({ length: 10 }, (_, i) => i + 1);
  const auto = saves.find((s) => s.slot === 0);

  return (
    <Modal open={open} onClose={onClose} title="Сохранения" wide>
      {auto && (
        <div className="card mb-3 flex items-center justify-between">
          <div>
            <div className="font-medium text-sm">Автосейв</div>
            <div className="text-xs text-gray-500">{formatDate(auto.savedAt)} · {auto.title}</div>
          </div>
          <button className="btn-ghost !py-1" onClick={() => onLoad(0)}>
            Загрузить
          </button>
        </div>
      )}
      <div className="grid sm:grid-cols-2 gap-2">
        {slots.map((slot) => {
          const s = saves.find((x) => x.slot === slot);
          return (
            <div key={slot} className="card flex items-center justify-between !p-3">
              <div className="min-w-0">
                <div className="font-medium text-sm">Слот {slot}</div>
                <div className="text-xs text-gray-500 truncate">
                  {s ? `${formatDate(s.savedAt)} · ход ${s.state.turnCount}` : 'пусто'}
                </div>
              </div>
              <div className="flex gap-1 shrink-0">
                <button
                  className="btn-ghost !px-2 !py-1 text-xs"
                  onClick={async () => {
                    onSave(slot);
                    setTimeout(refresh, 100);
                  }}
                >
                  Сохранить
                </button>
                {s && (
                  <button className="btn-primary !px-2 !py-1 text-xs" onClick={() => onLoad(slot)}>
                    Загрузить
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

// Экран «Память»: Хроника + Меморибук (динамический, редактируемый) + канонические
// факты (только чтение). Глав больше нет (см. CR v2 §E) — Хроника читается как
// последовательность свёрнутых сегментов, не «глав».
export function MemoryPanel({
  open,
  onClose,
  state,
  onEditLiveSummary,
  onEditChronicle,
  onEditMemorybook,
}: {
  open: boolean;
  onClose: () => void;
  state: RuntimeState;
  onEditLiveSummary: (text: string) => void;
  onEditChronicle: (index: number, text: string) => void;
  onEditMemorybook: (entries: MemoryBookEntry[]) => void;
}) {
  const m = state.memory;
  const [newEntry, setNewEntry] = useState('');

  function patchEntry(id: string, fn: (e: MemoryBookEntry) => void) {
    const next = m.memorybook.map((e) => {
      if (e.id !== id) return e;
      const copy = { ...e };
      fn(copy);
      return copy;
    });
    onEditMemorybook(next);
  }
  function removeEntry(id: string) {
    onEditMemorybook(m.memorybook.filter((e) => e.id !== id));
  }
  function addEntry() {
    const text = newEntry.trim();
    if (!text) return;
    onEditMemorybook([
      ...m.memorybook,
      { id: uid('mem'), text, turn: state.turnCount, source: 'manual', pinned: false },
    ]);
    setNewEntry('');
  }

  return (
    <Modal open={open} onClose={onClose} title="Память истории" wide>
      <p className="text-xs text-gray-500 mb-3">
        ИИ опирается на эти записи. Правьте вручную, если что-то запомнилось неверно.
      </p>

      <h4 className="font-semibold text-sm mb-1">Хроника</h4>
      {m.chronicle.length === 0 && <p className="text-gray-600 text-sm mb-3">— пусто —</p>}
      {m.chronicle.map((c, i) => (
        <textarea
          key={i}
          className="input h-20 mb-2"
          value={c}
          onChange={(e) => onEditChronicle(i, e.target.value)}
        />
      ))}

      <h4 className="font-semibold text-sm mb-1 mt-3">Заметка о текущей арке</h4>
      <textarea
        className="input h-24 mb-3"
        placeholder="Свободная заметка для ИИ — не сжимается автоматически."
        value={m.liveSummary}
        onChange={(e) => onEditLiveSummary(e.target.value)}
      />

      <h4 className="font-semibold text-sm mb-1 mt-3">Меморибук</h4>
      <p className="text-xs text-gray-500 mb-2">
        Авто-записи важных событий. «Закреплена» — всегда в контексте, не вытесняется.
      </p>
      <div className="space-y-1 mb-2">
        {m.memorybook.map((e) => (
          <div key={e.id} className="flex items-start gap-2 bg-panel2 rounded-lg px-2 py-1.5">
            <textarea
              className="input text-xs flex-1 !py-1 h-auto"
              value={e.text}
              onChange={(ev) => patchEntry(e.id, (x) => (x.text = ev.target.value))}
            />
            <button
              className={`text-xs px-2 py-1 rounded ${e.pinned ? 'bg-accent text-white' : 'bg-ink text-gray-400'}`}
              title="Продвинуть в постоянные"
              onClick={() => patchEntry(e.id, (x) => (x.pinned = !x.pinned))}
            >
              📌
            </button>
            <button className="text-xs text-red-400 px-2 py-1" onClick={() => removeEntry(e.id)}>
              ✕
            </button>
          </div>
        ))}
        {m.memorybook.length === 0 && <p className="text-gray-600 text-sm">— пусто —</p>}
      </div>
      <div className="flex gap-2 mb-4">
        <input
          className="input text-sm flex-1"
          placeholder="Добавить запись вручную…"
          value={newEntry}
          onChange={(e) => setNewEntry(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addEntry()}
        />
        <button className="btn-primary !px-3 text-sm" onClick={addEntry}>
          +
        </button>
      </div>

      <h4 className="font-semibold text-sm mb-1">Канонические факты (не сжимаются)</h4>
      <ul className="text-xs space-y-1 text-gray-300">
        {m.facts.slice(-40).map((f, i) => (
          <li key={i}>
            <span className="text-gray-500">[ход {f.turn}]</span> {f.text}
          </li>
        ))}
        {m.facts.length === 0 && <li className="text-gray-600">— пусто —</li>}
      </ul>
    </Modal>
  );
}
