import { useProjectStore } from '../projectStore';
import { AssetImage, Field } from '../../../shared/ui';

export function ProjectSettings() {
  const { project, update } = useProjectStore();
  if (!project) return null;
  const m = project.meta;
  const covers = project.assets.filter((a) => a.type === 'background' || a.type === 'cg');

  return (
    <div className="grid md:grid-cols-2 gap-6">
      <div className="card">
        <Field label="Название">
          <input className="input" value={m.title} onChange={(e) => update((p) => (p.meta.title = e.target.value))} />
        </Field>
        <Field label="Автор">
          <input className="input" value={m.author} onChange={(e) => update((p) => (p.meta.author = e.target.value))} />
        </Field>
        <Field label="Жанр">
          <input className="input" value={m.genre} onChange={(e) => update((p) => (p.meta.genre = e.target.value))} />
        </Field>
        <Field label="Описание">
          <textarea
            className="input h-24"
            value={m.description}
            onChange={(e) => update((p) => (p.meta.description = e.target.value))}
          />
        </Field>
        <Field label="Рейтинг контента">
          <select
            className="input"
            value={m.contentRating}
            onChange={(e) => update((p) => (p.meta.contentRating = e.target.value as 'sfw' | 'mature'))}
          >
            <option value="sfw">SFW</option>
            <option value="mature">Mature (18+)</option>
          </select>
        </Field>
      </div>

      <div className="card">
        <Field label="Обложка" hint="Выберите фон или CG в качестве обложки проекта.">
          <div className="aspect-video rounded-lg overflow-hidden bg-panel2 mb-3">
            <AssetImage
              blobKey={project.assets.find((a) => a.id === m.coverAssetId)?.blobKey}
              className="w-full h-full object-cover"
            />
          </div>
          {covers.length === 0 ? (
            <p className="text-xs text-gray-500">Загрузите фоны на вкладке «Ассеты».</p>
          ) : (
            <div className="grid grid-cols-4 gap-2">
              {covers.map((a) => (
                <button
                  key={a.id}
                  className={`aspect-video rounded overflow-hidden border-2 ${
                    m.coverAssetId === a.id ? 'border-accent' : 'border-transparent'
                  }`}
                  onClick={() => update((p) => (p.meta.coverAssetId = a.id))}
                >
                  <AssetImage blobKey={a.blobKey} className="w-full h-full object-cover" />
                </button>
              ))}
            </div>
          )}
        </Field>
      </div>
    </div>
  );
}
