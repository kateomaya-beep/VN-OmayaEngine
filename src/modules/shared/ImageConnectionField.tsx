import { useEffect, useMemo, useRef, useState } from 'react';
import { Field } from '../../shared/ui';
import { getApiKey, setApiKey } from '../../ai/keys';
import {
  listImageModelsDetailed,
  testImageConnection,
  effectiveImageBase,
  effectiveImageModel,
} from '../../ai/imageProvider';
import { imageGenFor, useImageConnection, type ImageConnection } from '../../ai/imageConnection';
import type { ImageGenConfig, Project } from '../../shared/types';
import { defaultImageGenConfig } from '../../shared/types';

// Редактор подключения к image-API — как основное подключение: провайдер / Base URL /
// модель со списком по ⟳ / ключ / тест. Подключение ОБЩЕЕ на все истории (см.
// imageConnection.ts); ключ живёт в localStorage под ролью 'image'.
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

export function ImageConnectionField({ project }: { project?: Project | null }) {
  const stored = useImageConnection((s) => s.conn);
  const patch = useImageConnection((s) => s.patch);
  // Старый проект с подключением внутри — переносим его в общее при первом показе.
  useEffect(() => {
    if (!stored && project) imageGenFor(project);
  }, [stored, project]);
  const conn: ImageConnection = stored ?? { providerKind: 'gemini' };
  // Для подсказок адреса и модели по умолчанию — полная конфигурация.
  const cfg: ImageGenConfig = { ...defaultImageGenConfig(), ...conn };
  const [key, setKey] = useState('');
  const [status, setStatus] = useState<{ busy: boolean; msg?: string; ok?: boolean }>({ busy: false });

  useEffect(() => {
    setKey(getApiKey('image'));
  }, []);

  async function refreshModels() {
    setStatus({ busy: true });
    try {
      const { ids, info } = await listImageModelsDetailed(cfg, getApiKey('image'));
      const model = conn.model || ids.find((m) => info[m]?.image) || ids[0] || '';
      patch({ availableModels: ids, modelInfo: info, model: model || undefined });
      const images = ids.filter((m) => info[m]?.image).length;
      setStatus({
        busy: false,
        ok: true,
        msg: `${ids.length} моделей подтянуто${images ? `, из них рисуют картинки: ${images}` : ''} — выберите в списке у поля «Модель»${
          model && !ids.includes(model) ? ` · текущая «${model}» не в списке (оставлена)` : ''
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
      <p className="text-[11px] text-emerald-300/90 mb-2">
        Подключение общее для всех историй — настроить один раз. Стиль, референсы и галерея у каждой истории свои.
      </p>
      <Field label="Провайдер">
        <select
          className="input"
          value={conn.providerKind}
          onChange={(e) => {
            // Как в основном подключении: смена провайдера сбрасывает его данные,
            // иначе остаются модели и адрес от прошлого (и мы снова ловим 404).
            const providerKind = e.target.value as ImageGenConfig['providerKind'];
            const wasDefault =
              !conn.baseUrl || Object.values(DEFAULT_BASE).includes(conn.baseUrl.replace(/\/+$/, ''));
            patch({
              providerKind,
              baseUrl: wasDefault ? DEFAULT_BASE[providerKind] : conn.baseUrl,
              model: undefined,
              availableModels: undefined,
              modelInfo: undefined,
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
        {conn.providerKind === 'gemini'
          ? 'Родной протокол Google — только для ключа Google AI Studio и адреса generativelanguage.googleapis.com.'
          : conn.providerKind === 'openai_chat'
            ? 'Для агрегаторов (OpenRouter и клоны): своей ручки картинок у них нет, рисует модель вида google/gemini-…-image прямо в чате.'
            : 'Классический путь картинок OpenAI. Если шлюз его не знает — берите вариант с chat/completions.'}
      </p>

      <Field label="Base URL" hint={`Запрос уйдёт на: ${effectiveImageBase(cfg)}${PATH_HINT[conn.providerKind]}`}>
        <input
          className="input"
          placeholder={DEFAULT_BASE[conn.providerKind]}
          value={conn.baseUrl || ''}
          onChange={(e) => patch({ baseUrl: e.target.value || undefined })}
        />
      </Field>

      <Field
        label="Модель"
        hint={
          conn.availableModels?.length
            ? `Нажмите на поле или ▾ — откроется список (${conn.availableModels.length}) с поиском. Можно и вписать вручную.`
            : 'Нажмите ⟳, чтобы подтянуть список моделей, — дальше выбор из списка. Или впишите вручную.'
        }
      >
        <ModelCombobox
          value={conn.model || ''}
          placeholder={effectiveImageModel(cfg)}
          options={conn.availableModels || []}
          info={conn.modelInfo || {}}
          onChange={(model) => patch({ model: model || undefined })}
          onRefresh={refreshModels}
          busy={status.busy}
        />
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
        <p className={`nf-img-status text-xs mt-1 whitespace-pre-wrap ${status.ok ? 'text-green-400' : 'text-red-400'}`}>{status.msg}</p>
      )}
    </div>
  );
}

// ПОЛЕ МОДЕЛИ СО СПИСКОМ. Поле ввода, под которым по нажатию раскрывается список
// подтянутых моделей: поиск по тому, что набрано, названия рядом с id, рисующие
// картинки — сверху и с пометкой. Список встаёт в поток, а не всплывает поверх:
// в окнах с прокруткой всплывающий слой обрезается, а на телефоне уезжает за край.
function ModelCombobox({
  value,
  placeholder,
  options,
  info,
  onChange,
  onRefresh,
  busy,
}: {
  value: string;
  placeholder: string;
  options: string[];
  info: Record<string, { name?: string; image?: boolean }>;
  onChange: (v: string) => void;
  onRefresh: () => void;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [onlyImage, setOnlyImage] = useState(true);
  const boxRef = useRef<HTMLDivElement>(null);
  const hasImage = options.some((m) => info[m]?.image);
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return options.filter(
      (m) =>
        (!onlyImage || !hasImage || info[m]?.image) &&
        (!q || m.toLowerCase().includes(q) || (info[m]?.name || '').toLowerCase().includes(q))
    );
  }, [options, info, query, onlyImage, hasImage]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
    };
  }, [open]);

  const label = (m: string) => info[m]?.name;

  return (
    <div ref={boxRef}>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <input
            className="input w-full pr-8"
            placeholder={placeholder}
            value={value}
            onFocus={() => options.length && setOpen(true)}
            onChange={(e) => {
              onChange(e.target.value);
              setQuery(e.target.value);
              if (options.length) setOpen(true);
            }}
          />
          {options.length > 0 && (
            <button
              type="button"
              className="absolute right-1 top-1/2 -translate-y-1/2 px-2 text-gray-400 hover:text-white"
              title="Открыть список моделей"
              aria-label="Открыть список моделей"
              onClick={() => {
                setQuery('');
                setOpen((v) => !v);
              }}
            >
              ▾
            </button>
          )}
        </div>
        <button className="btn-ghost !px-2 text-xs" disabled={busy} onClick={onRefresh} title="Подтянуть список моделей">
          {busy ? '…' : '⟳'}
        </button>
      </div>
      {label(value) && <div className="text-[11px] text-gray-400 mt-1">{label(value)}</div>}
      {open && options.length > 0 && (
        <div className="nf-model-list mt-1.5 rounded-xl border border-white/15 bg-panel shadow-lg overflow-hidden">
          <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-white/10 text-[11px] text-gray-400">
            <span className="flex-1">
              {list.length} из {options.length}
              {query.trim() ? ` · поиск «${query.trim()}»` : ''}
            </span>
            {hasImage && (
              <label className="flex items-center gap-1 cursor-pointer">
                <input type="checkbox" checked={onlyImage} onChange={(e) => setOnlyImage(e.target.checked)} />
                только рисующие
              </label>
            )}
          </div>
          <div className="max-h-64 overflow-y-auto">
            {list.length === 0 && <div className="px-3 py-2 text-xs text-gray-500">Ничего не нашлось — впишите id вручную.</div>}
            {list.map((m) => (
              <button
                key={m}
                type="button"
                className={`block w-full text-left px-3 py-1.5 hover:bg-white/10 ${m === value ? 'bg-accent2/30' : ''}`}
                onClick={() => {
                  onChange(m);
                  setQuery('');
                  setOpen(false);
                }}
              >
                <div className="text-sm text-[#eae6f7] truncate">
                  {info[m]?.image && <span className="mr-1">🖼</span>}
                  {label(m) || m}
                </div>
                {label(m) && <div className="text-[11px] text-gray-500 truncate">{m}</div>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
