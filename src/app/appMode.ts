import { create } from 'zustand';
import type { NarrativeMode } from '../shared/types';

// РЕЖИМ ПРИЛОЖЕНИЯ — не настройка проекта, а развилка на входе: два разных
// приложения на одном движке.
//
// Так решено намеренно, после попытки сделать иначе. Сначала режим был флажком
// внутри проекта, а конструктор и панель пресета подстраивались под него. Получилась
// путаница: панель пресета показывала вкладку одного режима, проект был в другом,
// а половина настроек на экране относилась к тому, чего в этом проекте не бывает.
// Теперь режим выбирается один раз при входе и держит ВСЁ: какую библиотеку видно,
// какой конструктор открывается, какой пресет уходит в запрос и как выглядит игра.
//
// Проект принадлежит одному режиму. Перенести сеттинг в другой можно — но явным
// действием «адаптировать», которое делает КОПИЮ, а не молчаливым переключением
// флажка: у копии свои сейвы, свои истории и своя судьба.

const LS_KEY = 'nf_app_mode';

function load(): NarrativeMode | null {
  try {
    const v = localStorage.getItem(LS_KEY);
    return v === 'rp' || v === 'vn' ? v : null;
  } catch {
    return null;
  }
}

let current = load();

// Не-хук доступ: сборка промпта и движок спрашивают режим вне React.
export function getAppMode(): NarrativeMode | null {
  return current;
}

interface AppModeStore {
  /** null — режим ещё не выбран, показываем экран развилки. */
  mode: NarrativeMode | null;
  setMode: (m: NarrativeMode) => void;
  clearMode: () => void;
}

export const useAppMode = create<AppModeStore>((set) => ({
  mode: current,
  setMode: (m) => {
    current = m;
    try {
      localStorage.setItem(LS_KEY, m);
    } catch {
      /* приватный режим — переживём, выбор просто не запомнится */
    }
    set({ mode: m });
  },
  clearMode: () => {
    current = null;
    try {
      localStorage.removeItem(LS_KEY);
    } catch {
      /* см. выше */
    }
    set({ mode: null });
  },
}));

export const MODE_META: Record<NarrativeMode, { icon: string; name: string; nameEn: string }> = {
  vn: { icon: '🎭', name: 'Визуальная новелла', nameEn: 'Visual novel' },
  rp: { icon: '💬', name: 'Классический РП', nameEn: 'Classic RP' },
};
