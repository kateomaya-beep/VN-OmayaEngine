import { useProjectStore } from '../projectStore';
import { AssetImage, Field } from '../../../shared/ui';
import { defaultFinanceConfig, normalizeNarrativeMode } from '../../../shared/types';

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
        <Field label="Режим повествования">
          <select
            className="input"
            value={project.mode ?? 'vn'}
            onChange={(e) => update((p) => (p.mode = normalizeNarrativeMode(e.target.value)))}
          >
            <option value="vn">Визуальная новелла — спрайты, сцены, выборы</option>
            <option value="rp">Классический РП — только текст, игрок пишет сам</option>
          </select>
        </Field>
        <p className="text-xs text-gray-500 mb-3">
          Сеттинг, персонажи, лорбук и память общие для обоих режимов — меняется только то,
          как идёт ход: в РП модель пишет обычную прозу, не пишет за героя и не предлагает
          выборов. Свой набор блоков промпта у каждого режима — см. пресет (🎚).
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

      {/* Свои макросы проекта: {{имя}} → текст. Раскрываются везде, где работают
          встроенные — в блоках пресета, лорбуке, описаниях мира и персонажей. */}
      <div className="card md:col-span-2">
        <div className="flex items-center justify-between mb-2">
          <div>
            <h4 className="font-semibold">Свои макросы</h4>
            <p className="text-xs text-gray-500">
              Короткое имя вместо длинного куска текста. Пишется как <code>{'{{имя}}'}</code> и
              подставляется в промпт: в блоках пресета, лорбуке, описании мира и карточках. Внутри
              значения можно пользоваться встроенными макросами (<code>{'{{user}}'}</code> и
              остальными), но не другими своими.
            </p>
          </div>
          <button
            className="btn-ghost !px-3 !py-1 text-xs whitespace-nowrap"
            onClick={() => update((p) => (p.macros = [...(p.macros || []), { name: '', value: '' }]))}
          >
            + Макрос
          </button>
        </div>
        {(project.macros || []).length === 0 ? (
          <p className="text-xs text-gray-500">Пока ни одного.</p>
        ) : (
          <div className="space-y-2">
            {(project.macros || []).map((mac, i) => {
              const bad = mac.name.trim() !== '' && !/^[\w.-]+$/.test(mac.name.trim());
              return (
                <div key={i} className="flex gap-2 items-start">
                  <div className="w-40 shrink-0">
                    <input
                      className={`input !py-1 text-sm font-mono ${bad ? 'border-red-500/60' : ''}`}
                      placeholder="имя"
                      value={mac.name}
                      onChange={(e) =>
                        update((p) => {
                          if (p.macros) p.macros[i].name = e.target.value;
                        })
                      }
                    />
                    {bad && (
                      <p className="text-[11px] text-red-400 mt-1">
                        Только буквы, цифры, точка и дефис — иначе макрос не сработает.
                      </p>
                    )}
                  </div>
                  <textarea
                    className="input !py-1 text-sm h-16 flex-1"
                    placeholder="значение"
                    value={mac.value}
                    onChange={(e) =>
                      update((p) => {
                        if (p.macros) p.macros[i].value = e.target.value;
                      })
                    }
                  />
                  <button
                    className="btn-danger !px-2 !py-1 text-xs"
                    title="Удалить макрос"
                    onClick={() => update((p) => (p.macros = (p.macros || []).filter((_, j) => j !== i)))}
                  >
                    ✕
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
