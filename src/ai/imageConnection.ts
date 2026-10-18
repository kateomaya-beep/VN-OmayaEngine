import { create } from 'zustand';
import type { ImageGenConfig, Project } from '../shared/types';
import { defaultImageGenConfig } from '../shared/types';

// ПОДКЛЮЧЕНИЕ К IMAGE-API — ОБЩЕЕ, как у основного API. Раньше провайдер, адрес и
// модель жили в проекте, и в каждой новой истории всё приходилось настраивать
// заново. Теперь подключение одно на все истории (ключ и так был общим), а в
// проекте остаётся то, что относится к самой истории: стиль, референсы, галерея,
// промпт воркера, кадр.
//
// Переезд мягкий: пока общего подключения нет, первое же настроенное в проекте
// становится общим (см. imageGenFor).

export interface ImageModelInfo {
  /** Человеческое название, если провайдер его отдаёт (OpenRouter: name, Google: displayName). */
  name?: string;
  /** Модель рисует картинки (по данным провайдера или по имени). */
  image?: boolean;
}

export interface ImageConnection {
  providerKind: ImageGenConfig['providerKind'];
  baseUrl?: string;
  model?: string;
  availableModels?: string[];
  modelInfo?: Record<string, ImageModelInfo>;
}

const LS_KEY = 'nf_image_conn';

function load(): ImageConnection | null {
  try {
    const v = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    if (!v || typeof v !== 'object') return null;
    return {
      providerKind: v.providerKind === 'openai' || v.providerKind === 'openai_chat' ? v.providerKind : 'gemini',
      baseUrl: typeof v.baseUrl === 'string' && v.baseUrl.trim() ? v.baseUrl.trim() : undefined,
      model: typeof v.model === 'string' && v.model.trim() ? v.model.trim() : undefined,
      availableModels: Array.isArray(v.availableModels) ? v.availableModels.filter((x: unknown) => typeof x === 'string') : undefined,
      modelInfo: v.modelInfo && typeof v.modelInfo === 'object' ? v.modelInfo : undefined,
    };
  } catch {
    return null;
  }
}

function save(c: ImageConnection | null): void {
  try {
    if (c) localStorage.setItem(LS_KEY, JSON.stringify(c));
    else localStorage.removeItem(LS_KEY);
  } catch {
    /* хранилище недоступно — работаем до перезагрузки */
  }
}

interface Store {
  conn: ImageConnection | null;
  patch: (p: Partial<ImageConnection>) => void;
}

export const useImageConnection = create<Store>((set, get) => ({
  conn: load(),
  patch: (p) => {
    const next: ImageConnection = { providerKind: 'gemini', ...(get().conn ?? {}), ...p };
    save(next);
    set({ conn: next });
  },
}));

export function getImageConnection(): ImageConnection | null {
  return useImageConnection.getState().conn;
}

/** Подключение из настроек картинок проекта (для переезда старых проектов). */
function fromProject(ig: ImageGenConfig): ImageConnection | null {
  if (!ig.model && !ig.baseUrl && !ig.availableModels?.length && ig.providerKind === 'gemini') return null;
  return { providerKind: ig.providerKind, baseUrl: ig.baseUrl, model: ig.model, availableModels: ig.availableModels };
}

/** Показываемое подключение: общее, а пока его нет — то, что настроено в проекте. */
export function effectiveConnection(project?: Project | null): ImageConnection {
  return getImageConnection() ?? (project?.imageGen ? fromProject(project.imageGen) : null) ?? { providerKind: 'gemini' };
}

/**
 * Настройки картинок для генерации: проектные (стиль, рефы, кадр) + общее
 * подключение поверх. Общего ещё нет, а в проекте подключение настроено —
 * оно и становится общим: дальше его подхватят все истории.
 */
export function imageGenFor(project: Project | null | undefined): ImageGenConfig {
  const ig = project?.imageGen ?? defaultImageGenConfig();
  let c = getImageConnection();
  if (!c) {
    c = fromProject(ig);
    if (c) useImageConnection.getState().patch(c);
  }
  if (!c) return ig;
  return { ...ig, providerKind: c.providerKind, baseUrl: c.baseUrl, model: c.model, availableModels: c.availableModels };
}
