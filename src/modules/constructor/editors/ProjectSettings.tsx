import { useProjectStore } from '../projectStore';
import { AssetImage, Field } from '../../../shared/ui';
import { defaultFinanceConfig } from '../../../shared/types';

export function ProjectSettings() {
  const { project, update } = useProjectStore();
  if (!project) return null;
  const m = project.meta;
  const covers = project.assets.filter((a) => a.type === 'background' || a.type === 'cg');
  const fin = project.finance ?? defaultFinanceConfig();
  const patchFin = (mut: (f: ReturnType<typeof defaultFinanceConfig>) => void) =>
    update((p) => {
      const f = p.finance ?? defaultFinanceConfig();
      mut(f);
      p.finance = f;
    });

  return (
    <div className="grid md:grid-cols-2 gap-6">
      <div className="card">
        <Field label="Название">
          <input className="input" value={m.title} onChange={(e) => update((p) => (p.meta.title = e.target.value))} />
        </Field>
        <p className="text-xs text-gray-500 mb-3">
          Жанр и тон истории задаются на вкладке «ИИ / Промпт» (стиль/пресет).
        </p>
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

        {/* Финансы/время (Batch 8) — стартовые значения симулятора жизни. */}
        <div className="mt-4 pt-3 border-t border-white/10">
          <div className="text-xs uppercase tracking-wide text-gray-500 mb-2">Симулятор жизни (финансы/время)</div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Стартовый капитал">
              <input
                className="input"
                type="number"
                value={fin.startingBalance}
                onChange={(e) => patchFin((f) => (f.startingBalance = Math.round(Number(e.target.value) || 0)))}
              />
            </Field>
            <Field label="Стартовая дата (ДД/ММ/ГГГГ)">
              <input
                className="input"
                placeholder="15/03/2026"
                value={fin.startDate || ''}
                onChange={(e) => patchFin((f) => (f.startDate = e.target.value || undefined))}
              />
            </Field>
          </div>
          <p className="text-[11px] text-gray-500 mt-1">
            Зарплату/аренду и прочие регулярные статьи можно настроить прямо в игре, в приложении «Банк». Начисления идут по внутриигровым датам.
          </p>
        </div>
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
