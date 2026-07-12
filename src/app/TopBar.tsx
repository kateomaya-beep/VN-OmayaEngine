import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useLang } from '../shared/i18n';
import { useTheme } from '../shared/theme';
import { ConnectionPanel } from '../modules/shared/ConnectionPanel';
import { ExtensionsPanel } from '../modules/shared/ExtensionsPanel';
import { PresetPanel } from '../modules/shared/PresetPanel';
import { GameMasterPanel } from '../modules/shared/GameMasterPanel';
import { ToastHost } from '../shared/ToastHost';
import type { Project } from '../shared/types';

// Единая постоянная верхняя панель (Batch 3 §1): одинаковая на главном экране и в
// игре. Содержит: бренд/Библиотека · [слот проекта/игры] · Подключение (глобальное) ·
// Управление расширениями · Тема · Язык UI. Расширения/подключение — единый источник.
export function TopBar({
  variant = 'app',
  project,
  onPatchProject,
  left,
  menuSlot,
  right,
}: {
  variant?: 'app' | 'player';
  project?: Project | null;
  onPatchProject?: (mutator: (p: Project) => void) => void;
  left?: ReactNode; // доп. слева (напр. заголовок проекта)
  menuSlot?: ReactNode; // игровое бургер-меню (в плеере)
  right?: ReactNode; // доп. справа (напр. кнопка «Играть»)
}) {
  const container =
    variant === 'player'
      ? 'absolute inset-x-0 top-0 z-30 bg-black/50 backdrop-blur border-b border-white/10'
      : 'border-b border-white/10 bg-panel/60 backdrop-blur sticky top-0 z-20';

  return (
    <header className={container}>
      <div className="max-w-6xl mx-auto px-4 h-14 flex items-center gap-3">
        <Link to="/library" className="font-bold text-lg tracking-tight shrink-0">
          <span className="text-accent">Novel</span>
          <span className="text-accent2">Forge</span>
          {variant === 'app' && (
            <span className="ml-1.5 text-[10px] font-normal text-gray-500 align-top">
              v{__APP_VERSION__}
            </span>
          )}
        </Link>
        {left}
        <div className="ml-auto flex items-center gap-2">
          {menuSlot}
          <TopBarControls project={project} onPatchProject={onPatchProject} />
          {right}
        </div>
      </div>
    </header>
  );
}

// Общий кластер контролов — идентичен везде (Batch 3 §1).
export function TopBarControls({
  project,
  onPatchProject,
}: {
  project?: Project | null;
  onPatchProject?: (mutator: (p: Project) => void) => void;
}) {
  const { theme, toggleTheme } = useTheme();
  const { lang, setLang } = useLang();
  const [connOpen, setConnOpen] = useState(false);
  const [extOpen, setExtOpen] = useState(false);
  const [presetOpen, setPresetOpen] = useState(false);
  const [gmOpen, setGmOpen] = useState(false);

  const btn = 'bg-black/40 hover:bg-black/60 dark:bg-panel2 rounded-lg px-2.5 py-1.5 text-sm';

  return (
    <>
      <button className={btn} title="Подключение к ИИ" onClick={() => setConnOpen(true)}>
        🔌
      </button>
      <button className={btn} title="Пресет промпта" onClick={() => setPresetOpen(true)}>
        🎚
      </button>
      <button className={btn} title="Game Master" onClick={() => setGmOpen(true)}>
        🎮
      </button>
      <button className={btn} title="Управление расширениями" onClick={() => setExtOpen(true)}>
        🧩
      </button>
      <button className={btn} title="Тема" onClick={toggleTheme}>
        {theme === 'dark' ? '🌙' : '☀️'}
      </button>
      <div className="inline-flex rounded-lg overflow-hidden border border-white/10 text-xs">
        {(['ru', 'en'] as const).map((l) => (
          <button
            key={l}
            onClick={() => setLang(l)}
            className={`px-2 py-1 uppercase ${
              lang === l ? 'bg-accent2 text-white' : 'bg-black/40 dark:bg-panel2 hover:bg-white/10'
            }`}
          >
            {l}
          </button>
        ))}
      </div>

      <ConnectionPanel open={connOpen} onClose={() => setConnOpen(false)} />
      <PresetPanel
        open={presetOpen}
        onClose={() => setPresetOpen(false)}
        project={project}
        onPatch={onPatchProject}
      />
      <GameMasterPanel
        open={gmOpen}
        onClose={() => setGmOpen(false)}
        project={project}
        onPatch={onPatchProject}
      />
      <ExtensionsPanel
        open={extOpen}
        onClose={() => setExtOpen(false)}
        project={project}
        onPatch={onPatchProject}
      />
      <ToastHost />
    </>
  );
}
