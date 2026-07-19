import { useEffect, useState } from 'react';
import { Field } from '../../../shared/ui';
import { getApiKey, setApiKey } from '../../../ai/keys';
import { listModels, testConnection } from '../../../ai/providers';
import type { ApiConnection } from '../../../shared/types';

// Дефолтный base URL под провайдера (совпадает с providers/index.ts).
const DEFAULT_BASE: Record<ApiConnection['provider'], string> = {
  'openai-compatible': 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
};

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
      // НЕ затираем уже выбранную/вписанную модель (провайдер может отдавать не весь
      // список). Автоподставляем первую только если модель ещё не задана.
      const model = conn.model || models[0] || '';
      onChange({ ...conn, availableModels: models, model });
      setStatus({
        busy: false,
        ok: true,
        msg: `${models.length} моделей подтянуто${
          model && !models.includes(model) ? ` · текущая «${model}» не в списке (оставлена)` : ''
        }`,
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
            onChange={(e) => {
              // Смена провайдера сбрасывает провайдер-специфичные данные, иначе
              // остаются модели/URL от старого провайдера (баг «показывает старое»).
              const provider = e.target.value as ApiConnection['provider'];
              const wasDefault =
                !conn.baseUrl || Object.values(DEFAULT_BASE).includes(conn.baseUrl.replace(/\/$/, ''));
              onChange({
                ...conn,
                provider,
                baseUrl: wasDefault ? DEFAULT_BASE[provider] : conn.baseUrl,
                model: '',
                availableModels: undefined,
              });
              setStatus({ busy: false });
            }}
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
      <Field
        label="Модель"
        hint={
          conn.availableModels?.length
            ? `Подтянуто ${conn.availableModels.length} — можно выбрать из списка ИЛИ вписать любую модель вручную (если провайдер отдаёт не все).`
            : 'Нажмите ⟳ чтобы подтянуть список, либо впишите модель вручную.'
        }
      >
        <div className="flex gap-2">
          {/* Свободный ввод + подсказки из подтянутого списка (datalist): даже если
              провайдер вернул не все модели, нужную можно вписать руками. */}
          <input
            className="input flex-1"
            list={`models-${keyRole}`}
            value={conn.model || ''}
            placeholder="напр. gpt-4o, claude-…, deepseek-chat"
            onChange={(e) => onChange({ ...conn, model: e.target.value })}
          />
          {conn.availableModels?.length ? (
            <datalist id={`models-${keyRole}`}>
              {conn.availableModels.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          ) : null}
          <button
            className="btn-ghost !px-2 text-xs"
            disabled={status.busy}
            onClick={refreshModels}
            title="Подтянуть список моделей"
          >
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
