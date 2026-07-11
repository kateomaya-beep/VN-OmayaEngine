import { useProjectStore } from '../projectStore';
import { Field } from '../../../shared/ui';
import { ApiConnectionField } from './ApiConnectionField';
import type { MemoryConfig, VectorizationMode } from '../../../shared/types';

// Настройки памяти проекта (см. CR v2 §E): частота свёртки, кастомный промпт,
// отдельное API-подключение для саммари, режим векторизации.
export function MemoryEditor() {
  const { project, update } = useProjectStore();
  if (!project) return null;
  const mc = project.memoryConfig;

  function patch(p: Partial<MemoryConfig>) {
    update((proj) => Object.assign(proj.memoryConfig, p));
  }

  const useCustomSummaryConn = !!project.aiConfig.summaryConnection;

  return (
    <div className="max-w-3xl space-y-4">
      <div className="card">
        <h4 className="font-semibold mb-3">Саммаризация истории</h4>
        <p className="text-xs text-gray-500 mb-3">
          Глав больше нет — свёртка живого окна триггерится по счётчику сообщений.
          Асинхронно, в фоне; ошибка не ломает игру.
        </p>
        <Field label={`Частота свёртки: каждые ${mc.summaryEveryN} ходов`}>
          <div className="flex gap-2">
            {[20, 30, 40].map((n) => (
              <button
                key={n}
                className={`chip !px-3 !py-1.5 ${mc.summaryEveryN === n ? 'bg-accent2 text-white' : ''}`}
                onClick={() => patch({ summaryEveryN: n })}
              >
                {n}
              </button>
            ))}
            <input
              type="number"
              min={4}
              className="input w-24"
              value={mc.summaryEveryN}
              onChange={(e) => patch({ summaryEveryN: Number(e.target.value) })}
            />
          </div>
        </Field>
        <Field label="Кастомный промпт саммарайзера (опц.)" hint="Пусто — используется дефолтный.">
          <textarea
            className="input h-24"
            value={mc.summaryPrompt || ''}
            onChange={(e) => patch({ summaryPrompt: e.target.value || undefined })}
          />
        </Field>
      </div>

      <div className="card">
        <h4 className="font-semibold mb-3">Подключение для саммари</h4>
        <label className="flex items-center gap-2 text-sm mb-3">
          <input
            type="checkbox"
            checked={useCustomSummaryConn}
            onChange={(e) =>
              update((p) => {
                p.aiConfig.summaryConnection = e.target.checked
                  ? { provider: p.aiConfig.provider, baseUrl: p.aiConfig.baseUrl, model: p.aiConfig.model }
                  : undefined;
              })
            }
          />
          Отдельное подключение (иначе — основное игровое)
        </label>
        {useCustomSummaryConn && project.aiConfig.summaryConnection && (
          <ApiConnectionField
            conn={project.aiConfig.summaryConnection}
            keyRole="summary"
            onChange={(conn) => update((p) => (p.aiConfig.summaryConnection = conn))}
          />
        )}
      </div>

      <div className="card">
        <h4 className="font-semibold mb-3">Векторизация памяти</h4>
        <p className="text-xs text-gray-500 mb-3">
          Подсос релевантных кусков свёрнутой истории по смыслу хода игрока.
        </p>
        <div className="flex gap-2 mb-3">
          {(['off', 'builtin', 'custom'] as VectorizationMode[]).map((m) => (
            <button
              key={m}
              className={`chip !px-3 !py-1.5 ${mc.vectorization === m ? 'bg-accent2 text-white' : ''}`}
              onClick={() => patch({ vectorization: m })}
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
            conn={mc.embeddingsConnection || { provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: 'text-embedding-3-small' }}
            keyRole="embeddings"
            onChange={(conn) => patch({ embeddingsConnection: conn })}
          />
        )}
      </div>
    </div>
  );
}
