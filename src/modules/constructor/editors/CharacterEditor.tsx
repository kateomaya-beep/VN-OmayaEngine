import { useRef, useState } from 'react';
import { useProjectStore } from '../projectStore';
import { AssetImage, Field } from '../../../shared/ui';
import { uid } from '../../../shared/utils';
import { EMOTIONS, EMOTION_LABELS } from '../../../shared/types';
import type { Character, CharacterRole, Emotion, AssetMeta } from '../../../shared/types';
import { uploadAsset } from '../../../storage/assetOps';
import { parseSpriteZip } from '../../../storage/spriteZip';
import { useLang } from '../../../shared/i18n';

const ROLE_META: Record<CharacterRole, { icon: string; label: string }> = {
  love_interest: { icon: '♥', label: 'Любовный интерес' },
  important_character: { icon: '★', label: 'Важный персонаж' },
  protagonist: { icon: '👤', label: 'Протагонист (герой игрока)' },
  npc: { icon: '•', label: 'NPC (обычно вводит ИИ)' },
};

export function CharacterEditor() {
  const { project, update } = useProjectStore();
  const [selId, setSelId] = useState<string | null>(null);
  if (!project) return null;

  const selected = project.characters.find((c) => c.id === selId) || project.characters[0] || null;

  function addChar() {
    const id = uid('char');
    update((p) =>
      p.characters.push({
        id,
        name: 'Новый персонаж',
        role: 'love_interest',
        card: { appearance: '', personality: '', backstory: '', speechStyle: '' },
        sprites: {},
      })
    );
    setSelId(id);
  }

  function patchChar(id: string, fn: (c: Character) => void) {
    update((p) => {
      const c = p.characters.find((c) => c.id === id);
      if (c) fn(c);
    });
  }

  return (
    <div className="grid md:grid-cols-[220px_1fr] gap-4">
      <div>
        <button className="btn-primary w-full mb-3" onClick={addChar}>
          + Персонаж
        </button>
        <div className="space-y-1">
          {project.characters.map((c) => {
            const firstSpriteId = c.sprites.neutral || Object.values(c.sprites)[0];
            return (
              <button
                key={c.id}
                className={`w-full text-left px-3 py-2 rounded-lg text-sm flex items-center gap-2 ${
                  selected?.id === c.id ? 'bg-accent text-white' : 'bg-panel2 hover:bg-white/10'
                }`}
                onClick={() => setSelId(c.id)}
              >
                <AssetImage
                  blobKey={project.assets.find((a) => a.id === firstSpriteId)?.blobKey}
                  className="w-8 h-8 rounded-full object-cover shrink-0"
                />
                <span className="truncate flex-1">{c.name}</span>
                <span className="text-xs" title={ROLE_META[c.role].label}>
                  {ROLE_META[c.role].icon}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {selected ? (
        <div className="space-y-4">
          <div className="card">
            <div className="grid md:grid-cols-2 gap-3">
              <Field label="Имя">
                <input
                  className="input"
                  value={selected.name}
                  onChange={(e) => patchChar(selected.id, (c) => (c.name = e.target.value))}
                />
              </Field>
              <div>
                <label className="label">Роль</label>
                <div className="flex flex-wrap gap-2">
                  {(Object.keys(ROLE_META) as CharacterRole[]).map((role) => (
                    <button
                      key={role}
                      onClick={() => patchChar(selected.id, (c) => (c.role = role))}
                      className={`chip !px-3 !py-1.5 ${
                        selected.role === role ? 'bg-accent2 text-white' : ''
                      }`}
                      title={ROLE_META[role].label}
                    >
                      {ROLE_META[role].icon} {ROLE_META[role].label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <Field label="Внешность">
              <textarea
                className="input h-16"
                value={selected.card.appearance}
                onChange={(e) => patchChar(selected.id, (c) => (c.card.appearance = e.target.value))}
              />
            </Field>
            <Field label="Характер">
              <textarea
                className="input h-16"
                value={selected.card.personality}
                onChange={(e) =>
                  patchChar(selected.id, (c) => (c.card.personality = e.target.value))
                }
              />
            </Field>
            <Field label="Предыстория">
              <textarea
                className="input h-16"
                value={selected.card.backstory}
                onChange={(e) => patchChar(selected.id, (c) => (c.card.backstory = e.target.value))}
              />
            </Field>
            <Field label="Манера речи" hint="Примеры реплик, лексика, тон. Поддерживаются макросы {{protagonist}} и др.">
              <textarea
                className="input h-16"
                value={selected.card.speechStyle}
                onChange={(e) =>
                  patchChar(selected.id, (c) => (c.card.speechStyle = e.target.value))
                }
              />
            </Field>
            {selected.role === 'love_interest' && (
              <Field label="Арка отношений" hint="Как развивается роман с этим персонажем.">
                <textarea
                  className="input h-16"
                  value={selected.card.relationshipArc || ''}
                  onChange={(e) =>
                    patchChar(selected.id, (c) => (c.card.relationshipArc = e.target.value))
                  }
                />
              </Field>
            )}
            <button
              className="btn-danger !px-3 !py-1.5 text-xs"
              onClick={() => {
                update((p) => (p.characters = p.characters.filter((c) => c.id !== selected.id)));
                setSelId(null);
              }}
            >
              Удалить персонажа
            </button>
          </div>

          <SpriteBinder characterId={selected.id} />
        </div>
      ) : (
        <div className="card text-center text-gray-500 py-16">Создайте персонажа.</div>
      )}
    </div>
  );
}

function SpriteBinder({ characterId }: { characterId: string }) {
  const { project, update } = useProjectStore();
  const lang = useLang((s) => s.lang);
  const [tray, setTray] = useState<AssetMeta[]>([]);
  const [busy, setBusy] = useState(false);
  const zipRef = useRef<HTMLInputElement>(null);
  const slotRefs = useRef<Record<string, HTMLInputElement | null>>({});
  if (!project) return null;
  const char = project.characters.find((c) => c.id === characterId)!;

  function setSprite(emotion: Emotion, assetId: string | null, addAsset?: AssetMeta) {
    update((p) => {
      const c = p.characters.find((c) => c.id === characterId)!;
      if (addAsset && !p.assets.some((a) => a.id === addAsset.id)) p.assets.push(addAsset);
      if (assetId) c.sprites[emotion] = assetId;
      else delete c.sprites[emotion];
    });
  }

  async function uploadToSlot(emotion: Emotion, file: File) {
    setBusy(true);
    const asset = await uploadAsset(file, 'sprite');
    asset.name = `${char.name}_${emotion}`;
    setSprite(emotion, asset.id, asset);
    setBusy(false);
  }

  async function onZip(file: File) {
    setBusy(true);
    const { recognized, unrecognized } = await parseSpriteZip(file);
    update((p) => {
      const c = p.characters.find((c) => c.id === characterId)!;
      for (const { emotion, asset } of recognized) {
        if (!p.assets.some((a) => a.id === asset.id)) p.assets.push(asset);
        c.sprites[emotion] = asset.id;
      }
      for (const a of unrecognized) if (!p.assets.some((x) => x.id === a.id)) p.assets.push(a);
    });
    setTray((t) => [...t, ...unrecognized]);
    setBusy(false);
  }

  function assignFromTray(emotion: Emotion, assetId: string) {
    setSprite(emotion, assetId);
    setTray((t) => t.filter((a) => a.id !== assetId));
  }

  const hasNeutral = !!char.sprites.neutral;

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <div>
          <h4 className="font-semibold">Спрайты и эмоции</h4>
          <p className="text-xs text-gray-500">
            Нейминг: <code>имя_эмоция.png</code> (напр. <code>{char.name || 'ares'}_joy.png</code>).
            Обязателен <code>neutral</code> — остальное подменяется им.
          </p>
        </div>
        <div className="flex gap-2">
          <input
            ref={zipRef}
            type="file"
            accept=".zip"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onZip(f);
              e.target.value = '';
            }}
          />
          <button className="btn-ghost" disabled={busy} onClick={() => zipRef.current?.click()}>
            {busy ? 'Загрузка…' : '⭳ Загрузить архивом (zip)'}
          </button>
        </div>
      </div>

      {!hasNeutral && (
        <p className="text-sm text-amber-400 mb-3">⚠️ Не загружен обязательный спрайт neutral.</p>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        {EMOTIONS.map((emo) => {
          const assetId = char.sprites[emo];
          const asset = assetId && project.assets.find((a) => a.id === assetId);
          return (
            <div
              key={emo}
              className={`rounded-lg border p-2 ${
                assetId ? 'border-accent2/40 bg-panel2' : 'border-white/10'
              }`}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const id = e.dataTransfer.getData('text/plain');
                if (id) assignFromTray(emo, id);
              }}
            >
              <div className="aspect-[3/4] rounded overflow-hidden bg-ink mb-2 flex items-center justify-center">
                {asset ? (
                  <AssetImage blobKey={asset.blobKey} className="w-full h-full object-contain" />
                ) : (
                  <span className="text-gray-600 text-[10px] text-center px-1">
                    перетащите сюда
                  </span>
                )}
              </div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium">{EMOTION_LABELS[emo][lang]}</span>
                {emo === 'neutral' && <span className="text-xs text-accent">★</span>}
              </div>
              <input
                ref={(el) => (slotRefs.current[emo] = el)}
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) uploadToSlot(emo, f);
                  e.target.value = '';
                }}
              />
              <div className="flex gap-1">
                <button
                  className="btn-ghost !px-2 !py-0.5 text-xs flex-1"
                  onClick={() => slotRefs.current[emo]?.click()}
                >
                  {asset ? 'Заменить' : '+ файл'}
                </button>
                {asset && (
                  <button
                    className="btn-ghost !px-2 !py-0.5 text-xs"
                    onClick={() => setSprite(emo, null)}
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {tray.length > 0 && (
        <div className="mt-4">
          <h5 className="text-sm font-semibold mb-2 text-amber-300">
            Нераспознанные ({tray.length}) — перетащите в нужную ячейку
          </h5>
          <div className="flex flex-wrap gap-2">
            {tray.map((a) => (
              <div
                key={a.id}
                draggable
                onDragStart={(e) => e.dataTransfer.setData('text/plain', a.id)}
                className="w-16 rounded border border-white/10 p-1 cursor-grab bg-panel2"
                title={a.name}
              >
                <AssetImage blobKey={a.blobKey} className="w-full aspect-[3/4] object-contain" />
                <div className="text-[9px] truncate text-center mt-0.5">{a.name}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
