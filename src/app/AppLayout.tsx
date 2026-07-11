import { useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { useLang, useT } from '../shared/i18n';
import { useTheme } from '../shared/theme';
import { useProjectStore } from '../modules/constructor/projectStore';
import { ApiPanel } from '../modules/shared/ApiPanel';
import { Modal } from '../shared/ui';

// Верхняя панель (см. CR v2 §H.1): Библиотека · Тема · API · (язык — часть настроек).
export function AppLayout() {
  const loc = useLocation();
  const inProject = loc.pathname.startsWith('/project/');
  const t = useT();
  const { theme, toggleTheme } = useTheme();
  const { project, update } = useProjectStore();
  const [apiOpen, setApiOpen] = useState(false);

  return (
    <div className="min-h-full flex flex-col">
      <header className="border-b border-white/10 bg-panel/60 backdrop-blur sticky top-0 z-20">
        <div className="max-w-6xl mx-auto px-4 h-14 flex items-center gap-4">
          <Link to="/library" className="font-bold text-lg tracking-tight">
            <span className="text-accent">Novel</span>
            <span className="text-accent2">Forge</span>
            <span className="ml-1.5 text-[10px] font-normal text-gray-500 align-top">
              v{__APP_VERSION__}
            </span>
          </Link>
          <nav className="flex items-center gap-1 text-sm">
            <Link
              to="/library"
              className={`px-3 py-1.5 rounded-lg ${
                !inProject ? 'bg-white/10' : 'hover:bg-white/5'
              }`}
            >
              {t('nav.library')}
            </Link>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <button
              className="bg-panel2 hover:bg-white/10 rounded-lg px-2.5 py-1.5 text-sm"
              title="Тема"
              onClick={toggleTheme}
            >
              {theme === 'dark' ? '🌙' : '☀️'}
            </button>
            <button
              className="bg-panel2 hover:bg-white/10 rounded-lg px-2.5 py-1.5 text-sm"
              title="API-подключения"
              onClick={() => setApiOpen(true)}
            >
              🔌
            </button>
            <LangSwitch />
            <div className="text-xs text-gray-500 hidden sm:block">{t('app.tagline')}</div>
          </div>
        </div>
      </header>
      <main className="flex-1">
        <Outlet />
      </main>

      {apiOpen && project ? (
        <ApiPanel open onClose={() => setApiOpen(false)} project={project} onPatch={update} />
      ) : (
        <Modal open={apiOpen} onClose={() => setApiOpen(false)} title="API-подключения">
          <p className="text-sm text-gray-400">
            Откройте проект в конструкторе, чтобы настроить его API-подключения — они
            хранятся отдельно на каждый проект.
          </p>
        </Modal>
      )}
    </div>
  );
}

export function LangSwitch() {
  const { lang, setLang } = useLang();
  return (
    <div className="inline-flex rounded-lg overflow-hidden border border-white/10 text-xs">
      {(['ru', 'en'] as const).map((l) => (
        <button
          key={l}
          onClick={() => setLang(l)}
          className={`px-2 py-1 uppercase ${lang === l ? 'bg-accent2 text-white' : 'bg-panel2 hover:bg-white/10'}`}
        >
          {l}
        </button>
      ))}
    </div>
  );
}
