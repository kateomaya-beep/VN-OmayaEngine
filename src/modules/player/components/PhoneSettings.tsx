import { useState } from 'react';
import { AssetImage } from '../../../shared/ui';
import { usePlayerStore } from '../playerStore';
import { defaultPhoneConfig, type PhoneConfig, type Project } from '../../../shared/types';

// Настройки телефона (Batch 7): вкл/выкл, иконка, обои, валюта, камера, уведомления.
// Живут в панели «Расширения» (Batch 8-fix). Работают на props,
// чтобы редактироваться и в конструкторе, и в игре.
export function PhoneSettingsContent({
  project,
  onPatch,
}: {
  project: Project;
  onPatch: (m: (p: Project) => void) => void;
}) {
  // Результат теста image-API: null — не запускали; 'testing'; 'ok'; {error}.
  const [imgTest, setImgTest] = useState<null | 'testing' | 'ok' | { error: string }>(null);

  const cfg = project.phone ?? defaultPhoneConfig();
  const patch = (p: Partial<PhoneConfig>) =>
    onPatch((proj) => {
      proj.phone = { ...(proj.phone ?? defaultPhoneConfig()), ...p };
    });

  const wallpapers = project.assets.filter((a) => a.type === 'background' || a.type === 'cg');

  return (
      <div className="space-y-4">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={cfg.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
          Включить расширение «Телефон»
        </label>
        <p className="text-xs text-gray-500 -mt-2">
          Выключенный телефон полностью исчезает: нет иконки, состояние телефона не попадает в контекст ИИ.
        </p>

        <div className={cfg.enabled ? 'space-y-4' : 'space-y-4 opacity-50 pointer-events-none'}>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={cfg.showFloatingIcon}
              onChange={(e) => patch({ showFloatingIcon: e.target.checked })}
            />
            Показывать плавающую иконку (иначе телефон открывается только из бургер-меню)
          </label>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={cfg.popupNotifications}
              onChange={(e) => patch({ popupNotifications: e.target.checked })}
            />
            Всплывающие уведомления о входящих сообщениях
          </label>

          <div>
            <label className="label">Название валюты</label>
            <input
              className="input !w-40"
              value={cfg.currencyName}
              placeholder="$ / кредиты / ₽"
              onChange={(e) => patch({ currencyName: e.target.value || '$' })}
            />
          </div>

          <div>
            <label className="label">Прайс-гайд сеттинга</label>
            <textarea
              className="input h-20 text-xs"
              value={cfg.priceGuide}
              placeholder="кофе ~5, обед ~15, такси ~20, зарплата в месяц ~3000…"
              onChange={(e) => patch({ priceGuide: e.target.value })}
            />
            <p className="text-[11px] text-gray-500 mt-1">
              Ориентиры цен уходят в контекст ИИ — чтобы суммы трат были консистентными. Для фэнтези/истории перепишите под свою экономику.
            </p>
          </div>

          <div>
            <label className="label">Обои рабочего стола</label>
            <div className="flex gap-2 flex-wrap">
              <button
                className={`w-14 h-24 rounded-lg border-2 ${!cfg.wallpaperAssetId ? 'border-accent2' : 'border-white/15'} bg-gradient-to-b from-[#3a2f66] to-[#0b0913]`}
                onClick={() => patch({ wallpaperAssetId: undefined })}
                title="По умолчанию"
              />
              {wallpapers.map((a) => (
                <button
                  key={a.id}
                  className={`w-14 h-24 rounded-lg overflow-hidden border-2 ${cfg.wallpaperAssetId === a.id ? 'border-accent2' : 'border-white/15'}`}
                  onClick={() => patch({ wallpaperAssetId: a.id })}
                  title={a.name}
                >
                  <AssetImage blobKey={a.blobKey} className="w-full h-full object-cover" />
                </button>
              ))}
            </div>
            <p className="text-[11px] text-gray-500 mt-1">Из фонов и CG проекта. (Загрузка отдельных обоев — в ассетах конструктора.)</p>
          </div>

          <div>
            <label className="label">Шаблон промпта: фронталка (селфи)</label>
            <textarea
              className="input h-20 text-xs font-mono"
              value={cfg.cameraPromptTemplate}
              onChange={(e) => patch({ cameraPromptTemplate: e.target.value })}
            />
            <p className="text-[11px] text-gray-500 mt-1">
              Плейсхолдеры: <code>{'{protagonist_name}'}</code>, <code>{'{user_prompt}'}</code>. Дефолт — семи-реализм, фронталка смартфона.
            </p>

            <label className="label mt-3">Шаблон промпта: основная камера</label>
            <textarea
              className="input h-20 text-xs font-mono"
              value={cfg.rearCameraPromptTemplate}
              onChange={(e) => patch({ rearCameraPromptTemplate: e.target.value })}
            />
            <p className="text-[11px] text-gray-500 mt-1">
              Снимок того, что вокруг героя (улица, кофе, комната) — без него самого и без референсов.
              Дополнительно доступны <code>{'{location}'}</code> и <code>{'{time}'}</code> из текущей сцены.
            </p>
            <div className="flex items-center gap-2 mt-2">
              <button
                className="btn-ghost text-xs shrink-0"
                disabled={imgTest === 'testing'}
                onClick={async () => {
                  setImgTest('testing');
                  const err = await usePlayerStore.getState().testImageApi();
                  setImgTest(err ? { error: err } : 'ok');
                }}
              >
                {imgTest === 'testing' ? '⏳ Проверяю…' : '🔌 Тест генерации изображений'}
              </button>
              {imgTest === 'ok' && <span className="text-xs text-green-400">✓ Подключение работает</span>}
              {imgTest && typeof imgTest === 'object' && (
                <span className="text-xs text-red-400 truncate" title={imgTest.error}>
                  ⚠️ {imgTest.error}
                </span>
              )}
            </div>
            <p className="text-[11px] text-gray-500 mt-1">
              Тест генерирует одну маленькую картинку через настроенное image-API (расходует токены/кредиты). Настройка ключа — в 🎬 CG-студии.
            </p>
          </div>

        </div>
      </div>
  );
}
