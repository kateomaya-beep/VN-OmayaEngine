import { useState } from 'react';
import { useProjectStore } from '../projectStore';
import { AssetImage, Field } from '../../../shared/ui';
import { uid } from '../../../shared/utils';
import { EMOTIONS } from '../../../shared/types';
import type { Character, CharacterRole } from '../../../shared/types';

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
        role: 'npc',
        card: { appearance: '', personality: '', backstory: '', speechStyle: '' },
        sprites: [],
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
          {project.characters.map((c) => (
            <button
              key={c.id}
              className={`w-full text-left px-3 py-2 rounded-lg text-sm flex items-center gap-2 ${
                selected?.id === c.id ? 'bg-accent text-white' : 'bg-panel2 hover:bg-white/10'
              }`}
              onClick={() => setSelId(c.id)}
            >
              <AssetImage
                blobKey={c.sprites.find((s) => s.emotion === 'neutral')?.assetId
                  ? project.assets.find(
                      (a) => a.id === c.sprites.find((s) => s.emotion === 'neutral')?.assetId
                    )?.blobKey
                  : project.assets.find((a) => a.id === c.sprites[0]?.assetId)?.blobKey}
                className="w-8 h-8 rounded-full object-cover shrink-0"
              />
              <span className="truncate flex-1">{c.name}</span>
              {c.role === 'love_interest' && <span className="text-xs">💕</span>}
            </button>
          ))}
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
              <Field label="Роль">
                <select
                  className="input"
                  value={selected.role}
                  onChange={(e) =>
                    patchChar(selected.id, (c) => (c.role = e.target.value as CharacterRole))
                  }
                >
                  <option value="protagonist">Протагонист (ГГ)</option>
                  <option value="love_interest">Любовный интерес</option>
                  <option value="npc">NPC</option>
                </select>
              </Field>
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
            <Field label="Манера речи" hint="Примеры реплик, лексика, тон.">
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
  const [customEmotion, setCustomEmotion] = useState('');
  if (!project) return null;
  const char = project.characters.find((c) => c.id === characterId)!;
  const spriteAssets = project.assets.filter((a) => a.type === 'sprite');

  const boundEmotions = new Set(char.sprites.map((s) => s.emotion));
  const allEmotions = [...EMOTIONS, ...char.sprites.map((s) => s.emotion)].filter(
    (v, i, a) => a.indexOf(v) === i
  );

  function bind(emotion: string, assetId: string) {
    update((p) => {
      const c = p.characters.find((c) => c.id === characterId)!;
      const existing = c.sprites.find((s) => s.emotion === emotion);
      if (assetId === '') {
        c.sprites = c.sprites.filter((s) => s.emotion !== emotion);
      } else if (existing) {
        existing.assetId = assetId;
      } else {
        c.sprites.push({ emotion, assetId });
      }
    });
  }

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h4 className="font-semibold">Спрайты и эмоции</h4>
          <p className="text-xs text-gray-500">
            Обязателен минимум <code>neutral</code> — остальное подменяется им.
          </p>
        </div>
      </div>

      {spriteAssets.length === 0 && (
        <p className="text-sm text-amber-400 mb-3">
          Сначала загрузите спрайты на вкладке «Ассеты».
        </p>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {allEmotions.map((emo) => {
          const binding = char.sprites.find((s) => s.emotion === emo);
          const asset = binding && project.assets.find((a) => a.id === binding.assetId);
          return (
            <div
              key={emo}
              className={`rounded-lg border p-2 ${
                boundEmotions.has(emo) ? 'border-accent2/40 bg-panel2' : 'border-white/10'
              }`}
            >
              <div className="aspect-[3/4] rounded overflow-hidden bg-ink mb-2 flex items-center justify-center">
                {asset ? (
                  <AssetImage blobKey={asset.blobKey} className="w-full h-full object-contain" />
                ) : (
                  <span className="text-gray-600 text-xs">пусто</span>
                )}
              </div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium">{emo}</span>
                {emo === 'neutral' && <span className="text-xs text-accent">★</span>}
              </div>
              <select
                className="input text-xs !py-1"
                value={binding?.assetId || ''}
                onChange={(e) => bind(emo, e.target.value)}
              >
                <option value="">— нет —</option>
                {spriteAssets.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
          );
        })}
      </div>

      <div className="flex gap-2 mt-4 max-w-xs">
        <input
          className="input text-sm"
          placeholder="кастомная эмоция"
          value={customEmotion}
          onChange={(e) => setCustomEmotion(e.target.value)}
        />
        <button
          className="btn-ghost"
          onClick={() => {
            const e = customEmotion.trim().toLowerCase();
            if (e && !boundEmotions.has(e) && spriteAssets[0]) bind(e, spriteAssets[0].id);
            setCustomEmotion('');
          }}
        >
          + эмоция
        </button>
      </div>
    </div>
  );
}
