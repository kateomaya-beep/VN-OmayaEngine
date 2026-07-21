import { useEffect, useRef, useState } from 'react';
import { Modal, AssetImage } from '../../../shared/ui';
import { useLang } from '../../../shared/i18n';
import { usePlayerStore } from '../playerStore';
import { getApiKey, setApiKey } from '../../../ai/keys';
import { composeCgPrompt } from '../../../ai/imagePrompt';
import { generateImage, blobToRef, type ImageRef } from '../../../ai/imageProvider';
import { useStylePresets } from '../../../ai/imageStyles';
import { getAssetBlob, putAsset, deleteAsset } from '../../../storage/db';
import { uploadAsset } from '../../../storage/assetOps';
import { uid } from '../../../shared/utils';
import { defaultImageGenConfig, type AssetMeta, type ImageGenConfig } from '../../../shared/types';

type Stage = 'idle' | 'analyze' | 'draw' | 'done' | 'error';
interface Result {
  blobKey: string;
  blob: Blob;
  url: string;
}

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// CG-студия (см. заявку): воркер по сцене собирает промпт → image-API (Nano Banana/
// OpenAI) с рефами → красивый reveal (скачать/удалить/в галерею) + галерея кат-сцен
// проекта. Настройки, системный промпт воркера, стиль-пресеты и рефы — здесь же.
export function CgStudio({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { lang } = useLang();
  const L = (ru: string, en: string) => (lang === 'en' ? en : ru);
  const s = usePlayerStore();
  const project = s.project;
  const state = s.state;
  const { presets, add: addPreset, remove: removePreset } = useStylePresets();

  const [showSettings, setShowSettings] = useState(false);
  const [imageKey, setImageKey] = useState('');
  const [stage, setStage] = useState<Stage>('idle');
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (open) setImageKey(getApiKey('image'));
  }, [open]);
  useEffect(() => () => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (result) URL.revokeObjectURL(result.url);
  }, [result]);

  if (!open || !project || !state) return null;
  const ig: ImageGenConfig = project.imageGen ?? defaultImageGenConfig();

  function patchIG(patch: Partial<ImageGenConfig>) {
    s.patchProject((p) => {
      p.imageGen = { ...(p.imageGen ?? defaultImageGenConfig()), ...patch };
    });
  }
  function setRef(charId: string, assetId?: string) {
    s.patchProject((p) => {
      const cur = p.imageGen ?? defaultImageGenConfig();
      const refs = { ...cur.references };
      if (assetId) refs[charId] = assetId;
      else delete refs[charId];
      p.imageGen = { ...cur, references: refs };
    });
  }

  // Нейтральный базовый спрайт персонажа — авто-референс.
  const autoRefAsset = (charId: string): string | undefined => {
    const c = project.characters.find((x) => x.id === charId);
    if (!c) return undefined;
    return c.sprites.neutral || Object.values(c.sprites)[0];
  };
  const effRefAsset = (charId: string): string | undefined => ig.references[charId] || autoRefAsset(charId);

  async function uploadRef(charId: string, file: File) {
    const asset = await uploadAsset(file, 'icon'); // 'icon' — не попадает в манифест сцены ИИ
    asset.name = `ref_${charId}`;
    await s.patchProject((p) => {
      if (!p.assets.some((a) => a.id === asset.id)) p.assets.push(asset);
      const cur = p.imageGen ?? defaultImageGenConfig();
      p.imageGen = { ...cur, references: { ...cur.references, [charId]: asset.id } };
    });
  }

  async function generate() {
    if (!project || !state) return;
    setError('');
    setResult(null);
    setPrompt('');
    setStage('analyze');
    setElapsed(0);
    const start = Date.now();
    timerRef.current = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 250);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const p = await composeCgPrompt(project, state, ig.systemPrompt);
      if (controller.signal.aborted) return;
      setPrompt(p);
      setStage('draw');

      // Референсы: инлайн-картинки присутствующих персонажей (только gemini + вкл.).
      const refs: ImageRef[] = [];
      if (ig.providerKind === 'gemini' && ig.sendReferences) {
        const seen = new Set<string>();
        for (const os of state.onScreen) {
          if (seen.has(os.characterId)) continue;
          seen.add(os.characterId);
          const aid = effRefAsset(os.characterId);
          const blobKey = project.assets.find((a) => a.id === aid)?.blobKey;
          if (!blobKey) continue;
          const b = await getAssetBlob(blobKey);
          if (b) refs.push(await blobToRef(b));
        }
      }
      const finalPrompt = [p, ig.style.trim()].filter(Boolean).join('\n\nStyle: ');
      const blob = await generateImage(ig, { prompt: finalPrompt, references: refs, signal: controller.signal });
      if (controller.signal.aborted) return;
      const blobKey = uid('blob');
      await putAsset(blobKey, blob);
      setResult({ blobKey, blob, url: URL.createObjectURL(blob) });
      setStage('done');
    } catch (e) {
      if (controller.signal.aborted) return;
      setError((e as Error).message);
      setStage('error');
    } finally {
      if (timerRef.current) clearInterval(timerRef.current);
      abortRef.current = null;
    }
  }

  function cancel() {
    abortRef.current?.abort();
    if (timerRef.current) clearInterval(timerRef.current);
    setStage('idle');
  }

  async function discardResult() {
    if (!result) return;
    URL.revokeObjectURL(result.url);
    await deleteAsset(result.blobKey);
    setResult(null);
    setStage('idle');
  }

  async function saveToGallery() {
    if (!result) return;
    const name = (prompt.split(/[\s,.]+/).slice(0, 4).join(' ') || 'CG').slice(0, 40);
    const asset: AssetMeta = {
      id: uid('cg'),
      type: 'cg',
      name,
      generated: true,
      blobKey: result.blobKey,
      mime: result.blob.type || 'image/png',
    };
    await s.patchProject((p) => {
      if (!p.assets.some((a) => a.id === asset.id)) p.assets.push(asset);
      const cur = p.imageGen ?? defaultImageGenConfig();
      p.imageGen = { ...cur, gallery: [...cur.gallery, asset.id] };
    });
    // Blob уже сохранён под result.blobKey — просто отвязываем UI (в галерею уже попал).
    setResult(null);
    setStage('idle');
  }

  async function galleryDownload(assetId: string) {
    const a = project!.assets.find((x) => x.id === assetId);
    if (!a) return;
    const b = await getAssetBlob(a.blobKey);
    if (b) downloadBlob(b, `${a.name || 'cg'}.png`);
  }
  function galleryDelete(assetId: string) {
    if (!window.confirm(L('Удалить эту кат-сцену из галереи?', 'Delete this cut-scene from the gallery?'))) return;
    s.patchProject((p) => {
      const cur = p.imageGen ?? defaultImageGenConfig();
      p.imageGen = { ...cur, gallery: cur.gallery.filter((id) => id !== assetId) };
      const a = p.assets.find((x) => x.id === assetId);
      p.assets = p.assets.filter((x) => x.id !== assetId);
      if (a) void deleteAsset(a.blobKey);
    });
  }
  function showInScene(assetId: string) {
    usePlayerStore.setState({ cg: assetId });
    onClose();
  }

  const busy = stage === 'analyze' || stage === 'draw';
  const galleryAssets = ig.gallery
    .map((id) => project.assets.find((a) => a.id === id))
    .filter((a): a is AssetMeta => !!a);
  const presentChars = project.characters.filter((c) => state.onScreen.some((o) => o.characterId === c.id));

  return (
    <Modal open={open} onClose={onClose} title={L('🎬 CG-студия', '🎬 CG Studio')} wide>
      <div className="max-h-[74vh] overflow-y-auto scrollbar-thin space-y-4 pr-1">
        {/* Reveal результата */}
        {result && (
          <div className="rounded-2xl overflow-hidden border border-[rgba(180,150,255,0.25)] bg-gradient-to-b from-[#241d33] to-[#0a0912] p-3 animate-[fadein_400ms]">
            <img src={result.url} alt="CG" className="w-full rounded-xl object-contain max-h-[52vh]" />
            <div className="flex gap-2 justify-end mt-3 flex-wrap">
              <button className="btn-ghost text-sm" onClick={() => downloadBlob(result.blob, 'cg.png')}>
                ⬇ {L('Скачать', 'Download')}
              </button>
              <button className="btn-ghost text-sm text-red-300" onClick={discardResult}>
                🗑 {L('Удалить', 'Delete')}
              </button>
              <button className="btn-primary text-sm" onClick={saveToGallery}>
                ⭐ {L('В галерею', 'Save to gallery')}
              </button>
            </div>
          </div>
        )}

        {/* Прогресс / кнопка генерации */}
        {!result && (
          <div className="glass-panel p-4 !rounded-2xl">
            {busy ? (
              <div className="text-center py-4">
                <div className="inline-block w-8 h-8 border-[3px] border-[var(--pl-accent,#b18cff)] border-t-transparent rounded-full animate-spin mb-3" />
                <div className="text-sm text-[#eae6f7]">
                  {stage === 'analyze' ? L('Анализирую сцену…', 'Analysing the scene…') : L('Рисую изображение…', 'Painting the image…')}
                </div>
                <div className="text-xs text-gray-500 mt-1">
                  {L('Стадия', 'Stage')} {stage === 'analyze' ? '1/2' : '2/2'} · {elapsed}s
                </div>
                {prompt && stage === 'draw' && (
                  <div className="text-[11px] text-gray-500 mt-2 max-w-md mx-auto line-clamp-3">{prompt}</div>
                )}
                <button className="btn-ghost text-xs mt-3" onClick={cancel}>
                  ✕ {L('Отменить', 'Cancel')}
                </button>
              </div>
            ) : (
              <div className="text-center py-2">
                <button className="btn-primary" onClick={generate}>
                  🎬 {L('Сгенерировать CG по текущей сцене', 'Generate a CG from the current scene')}
                </button>
                <div className="text-xs text-gray-500 mt-2">
                  {presentChars.length
                    ? L(`В кадре: ${presentChars.map((c) => c.name).join(', ')}`, `In frame: ${presentChars.map((c) => c.name).join(', ')}`)
                    : L('В кадре нет персонажей — выйдет CG окружения/настроения.', 'No characters in frame — an environment/mood CG.')}
                </div>
                {error && <div className="text-xs text-red-400 mt-2">⚠️ {error}</div>}
              </div>
            )}
          </div>
        )}

        {/* Галерея кат-сцен проекта */}
        <div>
          <div className="text-xs uppercase tracking-wide text-gray-500 mb-2">
            {L('Галерея кат-сцен', 'Cut-scene gallery')} · {galleryAssets.length}
          </div>
          {galleryAssets.length === 0 ? (
            <p className="text-sm text-gray-600">{L('Пока пусто. Сгенерируй и сохрани CG.', 'Empty. Generate and save a CG.')}</p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {galleryAssets.map((a) => (
                <div key={a.id} className="rounded-xl overflow-hidden border border-white/10 bg-black/40 group relative">
                  <AssetImage blobKey={a.blobKey} className="w-full aspect-video object-cover" />
                  <div className="absolute inset-x-0 bottom-0 flex justify-center gap-1 p-1.5 bg-gradient-to-t from-black/80 to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
                    <button className="btn-ghost !px-2 !py-1 text-xs" title={L('В сцену', 'Show')} onClick={() => showInScene(a.id)}>
                      ▶
                    </button>
                    <button className="btn-ghost !px-2 !py-1 text-xs" title={L('Скачать', 'Download')} onClick={() => galleryDownload(a.id)}>
                      ⬇
                    </button>
                    <button className="btn-ghost !px-2 !py-1 text-xs text-red-300" title={L('Удалить', 'Delete')} onClick={() => galleryDelete(a.id)}>
                      🗑
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Стиль + пресеты */}
        <div>
          <StyleControls
            L={L}
            style={ig.style}
            onStyle={(style) => patchIG({ style })}
            presets={presets}
            onSavePreset={(name) => addPreset(name, ig.style)}
            onPickPreset={(style) => patchIG({ style })}
            onDeletePreset={removePreset}
          />
        </div>

        {/* Референсы персонажей */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs uppercase tracking-wide text-gray-500">{L('Референсы', 'References')}</div>
            <label className="flex items-center gap-1.5 text-xs text-gray-400">
              <input
                type="checkbox"
                checked={ig.sendReferences}
                onChange={(e) => patchIG({ sendReferences: e.target.checked })}
              />
              {L('Отправлять рефы', 'Send references')}
            </label>
          </div>
          <p className="text-[11px] text-gray-500 mb-2">
            {L(
              'По умолчанию — нейтральный спрайт в базовой одежде. Можно переопределить своей картинкой. Рефы работают на провайдере Gemini.',
              'By default — the neutral base-outfit sprite. You can override with your own image. References work on the Gemini provider.'
            )}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {project.characters.map((c) => {
              const overridden = !!ig.references[c.id];
              return (
                <div key={c.id} className="card flex items-center gap-3 !p-2">
                  <AssetImage
                    blobKey={project.assets.find((a) => a.id === effRefAsset(c.id))?.blobKey}
                    className="w-10 h-10 rounded object-cover shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm truncate">{c.name}</div>
                    <div className="text-[11px] text-gray-500">
                      {overridden ? L('своя картинка', 'custom image') : L('авто (нейтр. спрайт)', 'auto (neutral sprite)')}
                    </div>
                  </div>
                  <label className="btn-ghost !px-2 !py-1 text-xs cursor-pointer shrink-0">
                    ⬆
                    <input
                      type="file"
                      accept="image/*"
                      hidden
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void uploadRef(c.id, f);
                      }}
                    />
                  </label>
                  {overridden && (
                    <button className="btn-ghost !px-2 !py-1 text-xs shrink-0" title={L('Сбросить на авто', 'Reset to auto')} onClick={() => setRef(c.id)}>
                      ↺
                    </button>
                  )}
                </div>
              );
            })}
            {project.characters.length === 0 && (
              <p className="text-sm text-gray-600">{L('Нет персонажей.', 'No characters.')}</p>
            )}
          </div>
        </div>

        {/* Системный промпт воркера + настройки подключения (сворачиваемо) */}
        <div>
          <button className="text-xs text-[var(--pl-accent-bright,#d3b8ff)] hover:underline" onClick={() => setShowSettings((v) => !v)}>
            {showSettings ? '▾' : '▸'} {L('Промпт-воркер и подключение', 'Prompt worker & connection')}
          </button>
          {showSettings && (
            <div className="mt-2 space-y-3">
              <div>
                <label className="label">{L('Системный промпт воркера (как собирать image-промпт)', 'Worker system prompt (how to build the image prompt)')}</label>
                <textarea
                  className="input h-40 font-mono text-xs"
                  value={ig.systemPrompt}
                  onChange={(e) => patchIG({ systemPrompt: e.target.value })}
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="label">{L('Провайдер картинок', 'Image provider')}</label>
                  <select className="input" value={ig.providerKind} onChange={(e) => patchIG({ providerKind: e.target.value as ImageGenConfig['providerKind'] })}>
                    <option value="gemini">Gemini / Nano Banana ({L('с рефами', 'with refs')})</option>
                    <option value="openai">{L('OpenAI-совместимый', 'OpenAI-compatible')} ({L('без рефов', 'no refs')})</option>
                  </select>
                </div>
                <div>
                  <label className="label">{L('Модель', 'Model')}</label>
                  <input
                    className="input"
                    placeholder={ig.providerKind === 'gemini' ? 'gemini-2.5-flash-image' : 'gpt-image-1'}
                    value={ig.model || ''}
                    onChange={(e) => patchIG({ model: e.target.value || undefined })}
                  />
                </div>
              </div>
              <div>
                <label className="label">Base URL</label>
                <input
                  className="input"
                  placeholder={ig.providerKind === 'gemini' ? 'https://generativelanguage.googleapis.com/v1beta' : 'https://api.openai.com/v1'}
                  value={ig.baseUrl || ''}
                  onChange={(e) => patchIG({ baseUrl: e.target.value || undefined })}
                />
              </div>
              <div>
                <label className="label">{L('API-ключ картинок', 'Image API key')}</label>
                <input
                  className="input"
                  type="password"
                  placeholder="sk-… / AIza…"
                  value={imageKey}
                  onChange={(e) => {
                    setImageKey(e.target.value);
                    setApiKey('image', e.target.value);
                  }}
                />
                <p className="text-[11px] text-gray-500 mt-1">{L('Хранится только в этом браузере.', 'Stored only in this browser.')}</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function StyleControls({
  L,
  style,
  onStyle,
  presets,
  onSavePreset,
  onPickPreset,
  onDeletePreset,
}: {
  L: (ru: string, en: string) => string;
  style: string;
  onStyle: (s: string) => void;
  presets: { id: string; name: string; style: string }[];
  onSavePreset: (name: string) => void;
  onPickPreset: (style: string) => void;
  onDeletePreset: (id: string) => void;
}) {
  const [sel, setSel] = useState('');
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="label !mb-0">{L('Стиль изображения', 'Image style')}</label>
        <div className="flex items-center gap-1.5">
          <select
            className="input !w-40 !py-1 text-xs"
            value={sel}
            onChange={(e) => {
              const p = presets.find((x) => x.id === e.target.value);
              setSel(e.target.value);
              if (p) onPickPreset(p.style);
            }}
          >
            <option value="">{L('— пресеты —', '— presets —')}</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {sel && (
            <button
              className="btn-ghost !px-2 !py-1 text-xs text-red-300"
              title={L('Удалить пресет', 'Delete preset')}
              onClick={() => {
                onDeletePreset(sel);
                setSel('');
              }}
            >
              🗑
            </button>
          )}
          <button
            className="btn-ghost !px-2 !py-1 text-xs"
            onClick={() => {
              const name = window.prompt(L('Имя стиля-пресета', 'Style preset name'));
              if (name && name.trim()) onSavePreset(name.trim());
            }}
          >
            💾 {L('Сохранить', 'Save')}
          </button>
        </div>
      </div>
      <textarea
        className="input h-20 text-sm"
        placeholder={L(
          'напр. полуреализм, кинематографичный свет, аниме-иллюстрация высокого качества, мягкие тени',
          'e.g. semi-realistic, cinematic lighting, high-quality anime illustration, soft shadows'
        )}
        value={style}
        onChange={(e) => onStyle(e.target.value)}
      />
    </div>
  );
}
