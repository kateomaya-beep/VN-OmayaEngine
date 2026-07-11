import { usePlayerStore } from '../playerStore';
import { Modal } from '../../../shared/ui';
import { RELATIONSHIP_FIELDS, RELATIONSHIP_META, emptyRelationship } from '../../../shared/types';
import type { RelationshipField } from '../../../shared/types';
import { clamp } from '../../../shared/utils';

// Инфобокс «Отношения» (Блок C.4): редактируемый экран статов отношений.
export function RelationshipsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const s = usePlayerStore();
  if (!open || !s.project || !s.state) return null;
  const project = s.project;
  const state = s.state;

  // Показываем всех, кроме протагониста и скрытых.
  const chars = project.characters.filter(
    (c) => c.role !== 'protagonist' && !c.relationshipHidden
  );

  function setRel(charId: string, field: RelationshipField, value: number) {
    usePlayerStore.setState((st) => {
      if (!st.state) return {};
      const cur = st.state.relationship[charId] || emptyRelationship();
      return {
        state: {
          ...st.state,
          relationship: {
            ...st.state.relationship,
            [charId]: { ...cur, [field]: clamp(value, -100, 100) },
          },
        },
      };
    });
  }

  return (
    <Modal open={open} onClose={onClose} title="Отношения" wide>
      <p className="text-xs text-gray-500 mb-3">
        Значения −100…+100. ИИ учитывает и меняет их; можно править вручную (страховка).
      </p>
      {chars.length === 0 && <p className="text-gray-600 text-sm">— нет персонажей —</p>}
      <div className="space-y-3">
        {chars.map((c) => {
          const rel = state.relationship[c.id] || emptyRelationship();
          return (
            <div key={c.id} className="card !p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="font-semibold">
                  {c.name}
                  {c.role === 'love_interest' && <span className="ml-1">♥</span>}
                  {c.role === 'important_character' && <span className="ml-1">★</span>}
                </span>
              </div>
              {c.card.relationshipArc && (
                <p className="text-xs text-gray-500 mb-2">{c.card.relationshipArc}</p>
              )}
              <div className="grid grid-cols-3 gap-2">
                {RELATIONSHIP_FIELDS.map((f) => (
                  <div key={f}>
                    <label className="text-xs text-gray-400 flex items-center gap-1">
                      <span>{RELATIONSHIP_META[f].icon}</span>
                      {RELATIONSHIP_META[f].ru}
                    </label>
                    <input
                      type="number"
                      min={-100}
                      max={100}
                      className="input text-sm"
                      value={rel[f]}
                      onChange={(e) => setRel(c.id, f, Number(e.target.value))}
                    />
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
