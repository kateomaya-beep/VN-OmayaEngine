import { useEffect, useState } from 'react';
import type { Project, SaveSlot } from '../../../shared/types';
import { Modal } from '../../../shared/ui';
import { listSaves } from '../../../storage/db';
import { formatDate } from '../../../shared/utils';

// Сохранения (ручные слоты + автосейв). История/память/меморибук переехали в
// расширение Game Master (события + свёртки).
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
