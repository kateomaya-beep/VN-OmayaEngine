import { useState } from 'react';
import { Modal } from '../../../shared/ui';
import { useLang } from '../../../shared/i18n';
import { uid } from '../../../shared/utils';
import { usePlayerStore } from '../playerStore';
import type { AuthorNote } from '../../../shared/types';

// Менеджер авторских заметок для ИИ. Записи создаются/правятся/удаляются/копируются.
// Настройки случайных событий переехали в панель «Расширения» → «События».
export function AuthorNotesPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const lang = useLang((s) => s.lang);
  const L = (ru: string, en: string) => (lang === 'en' ? en : ru);
  const notes = usePlayerStore((s) => s.state?.authorNotes ?? []);
  const setNotes = usePlayerStore((s) => s.setAuthorNotes);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);
  if (!open) return null;

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
    <Modal open={open} onClose={onClose} title={L('Авторские заметки для ИИ', "AI author's notes")}>
      <p className="text-xs text-gray-500 mb-3">
        {L(
          'Инструкции/направление сюжета для ИИ — каждая запись инжектится перед вашим ходом, пока не удалите. Подтверждённую запись нельзя случайно изменить: жмите «Редактировать».',
          "Directions for the AI — each note is injected before your move until removed. A confirmed note is locked from accidental edits: press Edit to change it."
        )}
      </p>

      <div className="space-y-2 max-h-[55vh] overflow-y-auto scrollbar-thin pr-1">
        {notes.length === 0 && <p className="text-sm text-gray-600">{L('Пока нет заметок.', 'No notes yet.')}</p>}
        {notes.map((n, i) => {
          const editing = isEditing(n.id);
          return (
            <div key={n.id} className="rounded-lg border border-white/10 bg-panel2 p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-gray-500">
                  {L('Запись', 'Note')} #{i + 1}
                  {!editing && !n.text.trim() && <span className="text-gray-600"> · {L('пусто', 'empty')}</span>}
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
    </Modal>
  );
}
