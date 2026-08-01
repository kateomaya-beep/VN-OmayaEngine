import { useEffect, useState } from 'react';
import { Field } from '../../shared/ui';
import { getApiKey, setApiKey } from '../../ai/keys';
import {
  listImageModels,
  testImageConnection,
  effectiveImageBase,
  effectiveImageModel,
} from '../../ai/imageProvider';
import type { ImageGenConfig } from '../../shared/types';

// Редактор подключения к image-API — по функционалу как основное подключение
// (ApiConnectionField): провайдер / Base URL / модель со списком по ⟳ / ключ / тест.
// Ключ живёт в localStorage под ролью 'image' и никуда, кроме image-провайдера, не уходит.
const DEFAULT_BASE: Record<ImageGenConfig['providerKind'], string> = {
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  openai: 'https://api.openai.com/v1',
  openai_chat: 'https://openrouter.ai/api/v1',
};

const PATH_HINT: Record<ImageGenConfig['providerKind'], string> = {
  gemini: '/models/<модель>:generateContent',
  openai: '/images/generations',
  openai_chat: '/chat/completions',
};

export function ImageConnectionField({
  cfg,
  onChange,
}: {
  cfg: ImageGenConfig;
  onChange: (patch: Partial<ImageGenConfig>) => void;
}) {
  const [key, setKey] = useState('');
  const [status, setStatus] = useState<{ busy: boolean; msg?: string; ok?: boolean }>({ busy: false });

  useEffect(() => {
    setKey(getApiKey('image'));
  }, []);

  async function refreshModels() {
    setStatus({ busy: true });
    try {
      const models = await listImageModels(cfg, key);
      const model = cfg.model || models.find((m) => /image|imagen|dall/i.test(m)) || models[0] || '';
      onChange({ availableModels: models, model: model || undefined });
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
    const res = await testImageConnection(cfg, key);
    setStatus({ busy: false, ok: res.ok, msg: res.message });
  }

  return (
    <div>
      <Field label="Провайдер">
        <select
          className="input"
          value={cfg.providerKind}
          onChange={(e) => {
            // Как в основном подключении: смена провайдера сбрасывает его данные,
            // иначе остаются модели и адрес от прошлого (и мы снова ловим 404).
            const providerKind = e.target.value as ImageGenConfig['providerKind'];
            const wasDefault =
              !cfg.baseUrl || Object.values(DEFAULT_BASE).includes(cfg.baseUrl.replace(/\/+$/, ''));
            onChange({
              providerKind,
              baseUrl: wasDefault ? DEFAULT_BASE[providerKind] : cfg.baseUrl,
              model: undefined,
              availableModels: undefined,
            });
            setStatus({ busy: false });
          }}
        >
          <option value="gemini">Google напрямую · Gemini / Nano Banana (с рефами)</option>
          <option value="openai_chat">Шлюз-роутер · chat/completions с картинкой в ответе (с рефами)</option>
          <option value="openai">Шлюз · images/generations (без рефов)</option>
        </select>
      </Field>

      <p className="text-[11px] text-gray-500 -mt-2 mb-2">
        {cfg.providerKind === 'gemini'
          ? 'Родной протокол Google — только для ключа Google AI Studio и адреса generativelanguage.googleapis.com.'
          : cfg.providerKind === 'openai_chat'
            ? 'Для агрегаторов (OpenRouter и клоны): своей ручки картинок у них нет, рисует модель вида google/gemini-…-image прямо в чате.'
            : 'Классический путь картинок OpenAI. Если шлюз его не знает — берите вариант с chat/completions.'}
      </p>

      <Field label="Base URL" hint={`Запрос уйдёт на: ${effectiveImageBase(cfg)}${PATH_HINT[cfg.providerKind]}`}>
        <input
          className="input"
          placeholder={DEFAULT_BASE[cfg.providerKind]}
          value={cfg.baseUrl || ''}
          onChange={(e) => onChange({ baseUrl: e.target.value || undefined })}
        />
      </Field>

      <Field
        label="Модель"
        hint={
          cfg.availableModels?.length
            ? `Выберите из списка (${cfg.availableModels.length}) ИЛИ впишите вручную — провайдер может отдавать не всё.`
            : 'Нажмите ⟳ чтобы подтянуть список, либо впишите модель вручную.'
        }
      >
        {cfg.availableModels?.length ? (
          <select
            className="input mb-2"
            value={cfg.availableModels.includes(cfg.model || '') ? cfg.model : ''}
            onChange={(e) => e.target.value && onChange({ model: e.target.value })}
          >
            <option value="">— выбрать из списка ({cfg.availableModels.length}) —</option>
            {cfg.availableModels.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        ) : null}
        <div className="flex gap-2">
          <input
            className="input flex-1"
            placeholder={effectiveImageModel(cfg)}
            value={cfg.model || ''}
            onChange={(e) => onChange({ model: e.target.value || undefined })}
          />
          <button className="btn-ghost !px-2 text-xs" disabled={status.busy} onClick={refreshModels} title="Подтянуть список моделей">
            ⟳
          </button>
        </div>
      </Field>

      <Field label="API-ключ" hint="Хранится только в этом браузере (localStorage), уходит только к image-провайдеру.">
        <div className="flex gap-2">
          <input
            className="input flex-1"
            type="password"
            value={key}
            placeholder="sk-… / AIza…"
            onChange={(e) => {
              setKey(e.target.value);
              setApiKey('image', e.target.value);
            }}
          />
          <button className="btn-ghost !px-3 text-xs" disabled={status.busy} onClick={test}>
            {status.busy ? '…' : 'Тест'}
          </button>
        </div>
      </Field>

      {status.msg && (
        <p className={`text-xs mt-1 whitespace-pre-wrap ${status.ok ? 'text-green-400' : 'text-red-400'}`}>{status.msg}</p>
      )}
    </div>
  );
}
