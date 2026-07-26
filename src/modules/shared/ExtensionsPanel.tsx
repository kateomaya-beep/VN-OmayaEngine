import { useState, useEffect } from 'react';
import { Modal, Field } from '../../shared/ui';
import { getApiKey, setApiKey } from '../../ai/keys';
import { defaultRandomEvents, RANDOM_EVENT_LABELS, type Project } from '../../shared/types';

// Управление расширениями: Лорбук/Меморибук (справка), Генерация изображений,
// Случайные события. Память переехала в Game Master.
type Ext = 'lorebook' | 'image' | 'events';

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
  const [imageKey, setImageKey] = useState('');

  useEffect(() => {
    setImageKey(getApiKey('image'));
  }, [open]);

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

  const cfg = project.aiConfig;

  const TABS: { id: Ext; label: string; icon: string }[] = [
    { id: 'lorebook', label: 'Лорбук / Меморибук', icon: '📖' },
    { id: 'events', label: 'Случайные события', icon: '🎲' },
    { id: 'image', label: 'Генерация картинок', icon: '🎨' },
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
        <div className="space-y-3 text-sm text-gray-300">
          <div>
            <h4 className="font-semibold mb-1">📖 Лорбук (статичный мир)</h4>
            <p className="text-xs text-gray-500">
              Записи лорбука (сработка по ключевым словам) редактируются во вкладке «Лорбук»
              конструктора. Сейчас записей: {project.lorebook.length}. В игре активные записи
              (по совпадению ключей) и описание мира отправляются ИИ автоматически.
            </p>
          </div>
          <div>
            <h4 className="font-semibold mb-1">🧠 Память персонажей и сюжета</h4>
            <p className="text-xs text-gray-500">
              Динамическая память (досье персонажей, события, отношения, саммари, векторизация)
              теперь живёт в расширении <b>Game Master</b> (🎮) — она наполняется ИИ каждый ход.
            </p>
          </div>
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
        </div>
      )}

      {tab === 'image' && (
        <div>
          <h4 className="font-semibold mb-2">Генерация изображений (image-API)</h4>
          <p className="text-xs text-gray-500 mb-3">
            OpenAI-совместимый эндпоинт /images/generations. Ключ хранится только в этом браузере.
            Используется кнопками «Создать фон/CG» в игре.
          </p>
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Image Base URL" hint="Пусто — берётся Base URL основного подключения.">
              <input
                className="input"
                value={cfg.imageBaseUrl || ''}
                placeholder="https://api.openai.com/v1"
                onChange={(e) => onPatch((p) => (p.aiConfig.imageBaseUrl = e.target.value || undefined))}
              />
            </Field>
            <Field label="Image модель">
              <input
                className="input"
                value={cfg.imageModel || ''}
                placeholder="gpt-image-1"
                onChange={(e) => onPatch((p) => (p.aiConfig.imageModel = e.target.value || undefined))}
              />
            </Field>
          </div>
          <Field label="Image API-ключ" hint="localStorage, уходит только к image-провайдеру.">
            <input
              className="input"
              type="password"
              value={imageKey}
              placeholder="sk-..."
              onChange={(e) => {
                setImageKey(e.target.value);
                setApiKey('image', e.target.value);
              }}
            />
          </Field>
        </div>
      )}
    </Modal>
  );
}
