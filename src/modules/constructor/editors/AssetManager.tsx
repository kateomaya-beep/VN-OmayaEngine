import { useRef, useState } from 'react';
import { useProjectStore } from '../projectStore';
import { AssetImage, useAssetUrl } from '../../../shared/ui';
import { uploadAsset, removeAsset } from '../../../storage/assetOps';
import type { AssetMeta, AssetType } from '../../../shared/types';

const TYPES: { id: AssetType; label: string; accept: string }[] = [
  { id: 'background', label: 'Фоны', accept: 'image/*' },
  { id: 'sprite', label: 'Спрайты', accept: 'image/*' },
  { id: 'cg', label: 'CG', accept: 'image/*' },
  { id: 'icon', label: 'Иконки', accept: 'image/*' },
  { id: 'music', label: 'Музыка', accept: 'audio/*' },
  { id: 'sfx', label: 'Звуки', accept: 'audio/*' },
];

export function AssetManager() {
  const { project, update } = useProjectStore();
  const [filter, setFilter] = useState<AssetType>('background');
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  if (!project) return null;

  const current = TYPES.find((t) => t.id === filter)!;
  const list = project.assets.filter((a) => a.type === filter);

  async function onFiles(files: FileList) {
    setUploading(true);
    const metas: AssetMeta[] = [];
    for (const f of Array.from(files)) {
      metas.push(await uploadAsset(f, filter));
    }
    update((p) => p.assets.push(...metas));
    setUploading(false);
  }

  return (
    <div>
      <div className="flex flex-wrap gap-1 mb-4">
        {TYPES.map((t) => (
          <button
            key={t.id}
            className={`px-3 py-1.5 rounded-lg text-sm ${
              filter === t.id ? 'bg-accent2 text-white' : 'bg-panel2 hover:bg-white/10'
            }`}
            onClick={() => setFilter(t.id)}
          >
            {t.label} ({project.assets.filter((a) => a.type === t.id).length})
          </button>
        ))}
      </div>

      <input
        ref={fileRef}
        type="file"
        accept={current.accept}
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length) onFiles(e.target.files);
          e.target.value = '';
        }}
      />

      <div className="flex items-center gap-3 mb-4">
        <button className="btn-primary" onClick={() => fileRef.current?.click()} disabled={uploading}>
          {uploading ? 'Загрузка…' : `+ Загрузить ${current.label.toLowerCase()}`}
        </button>
        <p className="text-xs text-gray-500">
          Теги автоматически создаются из имени файла. Уточните их — по тегам ИИ выбирает ассеты.
        </p>
      </div>

      {list.length === 0 ? (
        <div className="card text-center text-gray-500 py-10">Нет ассетов этого типа.</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {list.map((a) => (
            <AssetCard key={a.id} asset={a} onRemove={() => update((p) => removeAsset(p, a.id))} />
          ))}
        </div>
      )}
    </div>
  );
}

function AssetCard({ asset, onRemove }: { asset: AssetMeta; onRemove: () => void }) {
  const { update } = useProjectStore();
  const [tagInput, setTagInput] = useState('');
  const isAudio = asset.type === 'music' || asset.type === 'sfx';
  const audioUrl = useAssetUrl(isAudio ? asset.blobKey : null);

  function patch(patch: Partial<AssetMeta>) {
    update((p) => {
      const a = p.assets.find((x) => x.id === asset.id);
      if (a) Object.assign(a, patch);
    });
  }
  function addTag() {
    const t = tagInput.trim().toLowerCase();
    if (t && !asset.tags.includes(t)) patch({ tags: [...asset.tags, t] });
    setTagInput('');
  }

  return (
    <div className={`card ${asset.tags.length === 0 ? 'border-amber-400/40' : ''}`}>
      {isAudio ? (
        <audio src={audioUrl || undefined} controls className="w-full mb-2 h-8" />
      ) : (
        <AssetImage
          blobKey={asset.blobKey}
          className="w-full aspect-video object-cover rounded mb-2 bg-panel2"
        />
      )}
      <input
        className="input mb-2 text-sm"
        value={asset.name}
        onChange={(e) => patch({ name: e.target.value })}
      />
      <div className="flex flex-wrap gap-1 mb-2">
        {asset.tags.map((t) => (
          <span key={t} className="chip">
            {t}
            <button
              className="text-gray-500 hover:text-red-400"
              onClick={() => patch({ tags: asset.tags.filter((x) => x !== t) })}
            >
              ✕
            </button>
          </span>
        ))}
        {asset.tags.length === 0 && <span className="text-xs text-amber-400">⚠️ нет тегов</span>}
      </div>
      <div className="flex gap-2">
        <input
          className="input text-sm"
          placeholder="+ тег"
          value={tagInput}
          onChange={(e) => setTagInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addTag()}
        />
        <button className="btn-ghost !px-2 !py-1" onClick={addTag}>
          +
        </button>
      </div>
      <div className="flex items-center justify-between mt-2">
        <code className="text-xs text-gray-600">{asset.id}</code>
        <button className="btn-danger !px-2 !py-1 text-xs" onClick={onRemove}>
          Удалить
        </button>
      </div>
    </div>
  );
}
