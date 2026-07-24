import { create } from 'zustand';
import { uid } from '../shared/utils';
import { getApiKey, setApiKey } from './keys';
import { getConnection, useConnection } from './connection';
import type { ApiConnection } from '../shared/types';

// Именованные пресеты подключения к ИИ — чтобы держать несколько провайдеров и
// быстро переключаться. У каждого пресета СВОЙ ключ (иначе провайдеры одного типа
// делили бы один ключ). Всё в localStorage; ключи — под ролью `cpreset:<id>`.

export interface ConnectionPreset {
  id: string;
  name: string;
  provider: ApiConnection['provider'];
  baseUrl: string;
  model: string;
  availableModels?: string[];
}

const LS_KEY = 'nf_conn_presets';
const keyRole = (id: string) => `cpreset:${id}`;

function load(): ConnectionPreset[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((p) => p && typeof p.name === 'string' && typeof p.baseUrl === 'string')
      .map((p) => ({
        id: typeof p.id === 'string' ? p.id : uid('cp'),
        name: p.name,
        provider: p.provider === 'anthropic' ? 'anthropic' : 'openai-compatible',
        baseUrl: p.baseUrl,
        model: typeof p.model === 'string' ? p.model : '',
        availableModels: Array.isArray(p.availableModels) ? p.availableModels : undefined,
      }));
  } catch {
    return [];
  }
}

function persist(list: ConnectionPreset[]) {
  localStorage.setItem(LS_KEY, JSON.stringify(list));
}

interface PresetStore {
  presets: ConnectionPreset[];
  activeId: string | null; // последний применённый (для подсветки)
  saveCurrent: (name: string) => void;
  apply: (id: string) => void;
  remove: (id: string) => void;
}

export const useConnectionPresets = create<PresetStore>((set, get) => ({
  presets: load(),
  activeId: null,
  // Снимок ТЕКУЩЕГО подключения (+ его активного ключа) в именованный пресет.
  // Совпадение по имени — перезапись.
  saveCurrent: (name) => {
    const clean = name.trim();
    if (!clean) return;
    const conn = getConnection();
    const existing = get().presets.find((p) => p.name.toLowerCase() === clean.toLowerCase());
    const id = existing?.id || uid('cp');
    const preset: ConnectionPreset = {
      id,
      name: clean,
      provider: conn.provider,
      baseUrl: conn.baseUrl,
      model: conn.model || '',
      availableModels: conn.availableModels,
    };
    setApiKey(keyRole(id), getApiKey(conn.provider)); // ключ пресета = текущий активный ключ провайдера
    const next = existing
      ? get().presets.map((p) => (p.id === id ? preset : p))
      : [...get().presets, preset];
    persist(next);
    set({ presets: next, activeId: id });
  },
  // Применить пресет: подставить его в активное подключение + перенести его ключ в
  // активную роль провайдера (её читает генерация).
  apply: (id) => {
    const p = get().presets.find((x) => x.id === id);
    if (!p) return;
    useConnection.getState().setConnection({
      provider: p.provider,
      baseUrl: p.baseUrl,
      model: p.model,
      availableModels: p.availableModels,
    });
    setApiKey(p.provider, getApiKey(keyRole(p.id)));
    set({ activeId: id });
  },
  remove: (id) => {
    setApiKey(keyRole(id), ''); // чистим ключ пресета
    const next = get().presets.filter((p) => p.id !== id);
    persist(next);
    set({ presets: next, activeId: get().activeId === id ? null : get().activeId });
  },
}));
