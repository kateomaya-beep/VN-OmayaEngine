import { useState } from 'react';
import { Modal, Field } from '../../shared/ui';
import {
  defaultRandomEvents,
  defaultRandomSms,
  RANDOM_EVENT_LABELS,
  type Project,
} from '../../shared/types';
import { usePlayerStore } from '../player/playerStore';
import { LorebookEntriesEditor } from './LorebookEntriesEditor';
import { PhoneSettingsContent } from '../player/components/PhoneSettings';

// Панель «Расширения» — единый хаб настроек проекта: Лорбук, Телефон, События.
// Память живёт в Game Master, а всё про картинки (подключение к image-API, модель,
// ключ, промпт-воркер, стиль, рефы, галерея) — в CG-студии 🎬; здесь их больше нет.
type Ext = 'lorebook' | 'phone' | 'events';

export function ExtensionsPanel({
  open,
  onClose,
  project,
  onPatch,
}: {
  open: boolean;
  onClose: () => void;
  project?: Project | null;
  onPatch?: (mutator: (p: Project) => void) => void;
}) {
  const [tab, setTab] = useState<Ext>('lorebook');
  // Индикатор «ходов с последнего события» — только в живой игре.
  const since = usePlayerStore((s) => s.state?.turnsSinceLastEvent);

  if (!open) return null;

  if (!project || !onPatch) {
    return (
      <Modal open={open} onClose={onClose} title="Управление расширениями">
        <p className="text-sm text-gray-400">
          Откройте проект (в конструкторе или в игре), чтобы настроить его расширения — они
          хранятся на каждый проект отдельно.
        </p>
      </Modal>
    );
  }

  const TABS: { id: Ext; label: string; icon: string }[] = [
    { id: 'lorebook', label: 'Лорбук', icon: '📖' },
    { id: 'phone', label: 'Телефон', icon: '📱' },
    { id: 'events', label: 'События', icon: '🎲' },
  ];

  const re = project.randomEvents ?? defaultRandomEvents();
  const patchRE = (patch: Partial<typeof re>) =>
    onPatch((p) => {
      p.randomEvents = { ...(p.randomEvents ?? defaultRandomEvents()), ...patch };
    });
  const patchType = (id: string, patch: { enabled?: boolean; weight?: number }) =>
    onPatch((p) => {
      const cur = p.randomEvents ?? defaultRandomEvents();
      p.randomEvents = { ...cur, types: cur.types.map((t) => (t.id === id ? { ...t, ...patch } : t)) };
    });
  const phoneOn = !!project.phone?.enabled;
  const sms = project.randomSms ?? defaultRandomSms();
  const patchSms = (patch: Partial<typeof sms>) =>
    onPatch((p) => {
      p.randomSms = { ...(p.randomSms ?? defaultRandomSms()), ...patch };
    });

  return (
    <Modal open={open} onClose={onClose} title="Управление расширениями" wide>
      <div className="flex gap-1 mb-4 flex-wrap">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`px-3 py-1.5 rounded-lg text-sm ${
              tab === t.id ? 'bg-accent text-white' : 'bg-panel2 hover:bg-white/10'
            }`}
            onClick={() => setTab(t.id)}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {tab === 'lorebook' && (
        <div className="max-h-[74vh] overflow-y-auto scrollbar-thin pr-1">
          <LorebookEntriesEditor project={project} onPatch={onPatch} />
        </div>
      )}

      {tab === 'phone' && (
        <div className="max-h-[74vh] overflow-y-auto scrollbar-thin pr-1">
          <PhoneSettingsContent project={project} onPatch={onPatch} />
        </div>
      )}

      {tab === 'events' && (
        <div className="space-y-4">
          <p className="text-xs text-gray-500">
            Движок с заданной вероятностью подмешивает в ход сюжетное событие — скрытой директивой,
            которую ИИ вплетает в обычный ответ (игрок её не видит). Мир становится менее предсказуемым.
          </p>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={re.enabled} onChange={(e) => patchRE({ enabled: e.target.checked })} />
            Включить случайные события
          </label>

          {re.enabled && typeof since === 'number' && (
            <div className="text-xs rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-gray-300">
              Ходов с последнего события:{' '}
              <span className="text-white font-medium">{since < 900 ? since : 'давно / не было'}</span>
              {since < re.cooldownTurns && <span className="text-gray-500"> · идёт кулдаун</span>}
            </div>
          )}

          <div className={`space-y-4 ${re.enabled ? '' : 'opacity-50 pointer-events-none'}`}>
            <div className="grid sm:grid-cols-2 gap-3">
              <Field label={`Шанс на ход: ${re.chancePercent}%`}>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={re.chancePercent}
                  onChange={(e) => patchRE({ chancePercent: Number(e.target.value) })}
                  className="w-full accent-accent2"
                />
              </Field>
              <Field label="Кулдаун (мин. ходов между событиями)">
                <input
                  type="number"
                  min={0}
                  max={100}
                  className="input w-28"
                  value={re.cooldownTurns}
                  onChange={(e) => patchRE({ cooldownTurns: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })}
                />
              </Field>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={re.canInterruptTenseScenes}
                onChange={(e) => patchRE({ canInterruptTenseScenes: e.target.checked })}
              />
              Может прерывать напряжённые/интимные сцены
            </label>

            <div>
              <div className="text-xs uppercase tracking-wide text-gray-500 mb-2">Типы событий и веса</div>
              <div className="space-y-2">
                {re.types.map((t) => (
                  <div key={t.id} className="card flex items-center gap-3 !p-2.5">
                    <input type="checkbox" checked={t.enabled} onChange={(e) => patchType(t.id, { enabled: e.target.checked })} />
                    <div className="flex-1 text-sm">{RANDOM_EVENT_LABELS[t.id].ru}</div>
                    <span className="text-xs text-gray-500">вес</span>
                    <input
                      type="number"
                      min={0}
                      max={20}
                      step={1}
                      className="input w-16 !py-1"
                      value={t.weight}
                      disabled={!t.enabled}
                      onChange={(e) => patchType(t.id, { weight: Math.max(0, Math.min(20, Number(e.target.value) || 0)) })}
                    />
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-gray-500 mt-2">
                «Раскрытие секрета» тянет нить из уже заложенных сюжетных крючков (саммари/лорбук), а не
                выдумывает новую. Отключённые типы не выпадают; больший вес — чаще.
              </p>
            </div>
          </div>

          {/* Случайные входящие СМС — отдельная система (свой тумблер и шанс). */}
          <div className="pt-3 border-t border-white/10 space-y-3">
            <div>
              <h4 className="font-semibold text-sm">📱 Случайные входящие СМС</h4>
              <p className="text-xs text-gray-500">
                Отдельно от событий: контакт из телефона может написать герою «из ниоткуда». Работает только при
                включённом расширении «Телефон» и наличии контактов.
              </p>
            </div>
            {!phoneOn && (
              <p className="text-[11px] text-amber-400">Включите расширение «Телефон» (вкладка «Телефон»), чтобы это работало.</p>
            )}
            <label className={`flex items-center gap-2 text-sm ${phoneOn ? '' : 'opacity-50'}`}>
              <input type="checkbox" checked={sms.enabled} disabled={!phoneOn} onChange={(e) => patchSms({ enabled: e.target.checked })} />
              Включить случайные входящие СМС
            </label>
            <div className={`grid sm:grid-cols-2 gap-3 ${sms.enabled && phoneOn ? '' : 'opacity-50 pointer-events-none'}`}>
              <Field label={`Шанс на ход: ${sms.chancePercent}%`}>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={sms.chancePercent}
                  onChange={(e) => patchSms({ chancePercent: Number(e.target.value) })}
                  className="w-full accent-accent2"
                />
              </Field>
              <Field label="Кулдаун (мин. ходов между СМС)">
                <input
                  type="number"
                  min={0}
                  max={100}
                  className="input w-28"
                  value={sms.cooldownTurns}
                  onChange={(e) => patchSms({ cooldownTurns: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })}
                />
              </Field>
            </div>
            <label className={`flex items-center gap-2 text-sm ${sms.enabled && phoneOn ? '' : 'opacity-50 pointer-events-none'}`}>
              <input
                type="checkbox"
                checked={sms.canInterruptTenseScenes}
                onChange={(e) => patchSms({ canInterruptTenseScenes: e.target.checked })}
              />
              Может приходить в напряжённых сценах
            </label>
            <p className="text-[11px] text-gray-500 -mt-1">
              Для СМС «напряжённые» — это только tense / scary / dangerous. В романтических и эпических
              сценах сообщения приходят всегда: жужжание телефона там только добавляет драмы.
              Если сообщений долго нет — загляните в «Логи» (📃), там написана причина каждого пропуска.
            </p>
          </div>
        </div>
      )}

    </Modal>
  );
}
