import { useState } from 'react';
import { useStylePresets, type StylePreset, type StylePresetInput } from '../../../ai/imageStyles';

type L = (ru: string, en: string) => string;

// Пресеты «стиль + нежелательное» в CG-студии: выбрать — применить сразу,
// 💾 — сохранить текущее (с тем же именем — перезаписать), 🗑 — удалить выбранный.
// Списки у NovelAI и у остальных провайдеров свои: теги и фразы не взаимозаменяемы.
export function StylePresetBar({
  kind,
  current,
  onApply,
  L,
}: {
  kind: StylePreset['kind'];
  current: () => StylePresetInput;
  onApply: (p: StylePreset) => void;
  L: L;
}) {
  const { presets, save, remove } = useStylePresets();
  const list = presets.filter((p) => p.kind === kind);
  const [sel, setSel] = useState('');
  const chosen = list.find((p) => p.id === sel);
  return (
    <div className={`nf-style-presets nf-style-presets-${kind} flex items-center gap-1.5 flex-wrap`}>
      <select
        className="input !w-44 !py-1 text-xs"
        value={chosen ? sel : ''}
        onChange={(e) => {
          const p = list.find((x) => x.id === e.target.value);
          setSel(e.target.value);
          if (p) onApply(p);
        }}
        title={L('Пресет стиля и «нежелательного»', 'Style + undesired preset')}
      >
        <option value="">{L(`— пресеты (${list.length}) —`, `— presets (${list.length}) —`)}</option>
        {list.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
            {p.kind === 'text' && p.negative === undefined ? L(' · только стиль', ' · style only') : ''}
          </option>
        ))}
      </select>
      {chosen && (
        <button
          className="btn-ghost !px-2 !py-1 text-xs text-red-300"
          title={L(`Удалить пресет «${chosen.name}»`, `Delete preset «${chosen.name}»`)}
          onClick={() => {
            if (!window.confirm(L(`Удалить пресет «${chosen.name}»?`, `Delete preset «${chosen.name}»?`))) return;
            remove(chosen.id);
            setSel('');
          }}
        >
          🗑
        </button>
      )}
      <button
        className="btn-ghost !px-2 !py-1 text-xs nf-style-save"
        title={L(
          kind === 'nai'
            ? 'Сохранить теги стиля, свои теги «нежелательного», пресет UC и галочку качества'
            : 'Сохранить стиль и «Чего быть не должно»',
          kind === 'nai' ? 'Save style tags, undesired tags, UC preset and quality' : 'Save style and «What to avoid»'
        )}
        onClick={() => {
          const name = window.prompt(L('Имя пресета (то же имя — перезапишет)', 'Preset name (same name overwrites)'), chosen?.name ?? '');
          if (name && name.trim()) setSel(save(name.trim(), current()));
        }}
      >
        💾 {L('Сохранить', 'Save')}
      </button>
    </div>
  );
}
