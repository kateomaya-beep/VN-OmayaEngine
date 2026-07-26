import { useRef, useState } from 'react';
import { uid } from '../../shared/utils';
import { matchLorebook } from '../../ai/lorebookEngine';
import { parseWorldInfo, exportWorldInfo } from '../../storage/worldInfo';
import { downloadBlob } from '../../storage/zip';
import type { LorebookEntry, Project } from '../../shared/types';

// Полноценный редактор лорбука (как в конструкторе) на props — используется и во
// вкладке «Лорбук» конструктора, и в панели «Расширения».
export function LorebookEntriesEditor({
  project,
  onPatch,
}: {
  project: Project;
  onPatch: (mutator: (p: Project) => void) => void;
}) {
  const [testText, setTestText] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  async function importWorldInfo(file: File) {
    try {
      const entries = parseWorldInfo(JSON.parse(await file.text()));
      if (!entries.length) throw new Error('В файле не найдено ни одной записи');
      onPatch((p) => p.lorebook.push(...entries));
    } catch (e) {
      alert('Не удалось импортировать World Info: ' + (e as Error).message);
    }
  }

  function doExportWorldInfo() {
    const data = exportWorldInfo(project.lorebook);
    downloadBlob(
      new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
      `${project.meta.title} — world_info.json`
    );
  }

  const matched = testText.trim()
    ? new Set(matchLorebook(project.lorebook, testText).map((e) => e.id))
    : new Set<string>();

  function add() {
    onPatch((p) =>
      p.lorebook.push({
        id: uid('lb'),
        title: 'Новая запись',
        keys: [],
        content: '',
        alwaysActive: false,
        priority: 0,
      })
    );
  }
  function patch(id: string, fn: (e: LorebookEntry) => void) {
    onPatch((p) => {
      const e = p.lorebook.find((e) => e.id === id);
      if (e) fn(e);
    });
  }

  return (
    <div className="grid lg:grid-cols-[1fr_280px] gap-4">
      <div>
        <div className="flex justify-between items-center mb-3 flex-wrap gap-2">
          <p className="text-sm text-gray-400">
            Записи инъектятся в контекст, когда их ключи встречаются в тексте (или всегда).
          </p>
          <div className="flex gap-2">
            <input
              ref={fileRef}
              type="file"
              accept=".json"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) importWorldInfo(f);
                e.target.value = '';
              }}
            />
            <button
              className="btn-ghost text-xs"
              title="Импорт лорбука в формате SillyTavern World Info"
              onClick={() => fileRef.current?.click()}
            >
              Импорт
            </button>
            <button className="btn-ghost text-xs" onClick={doExportWorldInfo}>
              Экспорт
            </button>
            <button className="btn-primary !py-1.5 text-sm" onClick={add}>
              + Запись
            </button>
          </div>
        </div>
        {project.lorebook.length === 0 && (
          <div className="card text-center text-gray-500 py-8">Лорбук пуст.</div>
        )}
        <div className="space-y-3 max-h-[56vh] overflow-y-auto scrollbar-thin pr-1">
          {project.lorebook.map((e) => (
            <div key={e.id} className={`card ${matched.has(e.id) ? 'ring-2 ring-accent2' : ''}`}>
              <div className="flex gap-2 mb-2">
                <input
                  className="input flex-1"
                  value={e.title}
                  onChange={(ev) => patch(e.id, (x) => (x.title = ev.target.value))}
                />
                <input
                  type="number"
                  className="input w-20"
                  title="Приоритет"
                  value={e.priority}
                  onChange={(ev) => patch(e.id, (x) => (x.priority = Number(ev.target.value)))}
                />
              </div>
              <label className="label">Ключи (через запятую)</label>
              <input
                className="input mb-2"
                placeholder="Арес, кулон, тайна..."
                value={e.keys.join(', ')}
                onChange={(ev) =>
                  patch(e.id, (x) => (x.keys = ev.target.value.split(',').map((s) => s.trim()).filter(Boolean)))
                }
              />
              <label className="label">Содержимое</label>
              <textarea
                className="input h-20"
                value={e.content}
                onChange={(ev) => patch(e.id, (x) => (x.content = ev.target.value))}
              />
              <div className="flex items-center justify-between mt-2">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={e.alwaysActive}
                    onChange={(ev) => patch(e.id, (x) => (x.alwaysActive = ev.target.checked))}
                  />
                  Всегда активна
                </label>
                <button
                  className="btn-danger !px-3 !py-1 text-xs"
                  onClick={() => onPatch((p) => (p.lorebook = p.lorebook.filter((x) => x.id !== e.id)))}
                >
                  Удалить
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="card h-fit">
        <h4 className="font-semibold mb-2">Тест ключей</h4>
        <p className="text-xs text-gray-500 mb-2">Введите текст — подсветятся сработавшие записи.</p>
        <textarea
          className="input h-28"
          placeholder="Например: Арес показал мне кулон..."
          value={testText}
          onChange={(e) => setTestText(e.target.value)}
        />
        <div className="mt-3 text-sm">
          {testText.trim() ? (
            matched.size ? (
              <ul className="space-y-1">
                {project.lorebook
                  .filter((e) => matched.has(e.id))
                  .map((e) => (
                    <li key={e.id} className="text-accent2">✓ {e.title}</li>
                  ))}
              </ul>
            ) : (
              <span className="text-gray-500">Ничего не сработало.</span>
            )
          ) : (
            <span className="text-gray-600">—</span>
          )}
        </div>
      </div>
    </div>
  );
}
