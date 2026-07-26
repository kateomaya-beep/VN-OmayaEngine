import { useState } from 'react';
import { Modal, AssetImage } from '../../../shared/ui';
import { usePlayerStore } from '../playerStore';
import { defaultPhoneConfig, type PhoneConfig } from '../../../shared/types';

// Настройки телефона (Batch 7): вкл/выкл, иконка, обои, валюта, камера, уведомления,
// категории магазина. Открывается из бургер-меню плеера.
export function PhoneSettings({ open, onClose }: { open: boolean; onClose: () => void }) {
  const s = usePlayerStore();
  const project = s.project;
  const [newCat, setNewCat] = useState('');
  if (!open || !project) return null;

  const cfg = project.phone ?? defaultPhoneConfig();
  const patch = (p: Partial<PhoneConfig>) =>
    s.patchProject((proj) => {
      proj.phone = { ...(proj.phone ?? defaultPhoneConfig()), ...p };
    });

  const wallpapers = project.assets.filter((a) => a.type === 'background' || a.type === 'cg');

  return (
    <Modal open={open} onClose={onClose} title="📱 Телефон — настройки" wide>
      <div className="space-y-4 max-h-[72vh] overflow-y-auto scrollbar-thin pr-1">
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
            <label className="label">Шаблон промпта камеры</label>
            <textarea
              className="input h-16 text-xs font-mono"
              value={cfg.cameraPromptTemplate}
              onChange={(e) => patch({ cameraPromptTemplate: e.target.value })}
            />
            <p className="text-[11px] text-gray-500 mt-1">
              Плейсхолдеры: <code>{'{protagonist_name}'}</code>, <code>{'{user_prompt}'}</code>.
            </p>
          </div>

          <div>
            <label className="label">Категории магазина</label>
            <div className="flex gap-1.5 flex-wrap mb-2">
              {cfg.shopCategories.map((c) => (
                <span key={c} className="chip">
                  {c}
                  <button
                    className="ml-1 text-red-300"
                    onClick={() => patch({ shopCategories: cfg.shopCategories.filter((x) => x !== c) })}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                className="input flex-1"
                placeholder="Новая категория"
                value={newCat}
                onChange={(e) => setNewCat(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newCat.trim() && !cfg.shopCategories.includes(newCat.trim())) {
                    patch({ shopCategories: [...cfg.shopCategories, newCat.trim()] });
                    setNewCat('');
                  }
                }}
              />
              <button
                className="btn-ghost shrink-0"
                onClick={() => {
                  if (newCat.trim() && !cfg.shopCategories.includes(newCat.trim())) {
                    patch({ shopCategories: [...cfg.shopCategories, newCat.trim()] });
                    setNewCat('');
                  }
                }}
              >
                + Категория
              </button>
            </div>
          </div>

          <p className="text-[11px] text-gray-500">
            Мессенджер с ответами ботов, покупки, камера и полная связь с контекстом ИИ — в следующих обновлениях телефона.
          </p>
        </div>
      </div>
    </Modal>
  );
}
