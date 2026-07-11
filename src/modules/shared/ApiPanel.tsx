import { useState } from 'react';
import { Modal } from '../../shared/ui';
import { ApiConnectionField } from '../constructor/editors/ApiConnectionField';
import type { Project, ApiConnection } from '../../shared/types';

type Tab = 'main' | 'summary' | 'embeddings' | 'image';

// Единая панель API-подключений (см. CR v2 §G): игра / саммари / эмбеддинги /
// картинки, с автоподгрузкой моделей и тестом соединения. Доступна и из
// конструктора (шапка проекта), и прямо в игре.
export function ApiPanel({
  open,
  onClose,
  project,
  onPatch,
}: {
  open: boolean;
  onClose: () => void;
  project: Project;
  onPatch: (mutator: (p: Project) => void) => void;
}) {
  const [tab, setTab] = useState<Tab>('main');
  if (!open) return null;

  const TABS: { id: Tab; label: string }[] = [
    { id: 'main', label: 'Игра' },
    { id: 'summary', label: 'Саммари' },
    { id: 'embeddings', label: 'Эмбеддинги' },
    { id: 'image', label: 'Картинки' },
  ];

  return (
    <Modal open={open} onClose={onClose} title="API-подключения" wide>
      <div className="flex gap-1 mb-4 flex-wrap">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`px-3 py-1.5 rounded-lg text-sm ${
              tab === t.id ? 'bg-accent text-white' : 'bg-panel2 hover:bg-white/10'
            }`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'main' && (
        <ApiConnectionField
          conn={{ provider: project.aiConfig.provider, baseUrl: project.aiConfig.baseUrl, model: project.aiConfig.model }}
          keyRole={project.aiConfig.provider}
          onChange={(conn) =>
            onPatch((p) => {
              p.aiConfig.provider = conn.provider;
              p.aiConfig.baseUrl = conn.baseUrl;
              if (conn.model) p.aiConfig.model = conn.model;
            })
          }
        />
      )}

      {tab === 'summary' && (
        <div>
          <label className="flex items-center gap-2 text-sm mb-3">
            <input
              type="checkbox"
              checked={!!project.aiConfig.summaryConnection}
              onChange={(e) =>
                onPatch((p) => {
                  p.aiConfig.summaryConnection = e.target.checked
                    ? { provider: p.aiConfig.provider, baseUrl: p.aiConfig.baseUrl, model: p.aiConfig.model }
                    : undefined;
                })
              }
            />
            Отдельное подключение (иначе — основное игровое)
          </label>
          {project.aiConfig.summaryConnection && (
            <ApiConnectionField
              conn={project.aiConfig.summaryConnection}
              keyRole="summary"
              onChange={(conn) => onPatch((p) => (p.aiConfig.summaryConnection = conn))}
            />
          )}
        </div>
      )}

      {tab === 'embeddings' && (
        <div>
          <p className="text-xs text-gray-500 mb-3">
            Используется, если в настройках памяти включена векторизация «Свой API».
          </p>
          <ApiConnectionField
            conn={
              project.memoryConfig.embeddingsConnection || {
                provider: 'openai-compatible',
                baseUrl: 'https://api.openai.com/v1',
                model: 'text-embedding-3-small',
              }
            }
            keyRole="embeddings"
            onChange={(conn: ApiConnection) => onPatch((p) => (p.memoryConfig.embeddingsConnection = conn))}
          />
        </div>
      )}

      {tab === 'image' && (
        <ApiConnectionField
          conn={{
            provider: 'openai-compatible',
            baseUrl: project.aiConfig.imageBaseUrl || project.aiConfig.baseUrl,
            model: project.aiConfig.imageModel,
          }}
          keyRole="image"
          showProvider={false}
          onChange={(conn) =>
            onPatch((p) => {
              p.aiConfig.imageBaseUrl = conn.baseUrl;
              p.aiConfig.imageModel = conn.model;
            })
          }
        />
      )}
    </Modal>
  );
}
