import { useRef, useState } from 'react';
import { useProjectStore } from '../projectStore';
import { AssetImage, Field } from '../../../shared/ui';
import { uploadAsset } from '../../../storage/assetOps';
import { pushToast } from '../../../shared/toast';
import { defaultFinanceConfig, normalizeNarrativeMode } from '../../../shared/types';

export function ProjectSettings() {
  const { project, update } = useProjectStore();
  if (!project) return null;
  const m = project.meta;
  // В текстовом РП половина настроек мертва: деньги двигаются управляющими битами,
  // которых у прозы нет, а обложке взяться неоткуда — фонов в проекте не бывает.
  const rp = normalizeNarrativeMode(project.mode) === 'rp';
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
        {/* Режим здесь только ПОКАЗЫВАЕТСЯ. Менять его у существующего проекта
            нельзя: у режимов раздельные библиотеки, и переключение флажком увело бы
            проект из той, в которой он лежит, — выглядело бы как пропажа. Перенести
            сеттинг можно кнопкой «Адаптировать» в библиотеке: она делает копию. */}
        <Field label="Режим">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="chip !px-3 !py-1.5 bg-accent2 text-white">
              {rp ? '💬 Классический РП' : '🎭 Визуальная новелла'}
            </span>
            <span className="text-xs text-gray-500">
              {rp
                ? 'Только текст: модель пишет прозу, вы отвечаете своими словами.'
                : 'Спрайты на сцене, фоны, музыка, выборы каждый ход.'}
            </span>
          </div>
        </Field>
        <p className="text-xs text-gray-500 mb-3">
          У каждого режима своя библиотека, свой конструктор и свой пресет. Чтобы вести тот же
          сеттинг в другом режиме, нажмите «Адаптировать» на карточке проекта в библиотеке —
          она сделает копию, а этот проект останется как есть.
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

        {/* Финансы/время (Batch 8) — стартовые значения симулятора жизни. Деньги
            двигаются управляющими битами (transaction), а их в текстовом РП нет:
            там остаётся только стартовая дата, с которой пойдут часы. */}
        <div className="mt-4 pt-3 border-t border-white/10">
          <div className="text-xs uppercase tracking-wide text-gray-500 mb-2">
            {rp ? 'Время' : 'Симулятор жизни (финансы/время)'}
          </div>
          <div className="grid grid-cols-2 gap-3">
            {!rp && (
              <Field label="Стартовый капитал">
                <input
                  className="input"
                  type="number"
                  value={fin.startingBalance}
                  onChange={(e) => patchFin((f) => (f.startingBalance = Math.round(Number(e.target.value) || 0)))}
                />
              </Field>
            )}
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
            {rp
              ? 'С этой даты пойдут внутриигровые часы. Дальше время двигает сама модель — в служебной сводке состояния.'
              : 'Зарплату/аренду и прочие регулярные статьи можно настроить прямо в игре, в приложении «Банк». Начисления идут по внутриигровым датам.'}
          </p>
        </div>
      </div>

      <div className="card">
        <Field
          label="Обложка"
          hint={
            rp
              ? 'Картинка для карточки в библиотеке. Необязательна.'
              : 'Выберите фон или CG в качестве обложки проекта.'
          }
        >
          <div className="aspect-video rounded-lg overflow-hidden bg-panel2 mb-3">
            <AssetImage
              blobKey={project.assets.find((a) => a.id === m.coverAssetId)?.blobKey}
              className="w-full h-full object-cover"
            />
          </div>
          {/* В текстовом режиме вкладки «Ассеты» нет, отправлять за обложкой туда
              некуда — грузим прямо здесь. */}
          {rp ? (
            <CoverUpload
              onPick={(assetId) =>
                update((p) => {
                  p.meta.coverAssetId = assetId;
                })
              }
              hasCover={!!m.coverAssetId}
              onClear={() => update((p) => (p.meta.coverAssetId = undefined))}
            />
          ) : covers.length === 0 ? (
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


// Загрузка обложки прямо из настроек — нужна текстовому режиму, где вкладки
// «Ассеты» нет вовсе. Картинка кладётся обычным ассетом типа 'icon', поэтому едет
// с проектом при экспорте и копировании без отдельной ветки в хранилище.
function CoverUpload({
  onPick,
  hasCover,
  onClear,
}: {
  onPick: (assetId: string) => void;
  hasCover: boolean;
  onClear: () => void;
}) {
  const { update } = useProjectStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function pick(file: File) {
    setBusy(true);
    try {
      const asset = await uploadAsset(file, 'icon');
      update((p) => {
        p.assets = [...p.assets, asset];
      });
      onPick(asset.id);
    } catch (e) {
      pushToast('error', 'Не удалось загрузить обложку: ' + (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex gap-2">
      <button className="btn-ghost !py-1.5 !px-3 text-xs" disabled={busy} onClick={() => fileRef.current?.click()}>
        {busy ? 'Загружаю…' : hasCover ? 'Заменить картинку' : 'Загрузить картинку'}
      </button>
      {hasCover && (
        <button className="btn-ghost !py-1.5 !px-3 text-xs" onClick={onClear}>
          Убрать
        </button>
      )}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void pick(f);
          e.target.value = '';
        }}
      />
    </div>
  );
}
