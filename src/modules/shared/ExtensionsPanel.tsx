import { useState, useEffect } from 'react';
import { Modal, Field } from '../../shared/ui';
import { ApiConnectionField } from '../constructor/editors/ApiConnectionField';
import { getApiKey, setApiKey } from '../../ai/keys';
import { getConnection } from '../../ai/connection';
import type { Project, VectorizationMode, MemoryConfig } from '../../shared/types';

// Управление расширениями (Batch 3 §1): единая точка вкл/выкл/настройки движковых
// подсистем — Память (саммари + векторизация), Лорбук, Генерация изображений.
// Единый источник истины для этих настроек (раньше дублировались в MemoryEditor,
// ApiPanel и PromptTuner — см. дедуп §6).
type Ext = 'memory' | 'vector' | 'lorebook' | 'image';

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
  const [tab, setTab] = useState<Ext>('memory');
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

  const mc = project.memoryConfig;
  const cfg = project.aiConfig;
  const patchMem = (p: Partial<MemoryConfig>) => onPatch((proj) => Object.assign(proj.memoryConfig, p));

  const TABS: { id: Ext; label: string; icon: string }[] = [
    { id: 'memory', label: 'Память / Саммари', icon: '🧠' },
    { id: 'vector', label: 'Векторизация', icon: '🔎' },
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

      {tab === 'memory' && (
        <div className="space-y-4">
          <div>
            <h4 className="font-semibold mb-2">Саммаризация истории</h4>
            <p className="text-xs text-gray-500 mb-3">
              Свёртка живого окна триггерится по счётчику сообщений. Асинхронно, в фоне; ошибка не
              ломает игру.
            </p>
            <Field label={`Частота свёртки: каждые ${mc.summaryEveryN} ходов`}>
              <div className="flex gap-2">
                {[20, 30, 40].map((n) => (
                  <button
                    key={n}
                    className={`chip !px-3 !py-1.5 ${mc.summaryEveryN === n ? 'bg-accent2 text-white' : ''}`}
                    onClick={() => patchMem({ summaryEveryN: n })}
                  >
                    {n}
                  </button>
                ))}
                <input
                  type="number"
                  min={4}
                  className="input w-24"
                  value={mc.summaryEveryN}
                  onChange={(e) => patchMem({ summaryEveryN: Number(e.target.value) })}
                />
              </div>
            </Field>
            <Field label="Кастомный промпт саммарайзера (опц.)" hint="Пусто — используется дефолтный.">
              <textarea
                className="input h-24"
                value={mc.summaryPrompt || ''}
                onChange={(e) => patchMem({ summaryPrompt: e.target.value || undefined })}
              />
            </Field>
          </div>
          <div>
            <h4 className="font-semibold mb-2">Подключение для саммари</h4>
            <label className="flex items-center gap-2 text-sm mb-3">
              <input
                type="checkbox"
                checked={!!cfg.summaryConnection}
                onChange={(e) =>
                  onPatch((p) => {
                    const g = getConnection();
                    p.aiConfig.summaryConnection = e.target.checked
                      ? { provider: g.provider, baseUrl: g.baseUrl, model: g.model }
                      : undefined;
                  })
                }
              />
              Отдельное подключение (иначе — основное игровое)
            </label>
            {cfg.summaryConnection && (
              <ApiConnectionField
                conn={cfg.summaryConnection}
                keyRole="summary"
                onChange={(conn) => onPatch((p) => (p.aiConfig.summaryConnection = conn))}
              />
            )}
          </div>
        </div>
      )}

      {tab === 'vector' && (
        <div>
          <h4 className="font-semibold mb-2">Векторизация памяти</h4>
          <p className="text-xs text-gray-500 mb-3">
            Подсос релевантных кусков свёрнутой истории по смыслу хода игрока.
          </p>
          <div className="flex gap-2 mb-3">
            {(['off', 'builtin', 'custom'] as VectorizationMode[]).map((m) => (
              <button
                key={m}
                className={`chip !px-3 !py-1.5 ${mc.vectorization === m ? 'bg-accent2 text-white' : ''}`}
                onClick={() => patchMem({ vectorization: m })}
              >
                {m === 'off' ? 'Выкл' : m === 'builtin' ? 'Встроенная модель' : 'Свой API'}
              </button>
            ))}
          </div>
          {mc.vectorization === 'builtin' && (
            <p className="text-xs text-gray-500">
              Модель (~25 МБ, MiniLM) грузится в браузере при первом использовании, считает в Web Worker.
            </p>
          )}
          {mc.vectorization === 'custom' && (
            <ApiConnectionField
              conn={
                mc.embeddingsConnection || {
                  provider: 'openai-compatible',
                  baseUrl: 'https://api.openai.com/v1',
                  model: 'text-embedding-3-small',
                }
              }
              keyRole="embeddings"
              onChange={(conn) => patchMem({ embeddingsConnection: conn })}
            />
          )}
        </div>
      )}

      {tab === 'lorebook' && (
        <div className="space-y-3 text-sm text-gray-300">
          <div>
            <h4 className="font-semibold mb-1">📖 Лорбук (статичный мир)</h4>
            <p className="text-xs text-gray-500">
              Записи лорбука (сработка по ключевым словам) редактируются во вкладке «Лорбук»
              конструктора. Сейчас записей: {project.lorebook.length}. В игре подключаются
              автоматически при совпадении ключей.
            </p>
          </div>
          <div>
            <h4 className="font-semibold mb-1">🧠 Меморибук (динамические вехи)</h4>
            <p className="text-xs text-gray-500">
              Наполняется автоматически по ходу игры (крупные сдвиги отношений, CG-моменты) и
              редактируется прямо в игре через панель «Память» (🧠). Закреплённые записи всегда в
              контексте.
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
