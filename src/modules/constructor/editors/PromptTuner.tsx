import { useRef, useState, useEffect } from 'react';
import { useProjectStore } from '../projectStore';
import { Field } from '../../../shared/ui';
import {
  CORE_PROMPT,
  STYLE_PRESETS,
  PROSE_STYLE_LABELS,
} from '../../../ai/directorPrompt';
import { getApiKey, setApiKey } from '../../../ai/keys';
import { ApiConnectionField } from './ApiConnectionField';
import { OMAYA_DEFAULT_PRESET, exportPreset, applyPreset, parsePresetJson } from '../../../ai/presets';
import { downloadBlob } from '../../../storage/zip';
import type {
  AiConfig,
  AdvancedPromptBlock,
  PromptLength,
  PromptPacing,
  PromptTone,
  ProseStyleId,
} from '../../../shared/types';

export function PromptTuner() {
  const { project, update } = useProjectStore();
  const [advanced, setAdvanced] = useState(false);
  const [showCore, setShowCore] = useState(false);
  const [imageKey, setImageKey] = useState('');
  const presetFileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setImageKey(getApiKey('image'));
  }, []);

  if (!project) return null;
  const cfg = project.aiConfig;

  function patch(patch: Partial<AiConfig>) {
    update((p) => Object.assign(p.aiConfig, patch));
  }
  function patchBlocks(blocks: AdvancedPromptBlock[]) {
    update((p) => (p.aiConfig.advancedBlocks = blocks));
  }

  const mature = project.meta.contentRating === 'mature';

  function exportCurrentPreset() {
    const preset = exportPreset(cfg, `${project!.meta.title} — пресет`);
    downloadBlob(
      new Blob([JSON.stringify(preset, null, 2)], { type: 'application/json' }),
      `${preset.name}.json`
    );
  }

  async function importPresetFile(file: File) {
    try {
      const preset = parsePresetJson(JSON.parse(await file.text()));
      if (!preset) throw new Error('Невалидный файл пресета');
      update((p) => (p.aiConfig = applyPreset(p.aiConfig, preset)));
    } catch (e) {
      alert('Не удалось импортировать пресет: ' + (e as Error).message);
    }
  }

  return (
    <div className="max-w-5xl space-y-4">
      <div className="flex items-center gap-2">
        <span className="text-sm text-gray-400">Режим:</span>
        <div className="inline-flex rounded-lg overflow-hidden border border-white/10">
          <button
            className={`px-3 py-1.5 text-sm ${!advanced ? 'bg-accent text-white' : 'bg-panel2'}`}
            onClick={() => setAdvanced(false)}
          >
            Простой
          </button>
          <button
            className={`px-3 py-1.5 text-sm ${advanced ? 'bg-accent text-white' : 'bg-panel2'}`}
            onClick={() => setAdvanced(true)}
          >
            Продвинутый
          </button>
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        {/* Провайдер (всегда) */}
        <div className="card">
          <h4 className="font-semibold mb-3">Провайдер LLM</h4>
          <ApiConnectionField
            conn={{ provider: cfg.provider, baseUrl: cfg.baseUrl, model: cfg.model }}
            keyRole={cfg.provider}
            onChange={(conn) =>
              patch({ provider: conn.provider, baseUrl: conn.baseUrl, model: conn.model || cfg.model })
            }
          />
        </div>

        {/* Стиль/тон (Слой 2) */}
        <div className="card">
          <h4 className="font-semibold mb-3">Стиль и тон</h4>
          <Field label="Язык повествования" hint="Независим от языка интерфейса.">
            <select
              className="input"
              value={cfg.narrativeLanguage}
              onChange={(e) => patch({ narrativeLanguage: e.target.value as 'ru' | 'en' })}
            >
              <option value="ru">Русский</option>
              <option value="en">English</option>
            </select>
          </Field>
          <Field label="Стиль-пресет">
            <select
              className="input"
              value={cfg.stylePreset}
              onChange={(e) => patch({ stylePreset: e.target.value })}
            >
              {STYLE_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
              <option value="custom">Свой стиль (текст ниже)</option>
            </select>
          </Field>
          <label className="flex items-center gap-2 text-sm mb-2">
            <input
              type="checkbox"
              checked={mature}
              onChange={(e) =>
                update((p) => {
                  p.meta.contentRating = e.target.checked ? 'mature' : 'sfw';
                  p.aiConfig.jailbreakEnabled = e.target.checked;
                })
              }
            />
            Зрелый контент (18+) — включает разрешения
          </label>
          {(advanced || cfg.stylePreset === 'custom') && (
            <Field
              label="Свои штрихи к стилю"
              hint="Добавляется к пресету (или заменяет его при «Свой стиль»)."
            >
              <textarea
                className="input h-24"
                value={cfg.customStyle || ''}
                onChange={(e) => patch({ customStyle: e.target.value || undefined })}
              />
            </Field>
          )}
          {advanced && (
            <div className="grid grid-cols-2 gap-3 mt-2">
              <Field label="Длина хода">
                <select
                  className="input"
                  value={cfg.length}
                  onChange={(e) => patch({ length: e.target.value as PromptLength })}
                >
                  <option value="short">Короткая (150–250)</option>
                  <option value="medium">Средняя (250–450)</option>
                  <option value="long">Длинная (450–800)</option>
                </select>
              </Field>
              <Field label="Темп">
                <select
                  className="input"
                  value={cfg.pacing}
                  onChange={(e) => patch({ pacing: e.target.value as PromptPacing })}
                >
                  <option value="slow_burn">Slow burn</option>
                  <option value="fast">Быстрый</option>
                  <option value="adaptive">Адаптивный</option>
                </select>
              </Field>
              <Field label="Тональность">
                <select
                  className="input"
                  value={cfg.tone}
                  onChange={(e) => patch({ tone: e.target.value as PromptTone })}
                >
                  <option value="neutral">Нейтральная</option>
                  <option value="anti_negative">Без лишнего пессимизма</option>
                  <option value="anti_saccharine">Без приторности</option>
                </select>
              </Field>
              <Field label="Стиль прозы">
                <select
                  className="input"
                  value={cfg.proseStyle}
                  onChange={(e) => patch({ proseStyle: e.target.value as ProseStyleId })}
                >
                  {(Object.keys(PROSE_STYLE_LABELS) as ProseStyleId[]).map((id) => (
                    <option key={id} value={id}>
                      {PROSE_STYLE_LABELS[id]}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          )}
        </div>
      </div>

      {advanced && (
        <>
          <div className="card">
            <div className="flex items-center justify-between mb-2">
              <h4 className="font-semibold">Пресеты промпта</h4>
              <div className="flex gap-2">
                <button
                  className="btn-ghost !px-3 !py-1 text-xs"
                  onClick={() => update((p) => (p.aiConfig = applyPreset(p.aiConfig, OMAYA_DEFAULT_PRESET)))}
                >
                  Omaya (дефолт)
                </button>
                <button className="btn-ghost !px-3 !py-1 text-xs" onClick={exportCurrentPreset}>
                  Экспорт
                </button>
                <button
                  className="btn-ghost !px-3 !py-1 text-xs"
                  onClick={() => presetFileRef.current?.click()}
                >
                  Импорт
                </button>
                <input
                  ref={presetFileRef}
                  type="file"
                  accept=".json"
                  hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) importPresetFile(f);
                    e.target.value = '';
                  }}
                />
              </div>
            </div>
            <p className="text-xs text-gray-500">
              Пресет — снимок тумблеров Слоя 2/3 (язык, стиль, длина, темп, тон, проза,
              джейлбрейк, префилл) в JSON-файл — для обмена в комьюнити. Ядро (Слой 1) в пресет
              не входит и не редактируется.
            </p>
          </div>
          <div className="grid md:grid-cols-2 gap-4">
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
              <h4 className="font-semibold mb-3">Джейлбрейк и префилл</h4>
              <label className="flex items-center gap-2 text-sm mb-2">
                <input
                  type="checkbox"
                  checked={cfg.jailbreakEnabled}
                  onChange={(e) => patch({ jailbreakEnabled: e.target.checked })}
                />
                Слой разрешений (jailbreak) включён
              </label>
              {cfg.jailbreakEnabled && (
                <Field label="Текст разрешений" hint="Пусто — используется дефолтный.">
                  <textarea
                    className="input h-24"
                    value={cfg.jailbreakPrompt || ''}
                    onChange={(e) => patch({ jailbreakPrompt: e.target.value || undefined })}
                  />
                </Field>
              )}
              <Field
                label="Префилл ответа (опц.)"
                hint='Начало JSON для стабилизации, напр. {"scene":'
              >
                <input
                  className="input"
                  value={cfg.prefill || ''}
                  placeholder='{"scene":'
                  onChange={(e) => patch({ prefill: e.target.value || undefined })}
                />
              </Field>
            </div>
          </div>

          <div className="card">
            <h4 className="font-semibold mb-3">Генерация изображений (image-API)</h4>
            <p className="text-xs text-gray-500 mb-3">
              OpenAI-совместимый эндпоинт /images/generations. Ключ хранится только в этом
              браузере. Используется кнопками «Создать фон/CG» в плеере.
            </p>
            <div className="grid sm:grid-cols-2 gap-3">
              <Field label="Image Base URL" hint="Пусто — берётся Base URL основного провайдера.">
                <input
                  className="input"
                  value={cfg.imageBaseUrl || ''}
                  placeholder="https://api.openai.com/v1"
                  onChange={(e) => patch({ imageBaseUrl: e.target.value || undefined })}
                />
              </Field>
              <Field label="Image модель">
                <input
                  className="input"
                  value={cfg.imageModel || ''}
                  placeholder="gpt-image-1"
                  onChange={(e) => patch({ imageModel: e.target.value || undefined })}
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

          <div className="card">
            <div className="flex items-center justify-between mb-2">
              <h4 className="font-semibold">Кастомные вставки (author's note)</h4>
              <button
                className="btn-ghost !px-3 !py-1 text-xs"
                onClick={() => patchBlocks([...(cfg.advancedBlocks || []), { content: '', depth: 1 }])}
              >
                + Блок
              </button>
            </div>
            <p className="text-xs text-gray-500 mb-2">
              Глубина = сколько сообщений от конца истории. 0 — в самый конец, 1 — перед последним ходом.
            </p>
            {(cfg.advancedBlocks || []).map((b, i) => (
              <div key={i} className="flex gap-2 mb-2">
                <textarea
                  className="input h-16 flex-1"
                  value={b.content}
                  placeholder="Текст вставки (поддерживает макросы)"
                  onChange={(e) => {
                    const next = [...(cfg.advancedBlocks || [])];
                    next[i] = { ...next[i], content: e.target.value };
                    patchBlocks(next);
                  }}
                />
                <div className="w-20">
                  <label className="label">Глубина</label>
                  <input
                    type="number"
                    min={0}
                    className="input"
                    value={b.depth}
                    onChange={(e) => {
                      const next = [...(cfg.advancedBlocks || [])];
                      next[i] = { ...next[i], depth: Number(e.target.value) };
                      patchBlocks(next);
                    }}
                  />
                  <button
                    className="btn-danger !px-2 !py-1 text-xs mt-1 w-full"
                    onClick={() => patchBlocks((cfg.advancedBlocks || []).filter((_, j) => j !== i))}
                  >
                    Удалить
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="card">
            <div className="flex items-center justify-between mb-2">
              <h4 className="font-semibold">Ядро-режиссёр (Слой 1)</h4>
              <button className="btn-ghost !px-3 !py-1 text-xs" onClick={() => setShowCore((v) => !v)}>
                {showCore ? 'Скрыть' : 'Показать (только чтение)'}
              </button>
            </div>
            <p className="text-xs text-gray-500">
              Вшитая «подкорка»: JSON-контракт, роли, словари эмоций и настроений, fallback. Не редактируется.
            </p>
            {showCore && (
              <pre className="text-xs bg-ink rounded-lg p-3 mt-3 whitespace-pre-wrap max-h-72 overflow-y-auto scrollbar-thin text-gray-400">
                {CORE_PROMPT}
              </pre>
            )}
          </div>
        </>
      )}
    </div>
  );
}
