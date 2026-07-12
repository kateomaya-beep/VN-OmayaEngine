import { useState, useEffect } from 'react';
import { Modal, Field } from '../../shared/ui';
import { getApiKey, setApiKey } from '../../ai/keys';
import type { Project } from '../../shared/types';

// Управление расширениями: Лорбук/Меморибук (справка) и Генерация изображений.
// Память (саммари + векторизация) переехала в Game Master (см. правку по Horae).
type Ext = 'lorebook' | 'image';

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
    { id: 'image', label: 'Генерация картинок', icon: '🎨' },
  ];

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
