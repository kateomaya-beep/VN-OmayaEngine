import { create } from 'zustand';
import type { AuthorNote } from './types';
import { uid } from './utils';

// УНИВЕРСАЛЬНЫЕ авторские заметки — общие для ВСЕХ проектов и прохождений.
// Живут в localStorage (как пресет и подключение), а не в сейве: их смысл в том,
// чтобы личные правила подачи («не пиши за меня», «больше диалогов») действовали
// в любой истории и не переносились руками из проекта в проект.
// Проектные заметки остаются в RuntimeState.authorNotes.

const LS_KEY = 'nf_global_notes';

function load(): AuthorNote[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v
      .filter((n: any) => n && typeof n.text === 'string')
      .map((n: any) => ({ id: typeof n.id === 'string' ? n.id : uid('gnote'), text: n.text }));
  } catch {
    return [];
  }
}

function persist(notes: AuthorNote[]): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(notes));
  } catch {
    /* приватный режим / переполнение — не критично */
  }
}

interface GlobalNotesStore {
  notes: AuthorNote[];
  setNotes: (notes: AuthorNote[]) => void;
}

export const useGlobalNotes = create<GlobalNotesStore>((set) => ({
  notes: load(),
  setNotes(notes) {
    persist(notes);
    set({ notes });
  },
}));

// Чтение вне React (сборка промпта).
export function getGlobalNotes(): AuthorNote[] {
  return useGlobalNotes.getState().notes;
}
