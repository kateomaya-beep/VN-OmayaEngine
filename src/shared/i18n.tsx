import { create } from 'zustand';

// Lightweight custom i18n (see доработка §6). Zero deps: a language store persisted
// to localStorage + a t() lookup over a flat dotted dictionary. Emotion/mood KEYS
// are never translated — only their display labels (via *_LABELS in types.ts).

export type Lang = 'ru' | 'en';

const LS_KEY = 'nf_ui_lang';

function detectInitial(): Lang {
  const saved = localStorage.getItem(LS_KEY);
  if (saved === 'ru' || saved === 'en') return saved;
  return navigator.language?.toLowerCase().startsWith('en') ? 'en' : 'ru';
}

interface LangStore {
  lang: Lang;
  setLang: (l: Lang) => void;
}

export const useLang = create<LangStore>((set) => ({
  lang: detectInitial(),
  setLang: (l) => {
    localStorage.setItem(LS_KEY, l);
    set({ lang: l });
  },
}));

type Dict = Record<string, string>;

const RU: Dict = {
  'app.tagline': 'локальное приложение · данные в вашем браузере',
  'nav.library': 'Библиотека',

  'library.title': 'Библиотека проектов',
  'library.subtitle': 'Ваши визуальные новеллы. Всё хранится локально.',
  'library.import': 'Импорт .zip',
  'library.new': '+ Новый проект',
  'library.empty': 'Пока нет проектов. Создайте новый или импортируйте .zip.',
  'library.play': '▶ Играть',
  'library.editor': 'Редактор',
  'library.export': 'Экспорт',
  'library.delete': 'Удалить',
  'library.newTitle': 'Новый проект',
  'library.namePlaceholder': 'Название проекта',
  'library.cancel': 'Отмена',
  'library.create': 'Создать',
  'library.charactersShort': 'перс.',
  'library.assetsShort': 'ассетов',

  'constructor.back': '← Библиотека',
  'constructor.saving': 'сохранение…',
  'constructor.saved': 'сохранено',
  'constructor.play': '▶ Играть',
  'constructor.validator': 'Валидатор проекта',
  'tab.settings': 'Настройки',
  'tab.lore': 'Лор',
  'tab.characters': 'Персонажи',
  'tab.stats': 'Статы',
  'tab.assets': 'Ассеты',
  'tab.lorebook': 'Лорбук',
  'tab.ai': 'ИИ / Промпт',
  'tab.memory': 'Память',
  'constructor.loading': 'Загрузка проекта…',

  'player.resumeTitle': 'Продолжить игру?',
  'player.resumeFound': 'Найден автосейв этого проекта.',
  'player.resume': 'Продолжить',
  'player.restart': 'Начать заново',
  'player.toLibrary': '← в библиотеку',
  'player.loading': 'Загрузка…',
  'player.thinking': 'ИИ пишет сцену…',
  'player.nameTitle': 'Как зовут вашего героя?',
  'player.namePlaceholder': 'Имя героя',
  'player.start': 'Начать',
  'player.history': 'История',
  'player.memory': 'Память',
  'player.saves': 'Сейвы',
  'player.mixer': 'Звук',
  'player.relationships': 'Отношения',
  'player.regen': 'Перегенерировать ход',
  'player.close': 'Закрыть',
  'player.retry': 'Повторить',
  'player.chapterDone': 'Глава завершена',
  'player.clickContinue': 'нажмите, чтобы продолжить',
  'player.freeInput': '…или ответить своими словами',

  'mixer.title': 'Громкость',
  'mixer.master': 'Общая',
  'mixer.music': 'Музыка',
  'mixer.sfx': 'Звуки',

  'lang.label': 'Язык',
};

const EN: Dict = {
  'app.tagline': 'local app · data stays in your browser',
  'nav.library': 'Library',

  'library.title': 'Project library',
  'library.subtitle': 'Your visual novels. Everything is stored locally.',
  'library.import': 'Import .zip',
  'library.new': '+ New project',
  'library.empty': 'No projects yet. Create one or import a .zip.',
  'library.play': '▶ Play',
  'library.editor': 'Editor',
  'library.export': 'Export',
  'library.delete': 'Delete',
  'library.newTitle': 'New project',
  'library.namePlaceholder': 'Project title',
  'library.cancel': 'Cancel',
  'library.create': 'Create',
  'library.charactersShort': 'chars',
  'library.assetsShort': 'assets',

  'constructor.back': '← Library',
  'constructor.saving': 'saving…',
  'constructor.saved': 'saved',
  'constructor.play': '▶ Play',
  'constructor.validator': 'Project validator',
  'tab.settings': 'Settings',
  'tab.lore': 'Lore',
  'tab.characters': 'Characters',
  'tab.stats': 'Stats',
  'tab.assets': 'Assets',
  'tab.lorebook': 'Lorebook',
  'tab.ai': 'AI / Prompt',
  'tab.memory': 'Memory',
  'constructor.loading': 'Loading project…',

  'player.resumeTitle': 'Resume game?',
  'player.resumeFound': 'An autosave was found for this project.',
  'player.resume': 'Resume',
  'player.restart': 'Start over',
  'player.toLibrary': '← to library',
  'player.loading': 'Loading…',
  'player.thinking': 'AI is writing the scene…',
  'player.nameTitle': 'What is your hero’s name?',
  'player.namePlaceholder': 'Hero name',
  'player.start': 'Start',
  'player.history': 'History',
  'player.memory': 'Memory',
  'player.saves': 'Saves',
  'player.mixer': 'Sound',
  'player.relationships': 'Relationships',
  'player.regen': 'Regenerate turn',
  'player.close': 'Close',
  'player.retry': 'Retry',
  'player.chapterDone': 'Chapter complete',
  'player.clickContinue': 'click to continue',
  'player.freeInput': '…or answer in your own words',

  'mixer.title': 'Volume',
  'mixer.master': 'Master',
  'mixer.music': 'Music',
  'mixer.sfx': 'SFX',

  'lang.label': 'Language',
};

const DICTS: Record<Lang, Dict> = { ru: RU, en: EN };

export function translate(lang: Lang, key: string): string {
  return DICTS[lang][key] ?? DICTS.ru[key] ?? key;
}

// Hook: returns a t() bound to the current language (re-renders on language change).
export function useT(): (key: string) => string {
  const lang = useLang((s) => s.lang);
  return (key: string) => translate(lang, key);
}
