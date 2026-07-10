import { useState, useEffect } from 'react';
import { useProjectStore } from '../projectStore';
import { Field } from '../../../shared/ui';
import { DIRECTOR_PROMPT } from '../../../ai/directorPrompt';
import { getApiKey, setApiKey } from '../../../ai/keys';
import type { AiConfig } from '../../../shared/types';

export function PromptTuner() {
  const { project, update } = useProjectStore();
  const [showBase, setShowBase] = useState(false);
  const [key, setKey] = useState('');

  const provider = project?.aiConfig.provider ?? 'openai-compatible';
  useEffect(() => {
    setKey(getApiKey(provider));
  }, [provider]);

  if (!project) return null;
  const cfg = project.aiConfig;

  function patch(patch: Partial<AiConfig>) {
    update((p) => Object.assign(p.aiConfig, patch));
  }

  return (
    <div className="grid md:grid-cols-2 gap-6 max-w-5xl">
      <div className="card">
        <h4 className="font-semibold mb-3">Провайдер LLM</h4>
        <Field label="Провайдер">
          <select
            className="input"
            value={cfg.provider}
            onChange={(e) => {
              const prov = e.target.value as AiConfig['provider'];
              patch({
                provider: prov,
                baseUrl:
                  prov === 'anthropic'
                    ? 'https://api.anthropic.com/v1'
                    : 'https://api.openai.com/v1',
              });
            }}
          >
            <option value="openai-compatible">OpenAI-совместимый (OpenAI, OpenRouter, локальный…)</option>
            <option value="anthropic">Anthropic</option>
          </select>
        </Field>
        <Field label="Base URL">
          <input className="input" value={cfg.baseUrl} onChange={(e) => patch({ baseUrl: e.target.value })} />
        </Field>
        <Field label="Модель">
          <input className="input" value={cfg.model} onChange={(e) => patch({ model: e.target.value })} />
        </Field>
        <Field
          label={`API-ключ (${cfg.provider})`}
          hint="Хранится только в этом браузере (localStorage). Уходит лишь напрямую к провайдеру."
        >
          <input
            className="input"
            type="password"
            value={key}
            placeholder="sk-..."
            onChange={(e) => {
              setKey(e.target.value);
              setApiKey(cfg.provider, e.target.value);
            }}
          />
        </Field>
        <Field label="Модель саммарайзера (опц.)" hint="Дешёвая модель для сжатия памяти.">
          <input
            className="input"
            value={cfg.summarizerModel || ''}
            placeholder="как основная"
            onChange={(e) => patch({ summarizerModel: e.target.value || undefined })}
          />
        </Field>
      </div>

      <div className="card">
        <h4 className="font-semibold mb-3">Параметры генерации</h4>
        <Field label={`Температура: ${cfg.temperature.toFixed(2)}`}>
          <input
            type="range"
            min={0}
            max={1.5}
            step={0.05}
            className="w-full"
            value={cfg.temperature}
            onChange={(e) => patch({ temperature: Number(e.target.value) })}
          />
        </Field>
        <Field label={`Живое окно (K ходов): ${cfg.liveWindow}`}>
          <input
            type="range"
            min={4}
            max={30}
            step={1}
            className="w-full"
            value={cfg.liveWindow}
            onChange={(e) => patch({ liveWindow: Number(e.target.value) })}
          />
        </Field>
        <Field label={`Бюджет контекста (токены): ${cfg.contextBudget}`}>
          <input
            type="range"
            min={2000}
            max={32000}
            step={500}
            className="w-full"
            value={cfg.contextBudget}
            onChange={(e) => patch({ contextBudget: Number(e.target.value) })}
          />
        </Field>
        <Field label={`Сканировать ключи в N сообщениях: ${cfg.maxContextMessages}`}>
          <input
            type="range"
            min={2}
            max={30}
            step={1}
            className="w-full"
            value={cfg.maxContextMessages}
            onChange={(e) => patch({ maxContextMessages: Number(e.target.value) })}
          />
        </Field>
      </div>

      <div className="card md:col-span-2">
        <div className="flex items-center justify-between mb-2">
          <h4 className="font-semibold">Director Prompt</h4>
          <button className="btn-ghost !px-3 !py-1 text-xs" onClick={() => setShowBase((v) => !v)}>
            {showBase ? 'Скрыть базовый' : 'Показать базовый (только чтение)'}
          </button>
        </div>
        {showBase && (
          <pre className="text-xs bg-ink rounded-lg p-3 mb-3 whitespace-pre-wrap max-h-60 overflow-y-auto scrollbar-thin text-gray-400">
            {DIRECTOR_PROMPT}
          </pre>
        )}
        <Field
          label="Дополнительные авторские инструкции"
          hint="Расширяют базовый промпт (удалить базовый нельзя)."
        >
          <textarea
            className="input h-28"
            value={cfg.customDirectorPrompt || ''}
            onChange={(e) => patch({ customDirectorPrompt: e.target.value || undefined })}
          />
        </Field>
      </div>
    </div>
  );
}
