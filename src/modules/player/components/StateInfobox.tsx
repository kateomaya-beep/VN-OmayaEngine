import { useState } from 'react';
import type { Project, WorldStateUpdate } from '../../../shared/types';
import { Avatar, characterAvatarKey } from './Avatar';

// ИНФОБОКС СОСТОЯНИЯ под ответом модели — в духе Horae: короткая сводка «где мы,
// сколько времени, кто здесь и что с ними» прямо в ленте, а не в отдельной панели.
//
// Рисуется НЕ регэкспом по тексту, а по разобранному служебному блоку <state>,
// который модель дописывает в конец ответа. Разница принципиальная: регэксп по
// тексту ломается от любой вольности в форматировании, а здесь те же самые данные
// уже разобраны и провалидированы — теми же, что кормят Game Master. Правила-
// регэкспы при этом никуда не делись, они для другого: править саму прозу.

const CHIP = 'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] bg-white/[0.06] border border-white/10';

export function StateInfobox({ project, state }: { project: Project; state: WorldStateUpdate }) {
  const [open, setOpen] = useState(false);
  const clock = state.clock;
  const chars = state.characters || [];
  const when = [clock?.day, clock?.month, clock?.year].filter(Boolean).join(' ');
  const head = [when, clock?.time, clock?.location].filter(Boolean);
  // Совсем пустая сводка (модель прислала блок, но без содержимого) — не рисуем
  // рамку ради рамки.
  if (!head.length && !chars.length && !state.event) return null;

  return (
    <div className="mt-3 rounded-xl border border-[rgba(180,150,255,0.18)] bg-black/25 overflow-hidden">
      <button
        className="w-full flex items-center gap-2 flex-wrap px-3 py-2 text-left hover:bg-white/[0.03]"
        onClick={() => setOpen((v) => !v)}
        title={open ? 'Свернуть сводку' : 'Развернуть сводку'}
      >
        {head.length > 0 ? (
          <>
            {clock?.location && <span className={CHIP}>📍 {clock.location}</span>}
            {(when || clock?.time) && (
              <span className={CHIP}>🕑 {[when, clock?.time].filter(Boolean).join(', ')}</span>
            )}
          </>
        ) : (
          <span className={CHIP}>🗂 сводка</span>
        )}
        {chars.length > 0 && (
          <span className="flex items-center -space-x-1.5 ml-0.5">
            {chars.slice(0, 4).map((c) => (
              <Avatar key={c.name} name={c.name} blobKey={characterAvatarKey(project, c.name)} size={20} />
            ))}
          </span>
        )}
        {state.mood && <span className={CHIP}>🎭 {state.mood}</span>}
        <span className="ml-auto text-[11px] text-gray-500">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="px-3 pb-3 pt-1 space-y-2 border-t border-white/[0.06]">
          {chars.map((c) => {
            const bits = [
              c.status && `${c.status}`,
              c.mood && `настроение: ${c.mood}`,
              c.outfit && `одежда: ${c.outfit}`,
              c.location && `где: ${c.location}`,
            ].filter(Boolean);
            return (
              <div key={c.name} className="flex gap-2.5">
                <Avatar name={c.name} blobKey={characterAvatarKey(project, c.name)} size={28} />
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-[color:var(--pl-text)]">{c.name}</div>
                  {bits.length > 0 && <div className="text-xs text-gray-400">{bits.join(' · ')}</div>}
                  {!!c.tags?.length && (
                    <div className="flex gap-1 flex-wrap mt-1">
                      {c.tags.map((t, i) => (
                        <span key={i} className={CHIP}>
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {state.event && (
            <div className="text-xs text-gray-400">
              <span className="text-gray-500">Событие: </span>
              {state.event}
              {state.eventLevel && state.eventLevel !== 'general' && (
                <span className="ml-1.5 text-[10px] uppercase tracking-wide text-accent2">
                  {state.eventLevel === 'key' ? 'ключевое' : 'важное'}
                </span>
              )}
            </div>
          )}
          {!!state.agendaAdd?.length && (
            <div className="text-xs text-gray-400">
              <span className="text-gray-500">Новые задачи: </span>
              {state.agendaAdd.join('; ')}
            </div>
          )}
          {!!state.agendaDone?.length && (
            <div className="text-xs text-gray-400">
              <span className="text-gray-500">Закрыто: </span>
              {state.agendaDone.join('; ')}
            </div>
          )}
          {!!state.locations?.length && (
            <div className="text-xs text-gray-400">
              <span className="text-gray-500">Места: </span>
              {state.locations.map((l) => l.name).join(', ')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
