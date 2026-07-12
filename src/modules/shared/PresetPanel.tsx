import { useRef, useState } from 'react';
import { Modal, Field } from '../../shared/ui';
import {
  normalizePreset,
  defaultPreset,
  defaultBlockContent,
  parsePresetJson,
  type PromptPreset,
  type PromptBlock,
} from '../../ai/promptPreset';
import { uid } from '../../shared/utils';
import { downloadBlob } from '../../storage/zip';
import type { Project, AiConfig, AdvancedPromptBlock, LlmRole } from '../../shared/types';

// Редактор пресета промпта (Batch 3 §8) — вынесен в отдельное окно верхней панели,
// отделён от настроек API. Каждый блок: порядок (drag&drop), роль system/user/assistant
// (как в Таверне), редактируемый заголовок и текст, вкл/выкл, сброс, добавление/удаление.
const ROLES: { id: LlmRole; label: string }[] = [
  { id: 'system', label: 'S' },
  { id: 'user', label: 'U' },
  { id: 'assistant', label: 'A' },
];

export function PresetPanel({
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
  const [dragId, setDragId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  if (!open) return null;

  if (!project || !onPatch) {
    return (
      <Modal open={open} onClose={onClose} title="Пресет промпта">
        <p className="text-sm text-gray-400">
          Откройте проект (в конструкторе или в игре), чтобы редактировать его пресет промпта.
        </p>
      </Modal>
    );
  }

  const cfg = project.aiConfig;
  const preset = normalizePreset(cfg.promptPreset);

  const patch = (p: Partial<AiConfig>) => onPatch((proj) => Object.assign(proj.aiConfig, p));
  const savePreset = (next: PromptPreset) => onPatch((proj) => (proj.aiConfig.promptPreset = next));
  const patchBlock = (id: string, p: Partial<PromptBlock>) =>
    savePreset({ ...preset, blocks: preset.blocks.map((b) => (b.id === id ? { ...b, ...p } : b)) });
  const removeBlock = (id: string) =>
    savePreset({ ...preset, blocks: preset.blocks.filter((b) => b.id !== id) });
  const addBlock = () =>
    savePreset({
      ...preset,
      blocks: [...preset.blocks, { id: uid('blk'), name: 'Новый блок', enabled: true, content: '', role: 'system' }],
    });
  const resetBlock = (b: PromptBlock) => {
    if (!b.builtinKey) return;
    const content = defaultBlockContent(b.builtinKey);
    if (content !== null) patchBlock(b.id, { content, enabled: true });
  };
  const resetPreset = () => {
    if (confirm('Вернуть весь пресет к OmayaEngine по умолчанию? Правки блоков будут потеряны.'))
      savePreset(defaultPreset());
  };
  const reorder = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    const blocks = [...preset.blocks];
    const from = blocks.findIndex((b) => b.id === fromId);
    const to = blocks.findIndex((b) => b.id === toId);
    if (from === -1 || to === -1) return;
    const [moved] = blocks.splice(from, 1);
    blocks.splice(to, 0, moved);
    savePreset({ ...preset, blocks });
  };
  const exportPreset = () =>
    downloadBlob(
      new Blob([JSON.stringify(preset, null, 2)], { type: 'application/json' }),
      `${preset.name || 'preset'}.json`
    );
  const importPresetFile = async (file: File) => {
    try {
      const parsed = parsePresetJson(JSON.parse(await file.text()));
      if (!parsed) throw new Error('Невалидный файл пресета (нет массива blocks)');
      savePreset(parsed);
    } catch (e) {
      alert('Не удалось импортировать пресет: ' + (e as Error).message);
    }
  };
  const patchAdvBlocks = (blocks: AdvancedPromptBlock[]) =>
    onPatch((p) => (p.aiConfig.advancedBlocks = blocks));

  return (
    <Modal open={open} onClose={onClose} title="Пресет промпта" wide>
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <input
          className="input !py-1 text-sm max-w-xs"
          value={preset.name}
          onChange={(e) => savePreset({ ...preset, name: e.target.value })}
        />
        <div className="flex gap-2 flex-wrap">
          <button className="btn-ghost !px-3 !py-1 text-xs" onClick={addBlock}>
            + Блок
          </button>
          <button className="btn-ghost !px-3 !py-1 text-xs" onClick={exportPreset}>
            Экспорт
          </button>
          <button className="btn-ghost !px-3 !py-1 text-xs" onClick={() => fileRef.current?.click()}>
            Импорт
          </button>
          <button className="btn-ghost !px-3 !py-1 text-xs" onClick={resetPreset}>
            По умолчанию
          </button>
          <input
            ref={fileRef}
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
        Порядок = порядок в промпте. Перетаскивайте за ⠿; роль{' '}
        <b>S</b>/<b>U</b>/<b>A</b> = system/user/assistant (как в Таверне).{' '}
        <span className="text-amber-400">↳ блоки</span> наполняет движок (мир, персонажи, память).
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
            <div className="flex items-center gap-2 flex-wrap">
              <span className="cursor-grab select-none text-gray-500" title="Перетащить">
                ⠿
              </span>
              <input
                type="checkbox"
                checked={b.enabled}
                onChange={(e) => patchBlock(b.id, { enabled: e.target.checked })}
                title="Вкл/выкл блок"
              />
              <input
                className="input !py-1 text-sm flex-1 min-w-[8rem]"
                value={b.name}
                onChange={(e) => patchBlock(b.id, { name: e.target.value })}
              />
              {/* Роль блока S/U/A */}
              <div className="inline-flex rounded-lg overflow-hidden border border-white/10 text-xs">
                {ROLES.map((r) => (
                  <button
                    key={r.id}
                    title={r.id}
                    className={`px-2 py-1 ${
                      (b.role || 'system') === r.id ? 'bg-accent2 text-white' : 'bg-panel hover:bg-white/10'
                    }`}
                    onClick={() => patchBlock(b.id, { role: r.id })}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
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
                поломке формата парсер откатится на безопасный разбор.
              </p>
            )}

            {b.dynamic ? (
              <p className="text-xs text-gray-500 mt-2">
                Контент собирает движок из данных проекта (источник:{' '}
                <code className="text-gray-400">{b.dynamic}</code>). Редактируется порядок, роль и вкл/выкл.
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

      {/* Параметры генерации */}
      <div className="card !bg-panel2 mt-4">
        <h4 className="font-semibold mb-3">Параметры генерации</h4>
        <div className="grid sm:grid-cols-2 gap-3">
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
          <Field label={`Бюджет контекста: ${cfg.contextBudget}`}>
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
          <Field label="Префилл ответа (опц.)" hint='Начало JSON, напр. {"scene":'>
            <input
              className="input"
              value={cfg.prefill || ''}
              placeholder='{"scene":'
              onChange={(e) => patch({ prefill: e.target.value || undefined })}
            />
          </Field>
        </div>
      </div>

      {/* Кастомные вставки по глубине */}
      <div className="card !bg-panel2 mt-4">
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
          Вставляются в историю сообщений. Глубина = сколько сообщений от конца (0 — в самый конец).
        </p>
        {(cfg.advancedBlocks || []).map((b, i) => (
          <div key={i} className="flex gap-2 mb-2">
            <textarea
              className="input h-16 flex-1"
              value={b.content}
              placeholder="Текст вставки (макросы поддерживаются)"
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
    </Modal>
  );
}
