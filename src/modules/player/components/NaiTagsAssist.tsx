import { useState } from 'react';
import type { Project } from '../../../shared/types';
import { plainToNaiTags, type NaiTagField } from '../../../ai/novelaiPrompt';

type L = (ru: string, en: string) => string;

// «✨ В теги NovelAI»: человек пишет по-простому («акварель, слегка пастельные
// цвета, художник wlop, сильно кинематографичный свет»), ИИ переводит в теги по
// правилам NovelAI, код чинит веса. Поле не перезаписывается само: сначала превью.
export function NaiTagsAssist({
  project,
  field,
  value,
  onApply,
  L,
}: {
  project: Project;
  field: NaiTagField;
  value: string;
  onApply: (tags: string) => void;
  L: L;
}) {
  const [open, setOpen] = useState(false);
  const [plain, setPlain] = useState('');
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<{ tags: string; notes: string[] } | null>(null);
  const [err, setErr] = useState('');

  async function run() {
    if (!plain.trim()) return;
    setBusy(true);
    setErr('');
    try {
      const r = await plainToNaiTags(project, plain, field);
      if (!r.tags) setErr(L('Модель не вернула тегов — попробуйте ещё раз.', 'The model returned no tags.'));
      setOut(r);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        className={`btn-ghost !px-2 !py-0.5 text-[11px] nf-nai-assist-${field}`}
        onClick={() => {
          setOpen(true);
          setPlain(value);
          setOut(null);
          setErr('');
        }}
        title={L('Написать по-простому — ИИ переведёт в теги NovelAI', 'Write plainly — the AI converts it to NovelAI tags')}
      >
        ✨ {L('В теги NovelAI', 'To NovelAI tags')}
      </button>
    );
  }
  return (
    <div className={`nf-nai-assist nf-nai-assist-box-${field} mt-1 mb-2 rounded-lg border border-fuchsia-400/30 bg-black/20 p-2 space-y-2 w-full`}>
      <p className="text-[11px] text-gray-400">
        {field === 'style'
          ? L(
              'Через запятую, своими словами и на любом языке: стили, художники, техника, эпоха, палитра. Силу — словами: «сильно …», «очень сильно …», «слегка …», «без …». Без слов силы вес не ставится.',
              'Comma-separated, in your own words: styles, artists, medium, era, palette. Strength in words: "strongly", "slightly", "without".'
            )
          : L(
              'Что убрать с картинок, через запятую, своими словами: «кривые руки, лишние пальцы, водяные знаки, особенно размытость».',
              'What to avoid, comma-separated, in your own words.'
            )}
      </p>
      <textarea
        className="input h-16 text-sm nf-nai-assist-plain"
        value={plain}
        placeholder={field === 'style' ? L('например: акварель, художник wlop, сильно мягкий свет, слегка пастель', 'e.g. watercolor, artist wlop, strongly soft light') : L('например: кривые руки, лишние пальцы, текст', 'e.g. bad hands, extra fingers, text')}
        onChange={(e) => setPlain(e.target.value)}
      />
      <div className="flex gap-1.5 flex-wrap">
        <button className="btn-primary !px-3 !py-1 text-xs nf-nai-assist-run" disabled={busy || !plain.trim()} onClick={() => void run()}>
          {busy ? L('Перевожу…', 'Converting…') : L('Перевести в теги', 'Convert')}
        </button>
        <button className="btn-ghost !px-3 !py-1 text-xs" onClick={() => setOpen(false)}>
          {L('Закрыть', 'Close')}
        </button>
      </div>
      {err && <div className="text-[11px] text-red-300">{err}</div>}
      {out && out.tags && (
        <div className="space-y-1.5">
          <label className="text-[11px] text-gray-400">{L('Результат — можно поправить перед тем, как применить:', 'Result — editable before applying:')}</label>
          <textarea
            className="input h-16 text-sm font-mono nf-nai-assist-out"
            value={out.tags}
            onChange={(e) => setOut({ ...out, tags: e.target.value })}
          />
          {out.notes.length > 0 && (
            <ul className="text-[11px] text-amber-300/90 list-disc pl-4 nf-nai-assist-notes">
              {out.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          )}
          {field === 'style' && /artist:/.test(out.tags) && (
            <p className="text-[10px] text-gray-500">
              {L(
                'Имена художников отсюда проверить нельзя: если NovelAI художника не знает, тег просто не сработает. Проверить можно в самом NovelAI — он подсказывает известные теги при вводе.',
                'Artist names cannot be verified from here; NovelAI suggests known tags as you type in its own editor.'
              )}
            </p>
          )}
          <div className="flex gap-1.5 flex-wrap">
            <button
              className="btn-primary !px-3 !py-1 text-xs nf-nai-assist-apply"
              onClick={() => {
                onApply(out.tags);
                setOpen(false);
              }}
            >
              {L('Применить (заменить поле)', 'Apply (replace)')}
            </button>
            {value.trim() && (
              <button
                className="btn-ghost !px-3 !py-1 text-xs nf-nai-assist-append"
                onClick={() => {
                  onApply(`${value.trim().replace(/[,\s]+$/, '')}, ${out.tags}`);
                  setOpen(false);
                }}
              >
                {L('Добавить к полю', 'Append')}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
