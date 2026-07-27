import { useRef, useState } from 'react';
import { useProjectStore } from '../projectStore';
import { AssetImage, Field } from '../../../shared/ui';
import { uid } from '../../../shared/utils';
import {
  EMOTIONS,
  EMOTION_LABELS,
  RELATIONSHIP_FIELDS,
  RELATIONSHIP_META,
  emptyRelationship,
} from '../../../shared/types';
import type {
  Character,
  CharacterRole,
  Emotion,
  AssetMeta,
  RelationshipField,
} from '../../../shared/types';
import { uploadAsset } from '../../../storage/assetOps';
import {
  characterOutfits,
  defaultOutfitTag,
  outfitSpriteMap,
  ensureOutfitMap,
} from '../../../shared/outfits';
import { clamp } from '../../../shared/utils';
import { parseSpriteZip } from '../../../storage/spriteZip';
import { importTavernCard } from '../../../storage/tavernCard';
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
  const [importBusy, setImportBusy] = useState(false);
  const [showExtraFields, setShowExtraFields] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);
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
        relationship: emptyRelationship(),
      })
    );
    setSelId(id);
  }

  // Импорт карточки персонажа Character Card V2/V3 (PNG/JSON) — см. CR v2 §D1.
  async function importCard(file: File) {
    setImportBusy(true);
    try {
      const { character, avatarAsset, lorebookEntries, hasSystemPrompt } = await importTavernCard(file);
      update((p) => {
        if (avatarAsset) p.assets.push(avatarAsset);
        p.characters.push(character);
        p.lorebook.push(...lorebookEntries);
      });
      setSelId(character.id);
      if (hasSystemPrompt) {
        alert(
          'В карточке найден system_prompt/post_history_instructions. Он НЕ применён автоматически ' +
            '(риск prompt-injection) — при желании добавьте нужное вручную в стиль на вкладке «ИИ / Промпт».'
        );
      }
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setImportBusy(false);
    }
  }

  function patchChar(id: string, fn: (c: Character) => void) {
    update((p) => {
      const c = p.characters.find((c) => c.id === id);
      if (c) fn(c);
    });
  }

  // Один протагонист на проект (CR v2 §B.4): при назначении демотим остальных.
  function setRole(id: string, role: CharacterRole) {
    update((p) => {
      if (role === 'protagonist') {
        for (const c of p.characters) {
          if (c.id !== id && c.role === 'protagonist') c.role = 'important_character';
        }
      }
      const c = p.characters.find((c) => c.id === id);
      if (c) c.role = role;
    });
  }

  return (
    <div className="grid md:grid-cols-[220px_1fr] gap-4">
      <div>
        <button className="btn-primary w-full mb-2" onClick={addChar}>
          + Персонаж
        </button>
        <input
          ref={importRef}
          type="file"
          accept=".png,.json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) importCard(f);
            e.target.value = '';
          }}
        />
        <button
          className="btn-ghost w-full mb-3 text-xs"
          disabled={importBusy}
          title="Импорт карточки персонажа SillyTavern/Janitor (PNG или JSON, v2/v3)"
          onClick={() => importRef.current?.click()}
        >
          {importBusy ? 'Импорт…' : '⭳ Импорт ST-карточки'}
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
                      onClick={() => setRole(selected.id, role)}
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

            <Field label="Описание персонажа" hint="Внешность, характер, предыстория — всё в одном поле. Поддерживаются макросы {{protagonist}} и др.">
              <textarea
                className="input h-48"
                placeholder="Кто это: внешность, характер, привычки, прошлое, мотивация…"
                value={selected.card.personality}
                onChange={(e) => patchChar(selected.id, (c) => (c.card.personality = e.target.value))}
              />
            </Field>
            <Field label="Манера речи" hint="Примеры реплик, лексика, тон. Поддерживаются макросы {{protagonist}} и др.">
              <textarea
                className="input h-20"
                value={selected.card.speechStyle}
                onChange={(e) =>
                  patchChar(selected.id, (c) => (c.card.speechStyle = e.target.value))
                }
              />
            </Field>
            {/* Внешность/предыстория — отдельные поля (опционально, напр. из импорта ST). */}
            {(showExtraFields || selected.card.appearance.trim() || selected.card.backstory.trim()) ? (
              <div className="space-y-3 rounded-lg border border-white/10 p-3">
                <div className="text-xs uppercase tracking-wide text-gray-500">Отдельные поля (опционально)</div>
                <Field label="Внешность">
                  <textarea
                    className="input h-16"
                    value={selected.card.appearance}
                    onChange={(e) => patchChar(selected.id, (c) => (c.card.appearance = e.target.value))}
                  />
                </Field>
                <Field label="Предыстория">
                  <textarea
                    className="input h-16"
                    value={selected.card.backstory}
                    onChange={(e) => patchChar(selected.id, (c) => (c.card.backstory = e.target.value))}
                  />
                </Field>
              </div>
            ) : (
              <button
                className="text-xs text-[var(--accent2,#a78bfa)] hover:underline"
                onClick={() => setShowExtraFields(true)}
              >
                + Внешность и предыстория отдельными полями
              </button>
            )}
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

          {selected.role !== 'protagonist' && (
            <div className="card">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h4 className="font-semibold">Статы отношений (стартовые)</h4>
                  <p className="text-xs text-gray-500">
                    Диапазон −100…+100. ИИ учитывает и меняет их по ходу игры.
                  </p>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={!!selected.relationshipHidden}
                    onChange={(e) =>
                      patchChar(selected.id, (c) => (c.relationshipHidden = e.target.checked || undefined))
                    }
                  />
                  Скрыть в инфобоксе
                </label>
              </div>
              <div className="grid grid-cols-3 gap-3">
                {RELATIONSHIP_FIELDS.map((f) => (
                  <div key={f}>
                    <label className="label flex items-center gap-1">
                      <span>{RELATIONSHIP_META[f].icon}</span>
                      {RELATIONSHIP_META[f].ru}
                    </label>
                    <input
                      type="number"
                      min={-100}
                      max={100}
                      className="input"
                      value={selected.relationship[f]}
                      onChange={(e) =>
                        patchChar(
                          selected.id,
                          (c) => (c.relationship[f as RelationshipField] = clamp(Number(e.target.value), -100, 100))
                        )
                      }
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

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
  const L = (ru: string, en: string) => (lang === 'ru' ? ru : en);
  const [tray, setTray] = useState<AssetMeta[]>([]);
  const [busy, setBusy] = useState(false);
  const [activeOutfit, setActiveOutfit] = useState('');
  const zipRef = useRef<HTMLInputElement>(null);
  const slotRefs = useRef<Record<string, HTMLInputElement | null>>({});
  if (!project) return null;
  const char = project.characters.find((c) => c.id === characterId)!;

  // Активный наряд в редакторе (Batch 5.3). Дефолтный набор спрайтов лежит в
  // char.sprites; доп. наряды — в char.outfits[]. Сетка эмоций всегда правит спрайты
  // ТЕКУЩЕГО наряда. Guard: если выбранный наряд исчез (сменили персонажа/удалили) —
  // откатываемся на дефолтный.
  const outfits = characterOutfits(char);
  const effOutfit = activeOutfit && outfits.includes(activeOutfit) ? activeOutfit : outfits[0];
  const activeMap = outfitSpriteMap(char, effOutfit);
  const isDefaultOutfit = effOutfit === defaultOutfitTag(char);

  function setSprite(emotion: Emotion, assetId: string | null, addAsset?: AssetMeta) {
    update((p) => {
      const c = p.characters.find((c) => c.id === characterId)!;
      if (addAsset && !p.assets.some((a) => a.id === addAsset.id)) p.assets.push(addAsset);
      const map = ensureOutfitMap(c, effOutfit);
      if (assetId) map[emotion] = assetId;
      else delete map[emotion];
    });
  }

  async function uploadToSlot(emotion: Emotion, file: File) {
    setBusy(true);
    const asset = await uploadAsset(file, 'sprite');
    asset.name = isDefaultOutfit ? `${char.name}_${emotion}` : `${char.name}_${effOutfit}_${emotion}`;
    setSprite(emotion, asset.id, asset);
    setBusy(false);
  }

  async function onZip(file: File) {
    setBusy(true);
    const { recognized, unrecognized } = await parseSpriteZip(file);
    update((p) => {
      const c = p.characters.find((c) => c.id === characterId)!;
      const map = ensureOutfitMap(c, effOutfit);
      for (const { emotion, asset } of recognized) {
        if (!p.assets.some((a) => a.id === asset.id)) p.assets.push(asset);
        map[emotion] = asset.id;
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

  // Описание-триггер наряда (когда его надевать) — уходит в подсказку ИИ.
  function setOutfitDesc(desc: string) {
    update((p) => {
      const c = p.characters.find((c) => c.id === characterId)!;
      const o = c.outfits?.find((x) => x.outfit === effOutfit);
      if (o) o.description = desc.trim() ? desc : undefined;
    });
  }

  // ---- Управление нарядами ----
  function addOutfit() {
    const tag = (window.prompt(L('Название наряда (тег), напр. suit, masked', 'Outfit tag, e.g. suit, masked')) || '').trim();
    if (!tag) return;
    if (outfits.includes(tag)) { setActiveOutfit(tag); return; }
    update((p) => {
      const c = p.characters.find((c) => c.id === characterId)!;
      c.outfits = c.outfits || [];
      c.outfits.push({ outfit: tag, sprites: {} });
    });
    setActiveOutfit(tag);
  }

  function renameOutfit(tag: string) {
    const next = (window.prompt(L('Новое название наряда', 'New outfit name'), tag) || '').trim();
    if (!next || next === tag || outfits.includes(next)) return;
    update((p) => {
      const c = p.characters.find((c) => c.id === characterId)!;
      if (tag === defaultOutfitTag(c)) c.defaultOutfit = next;
      else { const o = c.outfits?.find((x) => x.outfit === tag); if (o) o.outfit = next; }
    });
    setActiveOutfit(next);
  }

  function deleteOutfit(tag: string) {
    if (!window.confirm(L(`Удалить наряд «${tag}» со всеми его спрайтами?`, `Delete outfit "${tag}" and its sprites?`))) return;
    update((p) => {
      const c = p.characters.find((c) => c.id === characterId)!;
      c.outfits = (c.outfits || []).filter((o) => o.outfit !== tag);
    });
    setActiveOutfit(defaultOutfitTag(char));
  }

  // Сделать текущий (доп.) наряд дефолтным: его набор становится char.sprites,
  // прежний дефолтный переезжает в outfits[]. Тег дефолтного = этот наряд.
  function makeDefault(tag: string) {
    update((p) => {
      const c = p.characters.find((c) => c.id === characterId)!;
      const oldDefault = defaultOutfitTag(c);
      if (tag === oldDefault) return;
      c.outfits = c.outfits || [];
      const idx = c.outfits.findIndex((o) => o.outfit === tag);
      if (idx < 0) return;
      const newDefaultSprites = c.outfits[idx].sprites;
      c.outfits.splice(idx, 1);
      c.outfits.push({ outfit: oldDefault, sprites: c.sprites });
      c.sprites = newDefaultSprites;
      c.defaultOutfit = tag;
    });
    setActiveOutfit(tag);
  }

  const hasNeutral = !!activeMap.neutral;

  return (
    <div className="card">
      {/* Панель нарядов (Batch 5.3): вкладки-теги + управление. Дефолтный помечен ★. */}
      <div className="flex items-center gap-1.5 flex-wrap mb-3">
        {outfits.map((o) => {
          const isDflt = o === defaultOutfitTag(char);
          const activeTab = o === effOutfit;
          return (
            <span
              key={o}
              className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs cursor-pointer ${
                activeTab ? 'border-accent bg-accent/15 text-accent' : 'border-white/15 text-gray-300 hover:bg-white/5'
              }`}
              onClick={() => setActiveOutfit(o)}
              title={isDflt ? L('Наряд по умолчанию (fallback)', 'Default outfit (fallback)') : o}
            >
              {isDflt && <span className="text-accent">★</span>}
              {o}
            </span>
          );
        })}
        <button className="btn-ghost !px-2 !py-0.5 text-xs" onClick={addOutfit}>
          + {L('наряд', 'outfit')}
        </button>
      </div>

      {/* Действия над активным нарядом */}
      <div className="flex items-center gap-2 flex-wrap mb-3 text-xs">
        <button className="btn-ghost !px-2 !py-0.5" onClick={() => renameOutfit(effOutfit)}>
          ✎ {L('переименовать', 'rename')}
        </button>
        {!isDefaultOutfit && (
          <>
            <button className="btn-ghost !px-2 !py-0.5" onClick={() => makeDefault(effOutfit)}>
              ★ {L('сделать по умолчанию', 'set as default')}
            </button>
            <button className="btn-ghost !px-2 !py-0.5 text-red-300" onClick={() => deleteOutfit(effOutfit)}>
              ✕ {L('удалить наряд', 'delete outfit')}
            </button>
          </>
        )}
        <span className="text-gray-500">
          {L('Наряд', 'Outfit')}: <code>{effOutfit}</code>
          {isDefaultOutfit && ` · ${L('по умолчанию', 'default')}`}
        </span>
      </div>

      {/* Триггер-описание наряда (только у доп. нарядов): подсказывает ИИ, КОГДА его
          надевать. Дефолтный наряд — базовый облик, описание ему не нужно. */}
      {!isDefaultOutfit && (
        <div className="mb-3">
          <label className="label">{L('Когда надевать (подсказка ИИ)', 'When to wear (AI hint)')}</label>
          <input
            className="input"
            placeholder={L(
              'напр. когда персонаж раздет / в нижнем белье',
              'e.g. when the character is undressed / in underwear'
            )}
            value={char.outfits?.find((o) => o.outfit === effOutfit)?.description || ''}
            onChange={(e) => setOutfitDesc(e.target.value)}
          />
        </div>
      )}

      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <div>
          <h4 className="font-semibold">
            {L('Спрайты и эмоции', 'Sprites & emotions')}
            {!isDefaultOutfit && <span className="text-gray-400"> · {effOutfit}</span>}
          </h4>
          <p className="text-xs text-gray-500">
            {L('Нейминг', 'Naming')}:{' '}
            <code>
              {isDefaultOutfit
                ? `${char.name || 'ares'}_joy.png`
                : `${char.name || 'peter'}_${effOutfit}_surprise.png`}
            </code>
            . {L('Обязателен', 'Required')} <code>neutral</code> — {L('остальное подменяется им', 'others fall back to it')}.
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
          const assetId = activeMap[emo];
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
