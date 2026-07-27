import { Modal } from '../../../shared/ui';
import { usePlayerStore } from '../playerStore';
import { characterOutfits, defaultOutfitTag, hasExtraOutfits } from '../../../shared/outfits';

// Гардероб (ручная правка нарядов): если ИИ не переоделся, юзер задаёт костюм
// персонажу на текущую сцену. Меняет показанный спрайт сразу и уходит в контекст ИИ.
export function WardrobePanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const s = usePlayerStore();
  if (!open) return null;
  const project = s.project;
  const state = s.state;
  if (!project || !state) return null;

  // Персонажи с выбором нарядов (>1 тега). Текущий наряд — из onScreen, иначе дефолт.
  const dressable = project.characters.filter((c) => hasExtraOutfits(c));
  const currentOutfit = (charId: string): string => {
    const os = state.onScreen.find((o) => o.characterId === charId);
    const c = project.characters.find((x) => x.id === charId)!;
    return os?.outfit || defaultOutfitTag(c);
  };

  return (
    <Modal open={open} onClose={onClose} title="👗 Гардероб">
      <p className="text-xs text-gray-500 mb-3">
        Если персонаж не переоделся сам — задайте наряд вручную. Спрайт сменится сразу; ИИ увидит это
        со следующего хода. Наряды настраиваются у персонажей в конструкторе.
      </p>
      {dressable.length === 0 ? (
        <p className="text-sm text-gray-600">
          Ни у кого нет дополнительных нарядов. Добавьте наряды со спрайтами в конструкторе (у персонажа).
        </p>
      ) : (
        <div className="space-y-3 max-h-[60vh] overflow-y-auto scrollbar-thin pr-1">
          {dressable.map((c) => {
            const cur = currentOutfit(c.id);
            const onScreen = state.onScreen.some((o) => o.characterId === c.id);
            return (
              <div key={c.id} className="rounded-lg border border-white/10 bg-panel2 p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium">
                    {c.name}
                    {!onScreen && <span className="text-[11px] text-gray-500"> · не в кадре</span>}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {characterOutfits(c).map((tag) => {
                    const active = tag === cur;
                    const isDefault = tag === defaultOutfitTag(c);
                    return (
                      <button
                        key={tag}
                        onClick={() => s.setSceneOutfit(c.id, tag)}
                        className={`px-3 py-1.5 rounded-lg text-xs border transition-colors ${
                          active
                            ? 'bg-[var(--pl-accent,#8b5cf6)] text-white border-transparent'
                            : 'bg-white/5 border-white/10 text-gray-300 hover:bg-white/10'
                        }`}
                        title={isDefault ? 'Базовый наряд' : undefined}
                      >
                        {tag}
                        {isDefault ? ' •' : ''}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
