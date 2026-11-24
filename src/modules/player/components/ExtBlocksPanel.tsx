import { useRef, useState } from 'react';
import type { ImageGenConfig } from '../../../shared/types';
import {
  activeExtBlock,
  isBuiltinModified,
  parseTavernBlocks,
  toTavernJson,
  useExtBlocks,
  type ExtBlock,
  type TavernCtx,
} from '../../../ai/extBlocks';
import { pushToast } from '../../../shared/toast';
import { copyToClipboard } from '../../../shared/utils';

type L = (ru: string, en: string) => string;

const TARGET_LABEL = { nai: 'NovelAI · теги «сцена | персонаж»', text: 'Nano Banana и остальные · описание' } as const;

// РЕЖИМЫ КАРТИНКИ — внешние блоки (extBlocks из Таверны). Активный блок пишет
// промпт для «По сцене», иллюстраций в игре и «Проиллюстрировать». Свой активный
// у NovelAI и у остальных провайдеров. Блок вставляется JSON-ом из Таверны как есть.
export function ExtBlocksPanel({ ig, L }: { ig: ImageGenConfig; L: L }) {
  const lib = useExtBlocks();
  const target = ig.providerKind === 'novelai' ? 'nai' : 'text';
  const active = activeExtBlock(ig);
  const [editing, setEditing] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [paste, setPaste] = useState('');
  const fileRef = useRef<HTMLInputElement | null>(null);

  function importText(text: string) {
    const { blocks, error } = parseTavernBlocks(text);
    if (error) {
      pushToast('error', error);
      return;
    }
    let last: ExtBlock | null = null;
    for (const raw of blocks) last = lib.add(raw);
    if (last) {
      lib.setActive(last.target, last.id);
      setEditing(last.id);
    }
    pushToast('success', L(`Добавлено блоков: ${blocks.length}`, `Blocks added: ${blocks.length}`));
    setPaste('');
    setImportOpen(false);
  }

  const groups: ('nai' | 'text')[] = target === 'nai' ? ['nai', 'text'] : ['text', 'nai'];
  return (
    <details className="nf-ext-blocks rounded-xl border border-white/10 bg-panel2/60 p-3">
      <summary className="cursor-pointer text-sm font-semibold select-none">
        🧩 {L('Режим картинки', 'Image mode')}: <span className="text-accent2 nf-ext-active">{active?.title ?? L('нет', 'none')}</span>
      </summary>
      <p className="text-[11px] text-gray-400 mt-2">
        {L(
          'Блок — инструкция, по которой текстовая модель пишет промпт картинки (как extBlocks в Таверне). Активный блок работает для «По сцене», иллюстраций во время игры и «Проиллюстрировать». Блок вставляется из Таверны как есть — JSON целиком.',
          'A block is the instruction the text model uses to write the image prompt (like extBlocks in SillyTavern).'
        )}
      </p>

      {groups.map((t) => {
        const list = lib.blocks.filter((b) => b.target === t);
        const current = t === 'nai' ? lib.activeNai : lib.activeText;
        return (
          <div key={t} className={`mt-3 ${t === target ? '' : 'opacity-70'}`}>
            <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">
              {TARGET_LABEL[t]} {t === target && <span className="text-emerald-300 normal-case">· {L('сейчас выбран этот провайдер', 'current provider')}</span>}
            </div>
            <div className="space-y-1.5">
              {list.map((b) => (
                <BlockRow
                  key={b.id}
                  b={b}
                  active={b.id === current}
                  open={editing === b.id}
                  onPick={() => lib.setActive(t, b.id)}
                  onToggle={() => setEditing(editing === b.id ? null : b.id)}
                  L={L}
                />
              ))}
              {!list.length && <p className="text-[11px] text-gray-500">{L('Блоков нет.', 'No blocks.')}</p>}
            </div>
          </div>
        );
      })}

      <div className="mt-3">
        {importOpen ? (
          <div className="space-y-2 nf-ext-import">
            <textarea
              className="input h-28 text-[11px] font-mono nf-ext-paste"
              placeholder={L('Вставьте JSON блока из Таверны (один блок или массив)', 'Paste the block JSON from SillyTavern')}
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
            />
            <div className="flex gap-1.5 flex-wrap">
              <button className="btn-primary !px-3 !py-1 text-xs nf-ext-add" disabled={!paste.trim()} onClick={() => importText(paste)}>
                {L('Добавить', 'Add')}
              </button>
              <button className="btn-ghost !px-3 !py-1 text-xs" onClick={() => fileRef.current?.click()}>
                📄 {L('Из файла', 'From file')}
              </button>
              <button className="btn-ghost !px-3 !py-1 text-xs" onClick={() => setImportOpen(false)}>
                {L('Отмена', 'Cancel')}
              </button>
            </div>
          </div>
        ) : (
          <button className="btn-ghost !px-3 !py-1 text-xs nf-ext-import-open" onClick={() => setImportOpen(true)}>
            ＋ {L('Вставить блок из Таверны', 'Paste a SillyTavern block')}
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          multiple
          className="hidden nf-ext-file"
          onChange={async (e) => {
            for (const f of Array.from(e.target.files || [])) importText(await f.text());
            e.target.value = '';
          }}
        />
      </div>
    </details>
  );
}

function ctxLabel(c: TavernCtx): string {
  if (c.type === 'last_messages') return `последние сообщения: ${c.messages_count ?? 2}`;
  if (c.type === 'previous_block') return `прошлый вывод блока: ${c.block_count ?? 1}`;
  if (c.type === 'text') return `текст «${c.name || '…'}»`;
  return `${c.type} — не поддерживается, пропускается`;
}

function BlockRow({
  b,
  active,
  open,
  onPick,
  onToggle,
  L,
}: {
  b: ExtBlock;
  active: boolean;
  open: boolean;
  onPick: () => void;
  onToggle: () => void;
  L: L;
}) {
  const lib = useExtBlocks();
  const modified = isBuiltinModified(b);
  const raw = b.raw;
  const patchRaw = (p: Partial<typeof raw>) => lib.update(b.id, { raw: { ...raw, ...p } });
  const patchCtx = (i: number, p: Partial<TavernCtx>) =>
    patchRaw({ context: (raw.context || []).map((c, j) => (j === i ? { ...c, ...p } : c)) });
  return (
    <div className={`nf-ext-block rounded-lg border p-2 ${active ? 'border-accent2/60 bg-accent2/10' : 'border-white/10'}`} data-block={b.builtin || b.id}>
      <div className="flex items-center gap-2 flex-wrap">
        <label className="flex items-center gap-2 text-sm cursor-pointer flex-1 min-w-0">
          <input type="radio" checked={active} onChange={onPick} className="nf-ext-pick" />
          <span className="truncate">{b.title}</span>
          {b.builtin && <span className="text-[10px] text-gray-500">{modified ? L('встроенный, изменён', 'built-in, edited') : L('встроенный', 'built-in')}</span>}
        </label>
        <button className="btn-ghost !px-2 !py-0.5 text-xs nf-ext-edit" onClick={onToggle} title={L('Открыть и править', 'Open and edit')}>
          {open ? '▲' : '✎'}
        </button>
        <button
          className="btn-ghost !px-2 !py-0.5 text-xs"
          title={L('Скопировать JSON для Таверны', 'Copy JSON for SillyTavern')}
          onClick={async () => {
            await copyToClipboard(toTavernJson(b));
            pushToast('success', L('JSON блока скопирован', 'Block JSON copied'));
          }}
        >
          ⧉
        </button>
        {b.builtin ? (
          modified && (
            <button
              className="btn-ghost !px-2 !py-0.5 text-xs nf-ext-reset"
              title={L('Вернуть исходный текст', 'Restore the original')}
              onClick={() => window.confirm(L(`Вернуть «${b.title}» к исходному?`, `Restore «${b.title}»?`)) && lib.reset(b.id)}
            >
              ↺
            </button>
          )
        ) : (
          <button
            className="btn-ghost !px-2 !py-0.5 text-xs text-red-300 nf-ext-delete"
            title={L('Удалить блок', 'Delete block')}
            onClick={() => window.confirm(L(`Удалить блок «${b.title}»?`, `Delete «${b.title}»?`)) && lib.remove(b.id)}
          >
            🗑
          </button>
        )}
      </div>
      {open && (
        <div className="mt-2 space-y-2 text-xs">
          <div className="grid sm:grid-cols-2 gap-2">
            <label className="block">
              {L('Название', 'Title')}
              <input className="input !py-1 mt-1 nf-ext-title" value={b.title} onChange={(e) => lib.update(b.id, { title: e.target.value })} />
            </label>
            <label className="block">
              {L('Для провайдера', 'For provider')}
              <select className="input !py-1 mt-1 nf-ext-target" value={b.target} onChange={(e) => lib.update(b.id, { target: e.target.value as ExtBlock['target'] })}>
                <option value="nai">{TARGET_LABEL.nai}</option>
                <option value="text">{TARGET_LABEL.text}</option>
              </select>
            </label>
          </div>
          <label className="block">
            {L('Инструкция (prompt)', 'Instruction (prompt)')}
            <textarea className="input h-48 font-mono text-[11px] mt-1 nf-ext-prompt" value={raw.prompt} onChange={(e) => patchRaw({ prompt: e.target.value })} />
          </label>
          <div>
            <div className="text-gray-400 mb-1">{L('Контекст — что модель видит, по порядку:', 'Context — what the model sees, in order:')}</div>
            <div className="space-y-1.5">
              {(raw.context || []).map((c, i) => (
                <div key={c.id || i} className="rounded border border-white/10 p-1.5">
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={!c.disabled} onChange={(e) => patchCtx(i, { disabled: !e.target.checked })} />
                    <span className="flex-1">{ctxLabel(c)}</span>
                    <span className="text-gray-500">{c.role || 'user'}</span>
                  </label>
                  {c.type === 'last_messages' && (
                    <input
                      type="number"
                      min={1}
                      max={20}
                      className="input !py-0.5 !w-20 mt-1 nf-ext-msgcount"
                      value={c.messages_count ?? 2}
                      onChange={(e) => patchCtx(i, { messages_count: Math.max(1, Math.min(20, Number(e.target.value) || 1)) })}
                    />
                  )}
                  {c.type === 'previous_block' && (
                    <input
                      type="number"
                      min={1}
                      max={3}
                      className="input !py-0.5 !w-20 mt-1"
                      value={c.block_count ?? 1}
                      onChange={(e) => patchCtx(i, { block_count: Math.max(1, Math.min(3, Number(e.target.value) || 1)) })}
                    />
                  )}
                  {c.type === 'text' && (
                    <textarea className="input h-14 font-mono text-[11px] mt-1" value={c.text || ''} onChange={(e) => patchCtx(i, { text: e.target.value })} />
                  )}
                </div>
              ))}
            </div>
            <p className="text-[10px] text-gray-500 mt-1">
              {L(
                'Сверх этого модель всегда получает список людей истории с их внешностью (и тегами внешности для NovelAI) и, если задан, момент, который рисуем. Макросы {{user}}, {{char}}, {{persona}}, {{description}} работают, как в Таверне. Размер картинки берётся из настроек студии («Разрешение», «Не тратить Anlas»), а не из блока.',
                'The model also always gets the story people with their looks, and the moment to draw. Image size comes from the studio settings.'
              )}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
