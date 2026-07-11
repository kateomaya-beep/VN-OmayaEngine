import { useEffect, useState } from 'react';
import type { Project, RuntimeState, SaveSlot } from '../../../shared/types';
import { Modal } from '../../../shared/ui';
import { listSaves } from '../../../storage/db';
import { formatDate } from '../../../shared/utils';
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
      entries.push({ speaker: '▸ Вы', text: msg.content.replace(/^\[НАЧАЛО ИГРЫ\]\s*/, '') });
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

// "Memory" screen: player sees summaries + facts and can edit them (see ТЗ §10 UX).
export function MemoryPanel({
  open,
  onClose,
  state,
  onEditChapterSummary,
  onEditChronicle,
}: {
  open: boolean;
  onClose: () => void;
  state: RuntimeState;
  onEditChapterSummary: (text: string) => void;
  onEditChronicle: (index: number, text: string) => void;
}) {
  const m = state.memory;
  return (
    <Modal open={open} onClose={onClose} title="Память истории" wide>
      <p className="text-xs text-gray-500 mb-3">
        ИИ опирается на эти записи. Правьте вручную, если что-то запомнилось неверно.
      </p>

      <h4 className="font-semibold text-sm mb-1">Хроника (главы)</h4>
      {m.chronicle.length === 0 && <p className="text-gray-600 text-sm mb-3">— пусто —</p>}
      {m.chronicle.map((c, i) => (
        <textarea
          key={i}
          className="input h-20 mb-2"
          value={c}
          onChange={(e) => onEditChronicle(i, e.target.value)}
        />
      ))}

      <h4 className="font-semibold text-sm mb-1 mt-3">Текущая глава</h4>
      <textarea
        className="input h-24 mb-3"
        value={m.currentChapterSummary}
        onChange={(e) => onEditChapterSummary(e.target.value)}
      />

      <h4 className="font-semibold text-sm mb-1">Канонические факты (не сжимаются)</h4>
      <ul className="text-xs space-y-1 text-gray-300">
        {m.facts.slice(-40).map((f, i) => (
          <li key={i}>
            <span className="text-gray-500">[гл.{f.chapter}]</span> {f.text}
          </li>
        ))}
        {m.facts.length === 0 && <li className="text-gray-600">— пусто —</li>}
      </ul>
    </Modal>
  );
}
