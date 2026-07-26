import { useState } from 'react';
import { Modal } from '../../../shared/ui';
import { useLang } from '../../../shared/i18n';
import { uid } from '../../../shared/utils';
import { usePlayerStore } from '../playerStore';
import { defaultRandomEvents, RANDOM_EVENT_LABELS, type AuthorNote } from '../../../shared/types';

// Панель у поля ввода — две вкладки (см. patch-events-panel):
//  1) «Заметки для ИИ» — как раньше (persistent-инструкции, инжект перед ходом);
//  2) «События» — настройки рандом-ивентов прямо в игре (применяются со следующего хода;
//     конфиг живёт в project.randomEvents, счётчик кулдауна — в сейве прохождения).
export function AuthorNotesPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const lang = useLang((s) => s.lang);
  const L = (ru: string, en: string) => (lang === 'en' ? en : ru);
  const [tab, setTab] = useState<'notes' | 'events'>('notes');
  if (!open) return null;

  return (
    <Modal open={open} onClose={onClose} title={L('Заметки и события', 'Notes & events')}>
      {/* Вкладки — крупные тап-таргеты для мобилки */}
      <div className="flex gap-1.5 mb-4 p-1 rounded-xl bg-black/30 border border-white/10">
        <TabButton active={tab === 'notes'} onClick={() => setTab('notes')}>
          📝 {L('Заметки для ИИ', "AI notes")}
        </TabButton>
        <TabButton active={tab === 'events'} onClick={() => setTab('events')}>
          🎲 {L('События', 'Events')}
        </TabButton>
      </div>

      {tab === 'notes' ? <NotesTab L={L} /> : <EventsTab L={L} />}
    </Modal>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition-colors ${
        active ? 'bg-[var(--pl-accent,#8b5cf6)] text-white' : 'text-gray-300 hover:bg-white/5'
      }`}
    >
      {children}
    </button>
  );
}

// ---- Вкладка 1: авторские заметки (без изменений функционала) ----
function NotesTab({ L }: { L: (ru: string, en: string) => string }) {
  const notes = usePlayerStore((s) => s.state?.authorNotes ?? []);
  const setNotes = usePlayerStore((s) => s.setAuthorNotes);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);

  const isEditing = (id: string) => id in drafts;
  const startEdit = (n: AuthorNote) => setDrafts((d) => ({ ...d, [n.id]: n.text }));
  const cancelEdit = (id: string) =>
    setDrafts((d) => {
      const { [id]: _, ...rest } = d;
      return rest;
    });
  const confirm = (id: string) => {
    const text = drafts[id] ?? '';
    setNotes(notes.map((n) => (n.id === id ? { ...n, text } : n)));
    cancelEdit(id);
  };
  const remove = (id: string) => {
    setNotes(notes.filter((n) => n.id !== id));
    cancelEdit(id);
  };
  const create = () => {
    const n: AuthorNote = { id: uid('note'), text: '' };
    setNotes([...notes, n]);
    setDrafts((d) => ({ ...d, [n.id]: '' }));
  };
  const copy = (n: AuthorNote) => {
    navigator.clipboard?.writeText(n.text).catch(() => {});
    setCopied(n.id);
    setTimeout(() => setCopied((c) => (c === n.id ? null : c)), 1200);
  };

  return (
    <>
      <p className="text-xs text-gray-500 mb-3">
        {L(
          'Инструкции/направление сюжета для ИИ — каждая запись инжектится перед вашим ходом, пока не удалите. Подтверждённую запись нельзя случайно изменить: жмите «Редактировать».',
          "Directions for the AI — each note is injected before your move until removed. A confirmed note is locked from accidental edits: press Edit to change it."
        )}
      </p>

      <div className="space-y-2 max-h-[50vh] overflow-y-auto scrollbar-thin pr-1">
        {notes.length === 0 && (
          <p className="text-sm text-gray-600">{L('Пока нет заметок.', 'No notes yet.')}</p>
        )}
        {notes.map((n, i) => {
          const editing = isEditing(n.id);
          return (
            <div key={n.id} className="rounded-lg border border-white/10 bg-panel2 p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-gray-500">
                  {L('Запись', 'Note')} #{i + 1}
                  {!editing && !n.text.trim() && (
                    <span className="text-gray-600"> · {L('пусто', 'empty')}</span>
                  )}
                </span>
                <div className="flex gap-1.5">
                  {editing ? (
                    <button className="btn-primary !px-2.5 !py-1 text-xs" onClick={() => confirm(n.id)}>
                      ✓ {L('Подтвердить', 'Confirm')}
                    </button>
                  ) : (
                    <>
                      <button className="btn-ghost !px-2.5 !py-1 text-xs" onClick={() => startEdit(n)}>
                        ✎ {L('Редактировать', 'Edit')}
                      </button>
                      <button className="btn-ghost !px-2.5 !py-1 text-xs" onClick={() => copy(n)}>
                        {copied === n.id ? '✓' : '📋'} {L('Копировать', 'Copy')}
                      </button>
                    </>
                  )}
                  <button className="btn-danger !px-2 !py-1 text-xs" onClick={() => remove(n.id)} title={L('Удалить', 'Delete')}>
                    🗑
                  </button>
                </div>
              </div>
              {editing ? (
                <textarea
                  className="input h-24 text-sm"
                  autoFocus
                  placeholder={L('Инструкция для ИИ…', 'Instruction for the AI…')}
                  value={drafts[n.id]}
                  onChange={(e) => setDrafts((d) => ({ ...d, [n.id]: e.target.value }))}
                />
              ) : (
                <div className="text-sm whitespace-pre-wrap text-gray-200 min-h-[1.5rem]">
                  {n.text.trim() || <span className="text-gray-600">— {L('пустая запись', 'empty note')} —</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <button className="btn-ghost !py-2 text-sm mt-3 w-full" onClick={create}>
        + {L('Создать запись', 'New note')}
      </button>
    </>
  );
}

// ---- Вкладка 2: случайные события (настройки в игре, применяются со следующего хода) ----
function EventsTab({ L }: { L: (ru: string, en: string) => string }) {
  const lang = useLang((s) => s.lang);
  const project = usePlayerStore((s) => s.project);
  const patchProject = usePlayerStore((s) => s.patchProject);
  const since = usePlayerStore((s) => s.state?.turnsSinceLastEvent);
  if (!project) return null;

  const re = project.randomEvents ?? defaultRandomEvents();
  const phoneOn = !!project.phone?.enabled;
  const patchRE = (patch: Partial<typeof re>) =>
    patchProject((p) => {
      p.randomEvents = { ...(p.randomEvents ?? defaultRandomEvents()), ...patch };
    });
  const patchType = (id: string, patch: { enabled?: boolean; weight?: number }) =>
    patchProject((p) => {
      const cur = p.randomEvents ?? defaultRandomEvents();
      p.randomEvents = { ...cur, types: cur.types.map((t) => (t.id === id ? { ...t, ...patch } : t)) };
    });

  // incoming_sms показываем только при включённом телефоне (patch §3).
  const shownTypes = re.types.filter((t) => t.id !== 'incoming_sms' || phoneOn);

  return (
    <div className="space-y-4 max-h-[56vh] overflow-y-auto scrollbar-thin pr-1">
      <p className="text-xs text-gray-500">
        {L(
          'Движок с заданной вероятностью подмешивает в ход сюжетное событие скрытой директивой (игрок её не видит). Изменения применяются со следующего хода.',
          'The engine can weave a hidden story event into a turn (you never see the directive). Changes apply from the next turn.'
        )}
      </p>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={re.enabled} onChange={(e) => patchRE({ enabled: e.target.checked })} />
        {L('Включить случайные события', 'Enable random events')}
      </label>

      {/* Индикатор: сколько ходов прошло с последнего события */}
      {re.enabled && (
        <div className="text-xs rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-gray-300">
          {L('Ходов с последнего события:', 'Turns since last event:')}{' '}
          <span className="text-white font-medium">
            {typeof since === 'number' && since < 900 ? since : L('давно / не было', 'long ago / none')}
          </span>
          {typeof since === 'number' && since < re.cooldownTurns && (
            <span className="text-gray-500"> · {L('идёт кулдаун', 'cooldown active')}</span>
          )}
        </div>
      )}

      <div className={`space-y-4 ${re.enabled ? '' : 'opacity-50 pointer-events-none'}`}>
        <div className="grid sm:grid-cols-2 gap-3">
          <div>
            <div className="text-sm mb-1">{L('Шанс на ход', 'Chance per turn')}: {re.chancePercent}%</div>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={re.chancePercent}
              onChange={(e) => patchRE({ chancePercent: Number(e.target.value) })}
              className="w-full accent-accent2"
            />
          </div>
          <div>
            <div className="text-sm mb-1">{L('Кулдаун (мин. ходов)', 'Cooldown (min turns)')}</div>
            <input
              type="number"
              min={0}
              max={100}
              className="input w-28"
              value={re.cooldownTurns}
              onChange={(e) => patchRE({ cooldownTurns: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })}
            />
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={re.canInterruptTenseScenes}
            onChange={(e) => patchRE({ canInterruptTenseScenes: e.target.checked })}
          />
          {L('Может прерывать напряжённые/интимные сцены', 'May interrupt tense/intimate scenes')}
        </label>

        <div>
          <div className="text-xs uppercase tracking-wide text-gray-500 mb-2">
            {L('Типы событий и веса', 'Event types & weights')}
          </div>
          <div className="space-y-2">
            {shownTypes.map((t) => (
              <div key={t.id} className="card flex items-center gap-3 !p-2.5">
                <input type="checkbox" checked={t.enabled} onChange={(e) => patchType(t.id, { enabled: e.target.checked })} />
                <div className="flex-1 text-sm">{RANDOM_EVENT_LABELS[t.id][lang === 'en' ? 'en' : 'ru']}</div>
                <span className="text-xs text-gray-500">{L('вес', 'weight')}</span>
                <input
                  type="number"
                  min={0}
                  max={20}
                  step={1}
                  className="input w-16 !py-1"
                  value={t.weight}
                  disabled={!t.enabled}
                  onChange={(e) => patchType(t.id, { weight: Math.max(0, Math.min(20, Number(e.target.value) || 0)) })}
                />
              </div>
            ))}
          </div>
          <p className="text-[11px] text-gray-500 mt-2">
            {L(
              '«Раскрытие секрета» тянет нить из уже заложенных сюжетных крючков, а не выдумывает новую. Отключённые типы не выпадают; больший вес — чаще.',
              '"Secret revealed" pulls a thread from existing plot hooks rather than inventing one. Disabled types never fire; higher weight — more often.'
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
