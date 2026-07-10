import { useProjectStore } from '../projectStore';
import { AssetImage } from '../../../shared/ui';
import { uid } from '../../../shared/utils';
import type { StatDefinition } from '../../../shared/types';

export function StatsEditor() {
  const { project, update } = useProjectStore();
  if (!project) return null;
  const icons = project.assets.filter((a) => a.type === 'icon');

  function addStat() {
    update((p) =>
      p.stats.push({
        id: uid('stat'),
        name: 'Новый стат',
        min: 0,
        max: 100,
        initial: 0,
        visible: true,
        description: '',
      })
    );
  }

  function patch(id: string, patch: Partial<StatDefinition>) {
    update((p) => {
      const s = p.stats.find((s) => s.id === id);
      if (s) Object.assign(s, patch);
    });
  }

  return (
    <div className="max-w-4xl">
      <div className="flex justify-between items-center mb-4">
        <p className="text-sm text-gray-400">
          Статы влияют на механики. Описание помогает ИИ понять, когда менять стат.
        </p>
        <button className="btn-primary" onClick={addStat}>
          + Стат
        </button>
      </div>

      {project.stats.length === 0 && (
        <div className="card text-center text-gray-500 py-10">Статов пока нет.</div>
      )}

      <div className="space-y-3">
        {project.stats.map((s) => (
          <div key={s.id} className="card">
            <div className="grid md:grid-cols-2 gap-3">
              <div>
                <label className="label">Название</label>
                <input
                  className="input"
                  value={s.name}
                  onChange={(e) => patch(s.id, { name: e.target.value })}
                />
                <div className="grid grid-cols-3 gap-2 mt-2">
                  <div>
                    <label className="label">Мин</label>
                    <input
                      type="number"
                      className="input"
                      value={s.min}
                      onChange={(e) => patch(s.id, { min: Number(e.target.value) })}
                    />
                  </div>
                  <div>
                    <label className="label">Макс</label>
                    <input
                      type="number"
                      className="input"
                      value={s.max}
                      onChange={(e) => patch(s.id, { max: Number(e.target.value) })}
                    />
                  </div>
                  <div>
                    <label className="label">Старт</label>
                    <input
                      type="number"
                      className="input"
                      value={s.initial}
                      onChange={(e) => patch(s.id, { initial: Number(e.target.value) })}
                    />
                  </div>
                </div>
                <label className="flex items-center gap-2 mt-3 text-sm">
                  <input
                    type="checkbox"
                    checked={s.visible}
                    onChange={(e) => patch(s.id, { visible: e.target.checked })}
                  />
                  Видимый в HUD
                </label>
              </div>
              <div>
                <label className="label">Описание (для ИИ)</label>
                <textarea
                  className="input h-20"
                  placeholder="Когда этот стат должен меняться?"
                  value={s.description}
                  onChange={(e) => patch(s.id, { description: e.target.value })}
                />
                <div className="grid grid-cols-2 gap-2 mt-2">
                  <div>
                    <label className="label">Связан с персонажем</label>
                    <select
                      className="input"
                      value={project.characters.find((c) => c.linkedStatId === s.id)?.id || ''}
                      onChange={(e) =>
                        update((p) => {
                          for (const c of p.characters)
                            if (c.linkedStatId === s.id) c.linkedStatId = undefined;
                          const c = p.characters.find((c) => c.id === e.target.value);
                          if (c) c.linkedStatId = s.id;
                        })
                      }
                    >
                      <option value="">—</option>
                      {project.characters.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="label">Иконка</label>
                    <div className="flex items-center gap-2">
                      {s.iconAssetId && (
                        <AssetImage
                          blobKey={project.assets.find((a) => a.id === s.iconAssetId)?.blobKey}
                          className="w-8 h-8 rounded object-cover"
                        />
                      )}
                      <select
                        className="input"
                        value={s.iconAssetId || ''}
                        onChange={(e) => patch(s.id, { iconAssetId: e.target.value || undefined })}
                      >
                        <option value="">—</option>
                        {icons.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div className="mt-3 flex items-center justify-between">
              <code className="text-xs text-gray-600">{s.id}</code>
              <button
                className="btn-danger !px-3 !py-1 text-xs"
                onClick={() => update((p) => (p.stats = p.stats.filter((x) => x.id !== s.id)))}
              >
                Удалить
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
