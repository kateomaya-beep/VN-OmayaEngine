import { useEffect, useRef, useState } from 'react';
import { Modal, AssetImage } from '../../../shared/ui';
import { useLang } from '../../../shared/i18n';
import { usePlayerStore } from '../playerStore';
import { composeCgPrompt } from '../../../ai/imagePrompt';
import { supportsReferences } from '../../../ai/imageProvider';
import { renderImage, resolvePerson, type Person } from '../../../ai/imageCast';
import { useStylePresets } from '../../../ai/imageStyles';
import { ImageConnectionField } from '../../shared/ImageConnectionField';
import { getAssetBlob, putAsset, deleteAsset } from '../../../storage/db';
import { uploadAsset } from '../../../storage/assetOps';
import { uid } from '../../../shared/utils';
import {
  defaultImageGenConfig,
  IMAGE_ASPECT_RATIOS,
  IMAGE_ASPECT_LABELS,
  IMAGE_SIZE_TIERS,
  type AssetMeta,
  type ImageGenConfig,
  type ImageAspectSetting,
  type ImageSizeTier,
} from '../../../shared/types';

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

  const [stage, setStage] = useState<Stage>('idle');
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  // Состав кадра: null — авто (решает воркер по тексту сцены), массив — ручной выбор.
  const [castOverride, setCastOverride] = useState<string[] | null>(null);
  const [lastCast, setLastCast] = useState<string[] | null>(null); // кто попал в прошлый кадр
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
  // Два независимых слота на персонажа: внешность (лицо/волосы/телосложение) и
  // одежда (наряд). Одежда без авто-подстановки: спрайт как реф одежды бесполезен.
  type RefKind = 'appearance' | 'outfit';
  const refMap = (cur: ImageGenConfig, kind: RefKind) =>
    kind === 'outfit' ? { ...(cur.outfitReferences || {}) } : { ...cur.references };
  const withRefMap = (cur: ImageGenConfig, kind: RefKind, refs: Record<string, string>): ImageGenConfig =>
    kind === 'outfit' ? { ...cur, outfitReferences: refs } : { ...cur, references: refs };

  function setRef(charId: string, kind: RefKind, assetId?: string) {
    s.patchProject((p) => {
      const cur = p.imageGen ?? defaultImageGenConfig();
      const refs = refMap(cur, kind);
      if (assetId) refs[charId] = assetId;
      else delete refs[charId];
      p.imageGen = withRefMap(cur, kind, refs);
    });
  }

  // Нейтральный базовый спрайт персонажа — авто-референс внешности.
  const autoRefAsset = (charId: string): string | undefined => {
    const c = project.characters.find((x) => x.id === charId);
    if (!c) return undefined;
    return c.sprites.neutral || Object.values(c.sprites)[0];
  };
  const effRefAsset = (charId: string): string | undefined => ig.references[charId] || autoRefAsset(charId);
  const outfitRefAsset = (charId: string): string | undefined => ig.outfitReferences?.[charId];

  // Кому вообще можно задать реф. Не только персонажам проекта: у мамы, папы или
  // любого, кого нашёл Game Master, карточки нет — а рисовать их надо (аватарки,
  // фото от них). Ключ реф-мапы = id записи, они между источниками не пересекаются.
  type RefTarget = { id: string; name: string; note?: string };
  const refTargets: RefTarget[] = [];
  const seenRef = new Set<string>();
  const pushTarget = (t: RefTarget) => {
    if (t.id && !seenRef.has(t.id)) {
      seenRef.add(t.id);
      refTargets.push(t);
    }
  };
  for (const c of project.characters) pushTarget({ id: c.id, name: c.name });
  for (const r of state.gm.registry || []) {
    pushTarget({ id: r.id, name: r.canonicalName, note: L('найден Game Master', 'found by Game Master') });
  }
  for (const ct of state.phone?.contacts || []) {
    if (ct.characterId || ct.registryId) continue; // уже покрыт выше
    pushTarget({ id: ct.id, name: ct.name || ct.id, note: L('контакт в телефоне', 'phone contact') });
  }

  async function uploadRef(charId: string, kind: RefKind, file: File) {
    const asset = await uploadAsset(file, 'icon'); // 'icon' — не попадает в манифест сцены ИИ
    asset.name = `ref_${kind}_${charId}`;
    await s.patchProject((p) => {
      if (!p.assets.some((a) => a.id === asset.id)) p.assets.push(asset);
      const cur = p.imageGen ?? defaultImageGenConfig();
      p.imageGen = withRefMap(cur, kind, { ...refMap(cur, kind), [charId]: asset.id });
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
      const { prompt: p, aspectRatio: workerAspect, cast } = await composeCgPrompt(project, state, ig.systemPrompt, {
        onlyCharacterIds: castOverride ?? undefined,
      });
      if (controller.signal.aborted) return;
      setPrompt(p);
      setStage('draw');

      // Кто реально в кадре. Ручной выбор важнее; иначе — строка CAST от воркера
      // (он прочитал момент и назвал участников); если её нет — все, кто на сцене.
      // Именно это отсекает NPC, который «на сцене», но в кат-сцене не участвует:
      // раньше ему всё равно уходил референс, и он лез в каждый кадр.
      //
      // Имена из CAST разрешаем через общий механизм личности: раньше они
      // сверялись только с персонажами проекта, и человек из реестра Game Master
      // (у кого анкеты нет) не получал ни описания внешности, ни рефа.
      let inFrame: Person[];
      if (castOverride) {
        inFrame = castOverride
          .map((id) => resolvePerson(project, state, { id }))
          .filter((x): x is Person => !!x);
      } else if (cast) {
        inFrame = cast
          .map((name) => resolvePerson(project, state, { name }))
          .filter((x): x is Person => !!x);
      } else {
        inFrame = state.onScreen
          .map((o) => resolvePerson(project, state, { id: o.characterId }))
          .filter((x): x is Person => !!x);
      }
      const uniq: Person[] = [];
      for (const person of inFrame) if (!uniq.some((x) => x.id === person.id)) uniq.push(person);
      setLastCast(uniq.map((x) => x.name));

      // Стиль, описания людей в кадре и их референсы — общей сборкой (та же,
      // что у селфи, фото от ботов и быстрых действий).
      const { blob } = await renderImage(project, state, {
        prompt: p,
        cast: uniq,
        withOutfit: true,
        // «Авто» — кадр выбрал воркер (строка ASPECT в конце промпта).
        aspectRatio: ig.aspectRatio === 'auto' ? workerAspect || '16:9' : undefined,
        signal: controller.signal,
      });
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
                {/* Состав кадра. «Авто» — воркер сам решает по тексту момента, кто
                    в нём участвует: персонаж может быть «на сцене», но к этой
                    кат-сцене отношения не иметь. Чипы — ручное переопределение. */}
                <div className="mt-2.5 flex flex-wrap items-center justify-center gap-1.5">
                  <span className="text-[11px] text-gray-500">{L('В кадре:', 'In frame:')}</span>
                  <button
                    className={`chip !px-2.5 !py-1 text-xs ${castOverride === null ? 'bg-accent2 text-white' : ''}`}
                    onClick={() => setCastOverride(null)}
                    title={L('Решает ИИ по тексту сцены', 'The AI decides from the scene text')}
                  >
                    ✨ {L('авто', 'auto')}
                  </button>
                  {presentChars.map((c) => {
                    const on = castOverride === null ? false : castOverride.includes(c.id);
                    return (
                      <button
                        key={c.id}
                        className={`chip !px-2.5 !py-1 text-xs ${on ? 'bg-accent2 text-white' : ''}`}
                        onClick={() =>
                          setCastOverride((prev) => {
                            const base = prev ?? [];
                            return base.includes(c.id) ? base.filter((x) => x !== c.id) : [...base, c.id];
                          })
                        }
                      >
                        {c.name}
                      </button>
                    );
                  })}
                </div>
                <div className="text-[11px] text-gray-500 mt-1.5">
                  {presentChars.length === 0
                    ? L('На сцене никого — выйдет CG окружения/настроения.', 'Nobody on stage — an environment/mood CG.')
                    : castOverride === null
                      ? lastCast
                        ? L(
                            `В прошлый раз ИИ взял: ${lastCast.length ? lastCast.join(', ') : 'никого (кадр без людей)'}`,
                            `Last time the AI picked: ${lastCast.length ? lastCast.join(', ') : 'nobody (a shot without people)'}`
                          )
                        : L(
                            'ИИ сам выберет, кто участвует в этом моменте — остальные в кадр не попадут.',
                            'The AI picks who belongs in this moment — the rest stay out of frame.'
                          )
                      : castOverride.length
                        ? L('Ручной состав кадра.', 'Manual cast.')
                        : L('Никто не выбран — выйдет кадр без людей.', 'Nobody selected — a shot without people.')}
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

        {/* Кадр: соотношение сторон + разрешение (у Nano Banana — родные параметры) */}
        <div>
          <div className="text-xs uppercase tracking-wide text-gray-500 mb-2">{L('Кадр', 'Frame')}</div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="label">{L('Соотношение сторон', 'Aspect ratio')}</label>
              <select
                className="input"
                value={ig.aspectRatio || 'auto'}
                onChange={(e) => patchIG({ aspectRatio: e.target.value as ImageAspectSetting })}
              >
                <option value="auto">{L('Авто — выбирает ИИ по сцене', 'Auto — the AI picks it')}</option>
                {IMAGE_ASPECT_RATIOS.map((r) => (
                  <option key={r} value={r}>
                    {lang === 'en' ? r : IMAGE_ASPECT_LABELS[r]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">{L('Разрешение', 'Resolution')}</label>
              <select
                className="input"
                value={ig.imageSize || '1K'}
                onChange={(e) => patchIG({ imageSize: e.target.value as ImageSizeTier })}
              >
                {IMAGE_SIZE_TIERS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                    {t === '1K' ? ' · ~1024px' : t === '2K' ? ' · ~2048px' : ' · ~4096px'}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <p className="text-[11px] text-gray-500 mt-1">
            {ig.providerKind === 'gemini'
              ? L(
                  '2K/4K умеет только Pro-модель Nano Banana — на остальных движок сам вернётся к 1K. Фон всегда рисуется горизонтальным, селфи — вертикальным.',
                  'Only the Nano Banana Pro model supports 2K/4K — others fall back to 1K automatically. Backgrounds are always landscape, selfies portrait.'
                )
              : ig.providerKind === 'openai_chat'
                ? L(
                    'На шлюзах-роутерах единого поля кадра нет: соотношение уходит и параметром, и текстом промпта — модель обычно его соблюдает. Фон рисуется горизонтальным, селфи — вертикальным.',
                    'Router gateways have no standard frame field: the ratio is sent both as a parameter and in the prompt. Backgrounds are landscape, selfies portrait.'
                  )
                : L(
                    'Соотношение и разрешение пересчитываются в размер в пикселях. Часть провайдеров принимает только свой список размеров.',
                    'Ratio and resolution are converted to a pixel size. Some providers accept only their own fixed sizes.'
                  )}
          </p>
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
          <div className="mt-3">
            <label className="label">{L('Чего быть не должно', 'What to avoid')}</label>
            <p className="text-[11px] text-gray-500 mb-1">
              {L(
                'Уходит в промпт строкой «Avoid: …» — отдельного параметра negative prompt у этих провайдеров нет. Здесь держат список типовых артефактов: кривые руки, невозможные позы, лишние конечности.',
                'Sent as an "Avoid: …" line — these providers have no negative-prompt parameter. Keep the usual artefacts here: broken hands, impossible poses, extra limbs.'
              )}
            </p>
            <textarea
              className="input h-20 text-sm"
              value={ig.negativePrompt || ''}
              onChange={(e) => patchIG({ negativePrompt: e.target.value })}
            />
          </div>
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
            {supportsReferences(ig)
              ? L(
                  'На каждого — два слота. ВНЕШНОСТЬ: лицо, волосы, телосложение. По умолчанию берётся нейтральный спрайт, но можно загрузить свою картинку — она заменит спрайт везде (CG, селфи, фото от ботов, аватарки в мессенджере). ОДЕЖДА: отдельная картинка наряда — уходит вторым изображением с пометкой «отсюда только одежда». В списке не только персонажи проекта: те, кого нашёл Game Master, и контакты телефона без карточки тоже здесь.',
                  'Two slots each. APPEARANCE: face, hair, build. Defaults to the neutral sprite, but you can upload your own image — it replaces the sprite everywhere (CG, selfies, bot photos, messenger avatars). OUTFIT: a separate clothing image, sent as a second reference marked "clothes only". The list covers more than project characters: people found by the Game Master and phone contacts without a card are here too.'
                )
              : L(
                  'Выбранный провайдер (images/generations) рефы не принимает — картинка рисуется только по тексту. Рефы работают на Google напрямую и на шлюзах через chat/completions.',
                  'The selected provider (images/generations) takes no references — text only. References work with Google direct and with gateways via chat/completions.'
                )}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {refTargets.map((c) => (
              <div key={c.id} className="card !p-2">
                <div className="text-sm truncate mb-1.5">
                  {c.name}
                  {c.note && <span className="ml-1.5 text-[10px] text-gray-500">· {c.note}</span>}
                </div>
                <div className="flex gap-2">
                  <RefSlot
                    L={L}
                    title={L('Внешность', 'Appearance')}
                    blobKey={project.assets.find((a) => a.id === effRefAsset(c.id))?.blobKey}
                    note={
                      ig.references[c.id]
                        ? L('своя картинка', 'custom image')
                        : L('авто (спрайт)', 'auto (sprite)')
                    }
                    custom={!!ig.references[c.id]}
                    onUpload={(f) => void uploadRef(c.id, 'appearance', f)}
                    onReset={() => setRef(c.id, 'appearance')}
                  />
                  <RefSlot
                    L={L}
                    title={L('Одежда', 'Outfit')}
                    blobKey={project.assets.find((a) => a.id === outfitRefAsset(c.id))?.blobKey}
                    note={outfitRefAsset(c.id) ? L('своя картинка', 'custom image') : L('не задан', 'not set')}
                    custom={!!outfitRefAsset(c.id)}
                    onUpload={(f) => void uploadRef(c.id, 'outfit', f)}
                    onReset={() => setRef(c.id, 'outfit')}
                  />
                </div>
              </div>
            ))}
            {refTargets.length === 0 && (
              <p className="text-sm text-gray-600">{L('Нет персонажей.', 'No characters.')}</p>
            )}
          </div>
        </div>

        {/* Подключение к image-API и промпт-воркер — здесь же: всё про картинки в одном месте. */}
        <details className="rounded-xl border border-white/10 bg-panel2/60 p-3" open={!ig.model}>
          <summary className="cursor-pointer text-sm font-semibold select-none">
            🔌 {L('Подключение к image-API', 'Image API connection')}
          </summary>
          <div className="mt-3">
            <ImageConnectionField cfg={ig} onChange={patchIG} />
            <div className="mt-3">
              <label className="label">{L('Системный промпт воркера', 'Prompt-worker system prompt')}</label>
              <p className="text-[11px] text-gray-500 mb-1">
                {L(
                  'Как превратить текущую сцену в промпт для картинки. Работает через ОСНОВНОЕ подключение (текстовая модель), не через image-API.',
                  'How the current scene is turned into an image prompt. Runs on the MAIN (text) connection, not the image API.'
                )}
              </p>
              <textarea
                className="input h-32 font-mono text-xs"
                value={ig.systemPrompt}
                onChange={(e) => patchIG({ systemPrompt: e.target.value })}
              />
            </div>
          </div>
        </details>
      </div>
    </Modal>
  );
}

// Один слот референса: превью, подпись, загрузка и сброс.
function RefSlot({
  L,
  title,
  blobKey,
  note,
  custom,
  onUpload,
  onReset,
}: {
  L: (ru: string, en: string) => string;
  title: string;
  blobKey?: string;
  note: string;
  custom: boolean;
  onUpload: (file: File) => void;
  onReset: () => void;
}) {
  return (
    <div className="flex-1 min-w-0 rounded-lg bg-black/25 border border-white/10 p-1.5">
      <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">{title}</div>
      <div className="flex items-center gap-1.5">
        {blobKey ? (
          <AssetImage blobKey={blobKey} className="w-9 h-9 rounded object-cover shrink-0" />
        ) : (
          <div className="w-9 h-9 rounded bg-white/5 border border-dashed border-white/15 shrink-0" />
        )}
        <div className="min-w-0 flex-1 text-[10px] text-gray-500 truncate">{note}</div>
        <label className="btn-ghost !px-1.5 !py-1 text-xs cursor-pointer shrink-0" title={L('Загрузить', 'Upload')}>
          ⬆
          <input
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onUpload(f);
            }}
          />
        </label>
        {custom && (
          <button
            className="btn-ghost !px-1.5 !py-1 text-xs shrink-0"
            title={L('Убрать картинку', 'Remove image')}
            onClick={onReset}
          >
            ↺
          </button>
        )}
      </div>
    </div>
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
