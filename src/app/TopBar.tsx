import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useLang } from '../shared/i18n';
import { ConnectionPanel } from '../modules/shared/ConnectionPanel';
import { ExtensionsPanel } from '../modules/shared/ExtensionsPanel';
import { PresetPanel } from '../modules/shared/PresetPanel';
import { GameMasterPanel } from '../modules/shared/GameMasterPanel';
import { LogsPanel } from '../modules/shared/LogsPanel';
import { ToastHost } from '../shared/ToastHost';
import { useLogs } from '../shared/logStore';
import { useAppMode, MODE_META } from './appMode';
import type { NarrativeMode } from '../shared/types';
import type { Project } from '../shared/types';

// Единая постоянная верхняя панель. Неоново-стеклянный дизайн (см. импорт дизайна
// «VN Engine Library»). Вместо текста — иконки с подсказками на выбранном языке.
//
// НА ПАНЕЛИ — только то, что открывают часто: режим, Пресет, API и (в игре)
// Game Master. Всё остальное — в одном меню ☰: сначала пункты игры (их отдаёт
// плеер через menuItems), потом Расширения, Логи и Язык. Раньше меню было два —
// «шестерёнчатый» ряд иконок и отдельный бургер игры, — и на телефоне ряд из семи
// кнопок плюс логотип просто не помещался в ширину экрана: на 360 px он вылезал
// за край, а на аппаратах со скруглёнными углами крайняя кнопка ещё и срезалась.

const ICON_STROKE = '#d6cdf0';

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg width="17" height="17" viewBox="0 0 20 20" fill="none" style={{ display: 'flex' }}>
      {children}
    </svg>
  );
}

const Icons = {
  preset: (
    // Коробка/пакет (пресет).
    <Svg>
      <path
        d="M10 2.6 16.6 6v8L10 17.4 3.4 14V6L10 2.6Z"
        stroke={ICON_STROKE}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M3.6 6.1 10 9.6l6.4-3.5" stroke={ICON_STROKE} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 9.6V17" stroke={ICON_STROKE} strokeWidth="1.4" strokeLinecap="round" />
    </Svg>
  ),
  api: (
    <Svg>
      <rect x="4" y="4" width="12" height="12" rx="3.5" stroke={ICON_STROKE} strokeWidth="1.5" />
      <path d="M8.3 8v2.4M11.7 8v2.4" stroke={ICON_STROKE} strokeWidth="1.5" strokeLinecap="round" />
      <path d="M10 13v2.5" stroke={ICON_STROKE} strokeWidth="1.5" strokeLinecap="round" />
    </Svg>
  ),
  gm: (
    <Svg>
      <rect x="2.8" y="6.5" width="14.4" height="8" rx="4" stroke={ICON_STROKE} strokeWidth="1.5" />
      <path d="M6.2 9.4v2.2M5.1 10.5h2.2" stroke={ICON_STROKE} strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="13" cy="9.8" r="0.95" fill={ICON_STROKE} />
      <circle cx="14.6" cy="11.4" r="0.95" fill={ICON_STROKE} />
    </Svg>
  ),
};

// Пункт выпадающего меню. Живёт здесь, а не в плеере: меню одно на всё
// приложение, и пункты в него кладут с двух сторон.
export function MenuItem({
  icon,
  label,
  onClick,
}: {
  icon: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 px-3 py-2 hover:bg-[rgba(160,110,255,0.16)] text-left"
    >
      <span className="w-5 text-center">{icon}</span>
      <span>{label}</span>
    </button>
  );
}

