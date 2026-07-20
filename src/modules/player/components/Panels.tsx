import { useEffect, useState } from 'react';
import { Modal } from '../../../shared/ui';
import { useLang } from '../../../shared/i18n';
import { usePlayerStore } from '../playerStore';
import { listPlaythroughs, type PlaythroughInfo } from '../../../storage/playthroughs';
import type { SaveSlot } from '../../../shared/types';
import { formatDate } from '../../../shared/utils';

// Сохранения (Batch 5.2): автосейв-курсор непрерывен и невидим; здесь — РУЧНЫЕ
// чекпоинты/ветки текущего прохождения (создать/переключиться/переименовать/удалить,
// увидеть точку форка) + переход к другим прохождениям проекта.
export function SaveLoadPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const lang = useLang((s) => s.lang);
  const L = (ru: string, en: string) => (lang === 'en' ? en : ru);
  const s = usePlayerStore();
  const project = s.project;
  const [list, setList] = useState<PlaythroughInfo[]>([]);
  const [name, setName] = useState('');

  async function refresh() {
    if (project) setList(await listPlaythroughs(project.id));
  }
  useEffect(() => {
    if (open) refresh();
  }, [open, s.playthroughId, s.currentCheckpointId]);

  if (!project) return null;

  const current = list.find((p) => p.id === s.playthroughId);
  const others = list.filter((p) => p.id !== s.playthroughId);

  // Имя чекпоинта по id (для отображения точки форка текущей линии).
  const cpName = (id?: string): string | null => {
    if (!id) return null;
    for (const p of list) {
      const c = p.checkpoints.find((c) => c.checkpointId === id);
      if (c) return c.branchName || c.title;
    }
    return null;
  };

  async function createCp() {
    await s.createCheckpoint(name.trim() || undefined);
    setName('');
    setTimeout(refresh, 150);
  }
  async function rename(cp: SaveSlot) {
    const next = window.prompt(L('Новое имя чекпоинта', 'New checkpoint name'), cp.branchName || cp.title);
    if (next && next.trim()) {
      await s.renameCheckpoint(cp.slot, next.trim());
      setTimeout(refresh, 150);
    }
  }
  async function del(cp: SaveSlot) {
    if (window.confirm(L(`Удалить чекпоинт «${cp.branchName || cp.title}»?`, `Delete checkpoint "${cp.branchName || cp.title}"?`))) {
      await s.deleteCheckpoint(cp.slot);
      setTimeout(refresh, 150);
    }
  }
  function switchTo(save: SaveSlot) {
    void s.resumeSave(project!.id, save);
    onClose();
  }

  const forkFrom = cpName(s.currentCheckpointId);

  return (
    <Modal open={open} onClose={onClose} title={L('Сохранения и прохождения', 'Saves & playthroughs')} wide>
      <div className="max-h-[68vh] overflow-y-auto scrollbar-thin space-y-4 pr-1">
        {/* Ручное сохранение (чекпоинт) */}
        <div className="card !bg-panel2 !p-3">
          <div className="text-sm font-medium mb-1">{L('Ручное сохранение', 'Manual save')}</div>
          <p className="text-xs text-gray-500 mb-2">
            {L('Именованная точка-ветка: полная копия истории до текущего момента, её можно загрузить в любой момент. Автосохранение идёт само, отдельно (ниже).', 'A named branch point: a full copy of the story up to now that you can load anytime. Autosave runs on its own, separately (below).')}
          </p>
          {forkFrom && (
            <p className="text-xs text-gray-500 mb-2">
              {L('Текущая линия форкнута от', 'Current line forked from')}: <span className="text-accent2">⑂ {forkFrom}</span>
            </p>
          )}
          <div className="flex gap-2">
            <input
              className="input flex-1"
              placeholder={L('Имя (необязательно)', 'Name (optional)')}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && createCp()}
            />
            <button className="btn-primary shrink-0" onClick={createCp}>
              💾 {L('Сохранить', 'Save')}
            </button>
          </div>
        </div>

        {/* Автосохранения (кольцо последних ходов) — откат, если прогресс слетел */}
        <div>
          <div className="text-xs uppercase tracking-wide text-gray-500 mb-2">
            {L('Автосохранения', 'Autosaves')} · {L('последние ходы', 'recent turns')}
          </div>
          <p className="text-xs text-gray-500 mb-2">
            {L('Сохраняются автоматически каждый ход. Если прогресс слетел — загрузите нужный ход.', 'Saved automatically every turn. If progress was lost, load the turn you need.')}
          </p>
          {(() => {
            // Курсор «последнее» + кольцо автоснимков (без дубля самого свежего хода).
            const cursor = current?.autosave || null;
            const snaps = (current?.autosnaps || []).filter(
              (a) => !cursor || a.state.turnCount !== cursor.state.turnCount
            );
            const items = cursor ? [cursor, ...snaps] : snaps;
            if (items.length === 0)
              return <p className="text-sm text-gray-600">{L('Пока нет автосохранений.', 'No autosaves yet.')}</p>;
            return (
              <div className="space-y-2">
                {items.map((a) => (
                  <div key={a.slot} className="card flex items-center justify-between !p-3">
                    <div className="min-w-0">
                      <div className="font-medium text-sm truncate">
                        💾 {L('Ход', 'Turn')} {a.state.turnCount}
                        {a === cursor && (
                          <span className="text-accent2"> · {L('последнее', 'latest')}</span>
                        )}
                      </div>
                      <div className="text-xs text-gray-500">{formatDate(a.savedAt)}</div>
                    </div>
                    <button className="btn-primary !px-2 !py-1 text-xs shrink-0" onClick={() => switchTo(a)}>
                      {L('Загрузить', 'Load')}
                    </button>
                  </div>
                ))}
              </div>
            );
          })()}
        </div>

        {/* Ручные сохранения текущего прохождения */}
        <div>
          <div className="text-xs uppercase tracking-wide text-gray-500 mb-2">
            {current?.label || L('Текущее прохождение', 'Current playthrough')} · {L('ручные сохранения', 'manual saves')}
          </div>
          {(!current || current.checkpoints.length === 0) && (
            <p className="text-sm text-gray-600">{L('Пока нет ручных сохранений.', 'No manual saves yet.')}</p>
          )}
          <div className="space-y-2">
            {current?.checkpoints.map((c) => (
              <div key={c.slot} className="card flex items-center justify-between !p-3">
                <div className="min-w-0">
                  <div className="font-medium text-sm truncate">⑂ {c.branchName || c.title}</div>
                  <div className="text-xs text-gray-500">
                    {L('ход', 'turn')} {c.state.turnCount} · {formatDate(c.savedAt)}
                    {cpName(c.parentCheckpointId) && ` · ${L('от', 'from')} ${cpName(c.parentCheckpointId)}`}
                  </div>
                </div>
                <div className="flex gap-1 shrink-0">
                  <button className="btn-primary !px-2 !py-1 text-xs" onClick={() => switchTo(c)}>
                    {L('Перейти', 'Switch')}
                  </button>
                  <button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => rename(c)}>
                    ✎
                  </button>
                  <button className="btn-ghost !px-2 !py-1 text-xs text-red-300" onClick={() => del(c)}>
                    ✕
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Другие прохождения */}
        {others.length > 0 && (
          <div>
            <div className="text-xs uppercase tracking-wide text-gray-500 mb-2">{L('Другие прохождения', 'Other playthroughs')}</div>
            <div className="space-y-2">
              {others.map((p) => (
                <div key={p.id} className="card flex items-center justify-between !p-3">
                  <div className="min-w-0">
                    <div className="font-medium text-sm truncate">{p.label}</div>
                    <div className="text-xs text-gray-500">
                      {p.autosave ? `${L('ход', 'turn')} ${p.autosave.state.turnCount}` : L('нет автосейва', 'no autosave')} ·{' '}
                      {p.checkpoints.length} {L('чекпоинт(ов)', 'checkpoint(s)')}
                    </div>
                  </div>
                  {(p.autosave || p.checkpoints[0]) && (
                    <button
                      className="btn-ghost !px-2 !py-1 text-xs shrink-0"
                      onClick={() => switchTo(p.autosave || p.checkpoints[p.checkpoints.length - 1])}
                    >
                      {L('Загрузить', 'Load')}
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
