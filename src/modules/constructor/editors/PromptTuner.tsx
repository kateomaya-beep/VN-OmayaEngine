import { useRef, useState, useEffect } from 'react';
import { useProjectStore } from '../projectStore';
import { Field } from '../../../shared/ui';
import { getApiKey, setApiKey } from '../../../ai/keys';
import {
  normalizePreset,
  defaultPreset,
  defaultBlockContent,
  parsePresetJson,
  type PromptPreset,
  type PromptBlock,
} from '../../../ai/promptPreset';
import { uid } from '../../../shared/utils';
import { downloadBlob } from '../../../storage/zip';
import type { AiConfig, AdvancedPromptBlock } from '../../../shared/types';

// Полностью редактируемый пресет промпта в стиле SillyTavern (Batch 3 §8): блоки
// можно включать/выключать, редактировать текст, переставлять drag&drop, добавлять
// свои и удалять. Динамические блоки наполняет движок — у них только вкл/выкл и порядок.
export function PromptTuner() {
  const { project, update } = useProjectStore();
  const [imageKey, setImageKey] = useState('');
  const [dragId, setDragId] = useState<string | null>(null);
  const presetFileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setImageKey(getApiKey('image'));
  }, []);

  if (!project) return null;
  const cfg = project.aiConfig;
  const preset = normalizePreset(cfg.promptPreset);

  function patch(patch: Partial<AiConfig>) {
    update((p) => Object.assign(p.aiConfig, patch));
  }
  function savePreset(next: PromptPreset) {
    update((p) => (p.aiConfig.promptPreset = next));
  }
  function patchBlock(id: string, patch: Partial<PromptBlock>) {
    savePreset({ ...preset, blocks: preset.blocks.map((b) => (b.id === id ? { ...b, ...patch } : b)) });
  }
  function removeBlock(id: string) {
    savePreset({ ...preset, blocks: preset.blocks.filter((b) => b.id !== id) });
  }
  function addBlock() {
    const block: PromptBlock = { id: uid('blk'), name: 'Новый блок', enabled: true, content: '' };
    savePreset({ ...preset, blocks: [...preset.blocks, block] });
  }
  function resetBlock(b: PromptBlock) {
    if (!b.builtinKey) return;
    const content = defaultBlockContent(b.builtinKey);
    if (content !== null) patchBlock(b.id, { content, enabled: true });
  }
  function resetPreset() {
    if (confirm('Вернуть весь пресет к OmayaEngine по умолчанию? Ваши правки блоков будут потеряны.')) {
      savePreset(defaultPreset());
    }
  }
  function reorder(fromId: string, toId: string) {
    if (fromId === toId) return;
    const blocks = [...preset.blocks];
    const from = blocks.findIndex((b) => b.id === fromId);
    const to = blocks.findIndex((b) => b.id === toId);
    if (from === -1 || to === -1) return;
    const [moved] = blocks.splice(from, 1);
    blocks.splice(to, 0, moved);
    savePreset({ ...preset, blocks });
  }

  function exportPreset() {
    downloadBlob(
      new Blob([JSON.stringify(preset, null, 2)], { type: 'application/json' }),
      `${preset.name || 'preset'}.json`
    );
  }
  async function importPresetFile(file: File) {
    try {
      const parsed = parsePresetJson(JSON.parse(await file.text()));
      if (!parsed) throw new Error('Невалидный файл пресета (нет массива blocks)');
      savePreset(parsed);
    } catch (e) {
      alert('Не удалось импортировать пресет: ' + (e as Error).message);
    }
  }

  function patchAdvBlocks(blocks: AdvancedPromptBlock[]) {
    update((p) => (p.aiConfig.advancedBlocks = blocks));
  }

  return (
    <div className="max-w-5xl space-y-4">
      {/* Пресет промпта — редактор блоков */}
      <div className="card">
        <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
          <div>
            <h4 className="font-semibold">Пресет промпта</h4>
            <input
              className="input mt-1 !py-1 text-sm"
              value={preset.name}
              onChange={(e) => savePreset({ ...preset, name: e.target.value })}
            />
          </div>
          <div className="flex gap-2 flex-wrap">
            <button className="btn-ghost !px-3 !py-1 text-xs" onClick={addBlock}>
              + Блок
            </button>
            <button className="btn-ghost !px-3 !py-1 text-xs" onClick={exportPreset}>
              Экспорт
            </button>
            <button className="btn-ghost !px-3 !py-1 text-xs" onClick={() => presetFileRef.current?.click()}>
              Импорт
            </button>
            <button className="btn-ghost !px-3 !py-1 text-xs" onClick={resetPreset}>
              Вернуть по умолчанию
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
        <p className="text-xs text-gray-500 mb-3">
          Порядок блоков = порядок в системном промпте. Перетаскивайте за ⠿, включайте/выключайте
          галочкой, редактируйте текст. <span className="text-amber-400">↳ блоки</span> наполняет
          движок (мир, персонажи, память) — у них только порядок и вкл/выкл.
        </p>

        <div className="space-y-2">
          {preset.blocks.map((b) => (
            <div
              key={b.id}
              draggable
              onDragStart={() => setDragId(b.id)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (dragId) reorder(dragId, b.id);
                setDragId(null);
              }}
              className={`rounded-lg border p-3 bg-panel2 ${
                b.flagged ? 'border-amber-500/40' : 'border-white/10'
              } ${dragId === b.id ? 'opacity-50' : ''}`}
            >
              <div className="flex items-center gap-2">
                <span className="cursor-grab select-none text-gray-500" title="Перетащить">
                  ⠿
                </span>
                <input
                  type="checkbox"
                  checked={b.enabled}
                  onChange={(e) => patchBlock(b.id, { enabled: e.target.checked })}
                  title="Включить/выключить блок"
                />
                <input
                  className="input !py-1 text-sm flex-1"
                  value={b.name}
                  onChange={(e) => patchBlock(b.id, { name: e.target.value })}
                />
                {b.builtinKey && !b.dynamic && (
                  <button
                    className="btn-ghost !px-2 !py-1 text-xs"
                    title="Вернуть текст блока к дефолту"
                    onClick={() => resetBlock(b)}
                  >
                    ↺
                  </button>
                )}
                {!b.builtinKey && !b.dynamic && (
                  <button
                    className="btn-danger !px-2 !py-1 text-xs"
                    title="Удалить блок"
                    onClick={() => removeBlock(b.id)}
                  >
                    ✕
                  </button>
                )}
              </div>

              {b.flagged && (
                <p className="text-xs text-amber-400 mt-2">
                  ⚠ Этот блок обеспечивает работу движка (JSON-контракт). Менять можно, но при
                  поломке формата парсер откатится на безопасный разбор — не удаляйте без нужды.
                </p>
              )}

              {b.dynamic ? (
                <p className="text-xs text-gray-500 mt-2">
                  Контент этого блока собирает движок автоматически из данных проекта
                  (источник: <code className="text-gray-400">{b.dynamic}</code>). Редактируется только
                  порядок и вкл/выкл.
                </p>
              ) : (
                b.enabled && (
                  <textarea
                    className="input h-28 mt-2 text-sm font-mono"
                    value={b.content}
                    onChange={(e) => patchBlock(b.id, { content: e.target.value })}
                  />
                )
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Параметры генерации (не часть пресета) */}
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
          <Field
            label="Префилл ответа (опц.)"
            hint='Начало JSON для стабилизации, напр. {"scene":. При стриминге форсируется автоматически.'
          >
            <input
              className="input"
              value={cfg.prefill || ''}
              placeholder='{"scene":'
              onChange={(e) => patch({ prefill: e.target.value || undefined })}
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
          <h4 className="font-semibold mb-3">Генерация изображений (image-API)</h4>
          <p className="text-xs text-gray-500 mb-3">
            OpenAI-совместимый эндпоинт /images/generations. Ключ хранится только в этом браузере.
            Используется кнопками «Создать фон/CG» в плеере.
          </p>
          <Field label="Image Base URL" hint="Пусто — берётся Base URL основного подключения.">
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
      </div>

      {/* Кастомные вставки на глубине (author's note style) */}
      <div className="card">
        <div className="flex items-center justify-between mb-2">
          <h4 className="font-semibold">Кастомные вставки (по глубине)</h4>
          <button
            className="btn-ghost !px-3 !py-1 text-xs"
            onClick={() => patchAdvBlocks([...(cfg.advancedBlocks || []), { content: '', depth: 1 }])}
          >
            + Вставка
          </button>
        </div>
        <p className="text-xs text-gray-500 mb-2">
          В отличие от блоков пресета (system), эти вставляются в историю сообщений. Глубина =
          сколько сообщений от конца. 0 — в самый конец, 1 — перед последним ходом.
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
                patchAdvBlocks(next);
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
                  patchAdvBlocks(next);
                }}
              />
              <button
                className="btn-danger !px-2 !py-1 text-xs mt-1 w-full"
                onClick={() => patchAdvBlocks((cfg.advancedBlocks || []).filter((_, j) => j !== i))}
              >
                Удалить
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