function IconBtn({
  title,
  onClick,
  children,
  badge,
}: {
  title: string;
  onClick: () => void;
  children: ReactNode;
  badge?: number;
}) {
  return (
    <button
      title={title}
      aria-label={title}
      onClick={onClick}
      className="relative w-[34px] h-[34px] rounded-[10px] flex items-center justify-center transition-colors
        bg-white/[0.04] border border-[rgba(180,150,255,0.22)]
        hover:bg-[rgba(160,110,255,0.16)] hover:border-[rgba(190,150,255,0.55)] hover:shadow-[0_0_12px_rgba(170,120,255,0.35)]"
    >
      {children}
      {badge !== undefined && badge > 0 && (
        <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[10px] leading-4 text-center">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </button>
  );
}

export function TopBar({
  variant = 'app',
  project,
  onPatchProject,
  left,
  menuSlot,
  menuItems,
  right,
}: {
  variant?: 'app' | 'player';
  project?: Project | null;
  onPatchProject?: (mutator: (p: Project) => void) => void;
  left?: ReactNode;
  menuSlot?: ReactNode;
  /** Пункты, которые уходят В НАЧАЛО общего меню ☰ (плеер кладёт сюда игровые). */
  menuItems?: ReactNode;
  right?: ReactNode;
}) {
  const container =
    variant === 'player'
      ? 'absolute inset-x-0 top-0 z-30 bg-[rgba(18,16,28,0.55)] backdrop-blur-xl border-b border-[rgba(180,150,255,0.14)]'
      : 'sticky top-0 z-20 bg-[rgba(18,16,28,0.55)] backdrop-blur-xl border-b border-[rgba(180,150,255,0.14)] shadow-[0_1px_20px_rgba(140,90,255,0.06)]';

  return (
    // inset-t-safe / inset-x-safe — вырез и скруглённые углы телефона: страница
    // рисуется под ними (viewport-fit=cover), и без отступа крайняя кнопка панели
    // уезжает под скругление.
    <header className={`${container} inset-t-safe inset-x-safe`}>
      <div className="max-w-6xl mx-auto px-3 sm:px-5 h-14 flex items-center gap-2 sm:gap-3 min-w-0">
        <Link to="/library" className="flex items-center gap-2.5 shrink-0 group">
          <span className="w-9 h-9 rounded-[11px] flex items-center justify-center shrink-0 bg-[rgba(150,110,255,0.12)] border border-[rgba(180,150,255,0.35)] shadow-[0_0_16px_rgba(160,110,255,0.35),inset_0_0_10px_rgba(180,150,255,0.12)]">
            <svg width="19" height="19" viewBox="0 0 20 20" fill="none">
              <path
                d="M7 4L15 10L7 16V4Z"
                fill="#b18cff"
                style={{ filter: 'drop-shadow(0 0 4px rgba(190,150,255,0.8))' }}
              />
              <circle cx="4" cy="4.5" r="1.6" fill="#d3b8ff" />
              <circle cx="4" cy="15.5" r="1.6" fill="#d3b8ff" />
              <path d="M4 6.1V13.9" stroke="#d3b8ff" strokeWidth="1.1" strokeLinecap="round" />
            </svg>
          </span>
          {/* Словесный логотип прячем на узком экране: на 360 px он занимал почти
              половину ширины, и ряд кнопок уезжал за край — именно из-за него,
              а не из-за числа кнопок. Значок остаётся и остаётся ссылкой домой. */}
          <span className="hidden sm:flex flex-col leading-none">
            <span className="font-brand font-extrabold text-[16px] tracking-[0.2px] text-[#f5f2fc]">
              VN Studio
            </span>
            <span className="text-[9px] font-semibold tracking-[1.6px] text-[#b18cff]">
              NOVEL ENGINE {variant === 'app' && `· v${__APP_VERSION__}`}
            </span>
          </span>
        </Link>
        {left}
        <div className="ml-auto flex items-center gap-1.5 sm:gap-2 shrink-0">
          {menuSlot}
          <TopBarControls
            variant={variant}
            project={project}
            onPatchProject={onPatchProject}
            menuItems={menuItems}
          />
          {right}
        </div>
      </div>
    </header>
  );
}

export function TopBarControls({
  variant = 'app',
  project,
  onPatchProject,
  menuItems,
}: {
  variant?: 'app' | 'player';
  project?: Project | null;
  onPatchProject?: (mutator: (p: Project) => void) => void;
  menuItems?: ReactNode;
}) {
  const { lang, setLang } = useLang();
  const L = (ru: string, en: string) => (lang === 'en' ? en : ru);
  const [connOpen, setConnOpen] = useState(false);
  const [extOpen, setExtOpen] = useState(false);
  const [presetOpen, setPresetOpen] = useState(false);
  const [gmOpen, setGmOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const errorCount = useLogs((s) => s.logs.reduce((n, l) => n + (l.level === 'error' ? 1 : 0), 0));
  const mode = useAppMode((s) => s.mode);
  const setMode = useAppMode((s) => s.setMode);
  const nav = useNavigate();
  const other: NarrativeMode = mode === 'rp' ? 'vn' : 'rp';

  const inPlayer = variant === 'player';

  // Режим приложения — первым в ряду, потому что от него зависит смысл всего
  // остального: какая библиотека, какой конструктор, какой пресет уйдёт в запрос.
  // В плеере не показываем: там режим уже определён открытой историей, и сменить
  // его на ходу означало бы поменять игру под игроком.
  const modeBtn =
    !inPlayer && mode ? (
      <button
        className="h-[34px] px-2.5 rounded-[10px] flex items-center gap-1.5 text-[12px] transition-colors bg-white/[0.04] border border-[rgba(180,150,255,0.22)] text-[#e5deF7] hover:bg-[rgba(160,110,255,0.16)] hover:border-[rgba(190,150,255,0.55)]"
        title={L(
          `Режим: ${MODE_META[mode].name}. Нажмите, чтобы перейти в «${MODE_META[other].name}» — там своя библиотека проектов.`,
          `Mode: ${MODE_META[mode].nameEn}. Click to switch to "${MODE_META[other].nameEn}" — it has its own project library.`
        )}
        onClick={() => {
          setMode(other);
          nav('/library');
        }}
      >
        <span>{MODE_META[mode].icon}</span>
        <span className="hidden sm:inline">{lang === 'en' ? MODE_META[mode].nameEn : MODE_META[mode].name}</span>
        <span className="text-[#7a7690]">⇄</span>
      </button>
    ) : null;

  return (
    <>
      {modeBtn}
      {/* На панели остаются только частые: Пресет · API · [в игре Game Master].
          Редкие (Расширения, Логи, Язык) ушли в меню ☰ — вместе с игровыми
          пунктами, которые кладёт плеер. */}
      <IconBtn title={L('Пресет промпта', 'Prompt preset')} onClick={() => setPresetOpen(true)}>
        {Icons.preset}
      </IconBtn>
      <IconBtn title={L('Подключение к ИИ', 'AI connection')} onClick={() => setConnOpen(true)}>
        {Icons.api}
      </IconBtn>
      {inPlayer && (
        <IconBtn title={L('Game Master', 'Game Master')} onClick={() => setGmOpen(true)}>
          {Icons.gm}
        </IconBtn>
      )}

      {/* ОБЩЕЕ МЕНЮ. Счётчик ошибок переехал сюда с кнопки логов: сами логи внутри,
          но знать, что там ошибка, надо не открывая меню. */}
      <div className="relative">
        <IconBtn
          title={L('Меню', 'Menu')}
          onClick={() => setMenuOpen((v) => !v)}
          badge={errorCount}
        >
          <span className="text-[15px] leading-none text-[#e5deF7]">☰</span>
        </IconBtn>
        {menuOpen && (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setMenuOpen(false)} />
            <div
              className="absolute right-0 mt-1.5 z-40 w-56 max-w-[calc(100vw-1.5rem)] rounded-[14px] py-1.5 text-sm bg-[rgba(16,13,24,0.92)] border border-[rgba(180,150,255,0.2)] shadow-[0_20px_60px_rgba(0,0,0,0.6)] backdrop-blur-xl"
              onClick={() => setMenuOpen(false)}
            >
              {menuItems}
              {menuItems && <div className="my-1 border-t border-white/10" />}
              {inPlayer && (
                <MenuItem
                  icon="🧩"
                  label={L('Расширения', 'Extensions')}
                  onClick={() => setExtOpen(true)}
                />
              )}
              <MenuItem
                icon="📋"
                label={
                  errorCount > 0
                    ? L(`Логи (ошибок: ${errorCount})`, `Logs (${errorCount} errors)`)
                    : L('Логи', 'Logs')
                }
                onClick={() => setLogsOpen(true)}
              />
              <MenuItem
                icon="🌐"
                label={lang === 'ru' ? 'Язык: Русский → English' : 'Language: English → Русский'}
                onClick={() => setLang(lang === 'ru' ? 'en' : 'ru')}
              />
            </div>
          </>
        )}
      </div>

      <ConnectionPanel open={connOpen} onClose={() => setConnOpen(false)} />
      <PresetPanel open={presetOpen} onClose={() => setPresetOpen(false)} />
      {inPlayer && (
        <>
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
        </>
      )}
      <LogsPanel open={logsOpen} onClose={() => setLogsOpen(false)} />
      <ToastHost />
    </>
  );
}
