import { useEffect, useState } from 'react';
import { Field } from '../../../shared/ui';
import { getApiKey, setApiKey } from '../../../ai/keys';
import { listModels, testConnection } from '../../../ai/providers';
import type { ApiConnection } from '../../../shared/types';

// Переиспользуемый редактор ApiConnection: provider/baseUrl/model/ключ + автоподгрузка
// моделей + тест соединения (см. CR v2 §G). keyRole — под какой ролью хранится ключ
// в localStorage ('summary' | 'embeddings' | 'image' | 'openai-compatible' | 'anthropic').
export function ApiConnectionField({
  conn,
  keyRole,
  onChange,
  showProvider = true,
}: {
  conn: ApiConnection;
  keyRole: string;
  onChange: (next: ApiConnection) => void;
  showProvider?: boolean;
}) {
  const [key, setKey] = useState('');
  const [status, setStatus] = useState<{ busy: boolean; msg?: string; ok?: boolean }>({ busy: false });

  useEffect(() => {
    setKey(getApiKey(keyRole));
  }, [keyRole]);

  async function refreshModels() {
    setStatus({ busy: true });
    try {
      const models = await listModels(conn, key);
      // Если текущая модель отсутствует у провайдера (частый кейс: остался дефолтный
      // gpt-4o-mini, а провайдер другой) — авто-выбираем первую из списка, чтобы
      // генерация не падала с «model not found».
      const model = conn.model && models.includes(conn.model) ? conn.model : models[0] || conn.model;
      onChange({ ...conn, availableModels: models, model });
      setStatus({
        busy: false,
        ok: true,
        msg:
          `${models.length} моделей` +
          (model && model !== conn.model ? ` · выбрана «${model}»` : ''),
      });
    } catch (e) {
      setStatus({ busy: false, ok: false, msg: (e as Error).message });
    }
  }

  async function test() {
    setStatus({ busy: true });
    const res = await testConnection(conn, key);
    setStatus({ busy: false, ok: res.ok, msg: res.message });
  }

  return (
    <div>
      {showProvider && (
        <Field label="Провайдер">
          <select
            className="input"
            value={conn.provider}
            onChange={(e) => onChange({ ...conn, provider: e.target.value as ApiConnection['provider'] })}
          >
            <option value="openai-compatible">OpenAI-совместимый</option>
            <option value="anthropic">Anthropic</option>
          </select>
        </Field>
      )}
      <Field label="Base URL">
        <input
          className="input"
          value={conn.baseUrl}
          onChange={(e) => onChange({ ...conn, baseUrl: e.target.value })}
        />
      </Field>
      <Field label="Модель">
        <div className="flex gap-2">
          {conn.availableModels?.length ? (
            <select
              className="input flex-1"
              value={conn.model || ''}
              onChange={(e) => onChange({ ...conn, model: e.target.value })}
            >
              <option value="">— выбрать —</option>
              {conn.availableModels.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          ) : (
            <input
              className="input flex-1"
              value={conn.model || ''}
              onChange={(e) => onChange({ ...conn, model: e.target.value })}
            />
          )}
          <button className="btn-ghost !px-2 text-xs" disabled={status.busy} onClick={refreshModels}>
            ⟳
          </button>
        </div>
      </Field>
      <Field label="API-ключ" hint="Хранится только в этом браузере (localStorage).">
        <div className="flex gap-2">
          <input
            className="input flex-1"
            type="password"
            value={key}
            placeholder="sk-..."
            onChange={(e) => {
              setKey(e.target.value);
              setApiKey(keyRole, e.target.value);
            }}
          />
          <button className="btn-ghost !px-3 text-xs" disabled={status.busy} onClick={test}>
            {status.busy ? '…' : 'Тест'}
          </button>
        </div>
      </Field>
      {status.msg && (
        <p className={`text-xs mt-1 ${status.ok ? 'text-green-400' : 'text-red-400'}`}>{status.msg}</p>
      )}
    </div>
  );
}
