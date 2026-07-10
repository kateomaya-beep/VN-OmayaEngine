import { create } from 'zustand';
import type { Project } from '../../shared/types';
import { getProject, saveProject } from '../../storage/db';

interface ProjectStore {
  project: Project | null;
  dirty: boolean;
  loading: boolean;
  load: (id: string) => Promise<void>;
  update: (mutator: (p: Project) => void) => void;
  set: (project: Project) => void;
  persist: () => Promise<void>;
  clear: () => void;
}

// Simple structural clone that keeps things immutable-friendly for React re-render.
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

export const useProjectStore = create<ProjectStore>((set, get) => ({
  project: null,
  dirty: false,
  loading: false,
  async load(id) {
    set({ loading: true });
    const p = await getProject(id);
    set({ project: p ? clone(p) : null, dirty: false, loading: false });
  },
  update(mutator) {
    const p = get().project;
    if (!p) return;
    const next = clone(p);
    mutator(next);
    set({ project: next, dirty: true });
  },
  set(project) {
    set({ project: clone(project), dirty: true });
  },
  async persist() {
    const p = get().project;
    if (!p) return;
    await saveProject(p);
    set({ dirty: false });
  },
  clear() {
    set({ project: null, dirty: false });
  },
}));
