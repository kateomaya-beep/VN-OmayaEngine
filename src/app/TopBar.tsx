import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useLang } from '../shared/i18n';
import { ConnectionPanel } from '../modules/shared/ConnectionPanel';
import { ExtensionsPanel } from '../modules/shared/ExtensionsPanel';
import { PresetPanel } from '../modules/shared/PresetPanel';
import { GameMasterPanel } from '../modules/shared/GameMasterPanel';
import { LogsPanel } from '../modules/shared/LogsPanel';
import { ToastHost } from '../shared/ToastHost';
import { useLogs } from '../shared/logStore';
import type { Project } from '../shared/types';

// Единая постоянная верхняя панель. Неоново-стеклянный дизайн (см. импорт дизайна
// «VN Engine Library»). Вместо текста — иконки с подсказками на выбранном языке.
// Иконки: слева-направо — Пресет · API · [в игре: Game Master · Расширения] ·
// Логи · Язык. Смена темы убрана; Game Master доступен ТОЛЬКО в плеере.

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
    <Svg>
      <rect x="4.5" y="3.5" width="11" height="13" rx="3" stroke={ICON_STROKE} strokeWidth="1.5" />
      <path d="M8 7.5v3M12 7.5v3" stroke={ICON_STROKE} strokeWidth="1.5" strokeLinecap="round" />
      <path d="M10 13.3v2.4" stroke={ICON_STROKE} strokeWidth="1.5" strokeLinecap="round" />
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
  ext: (
    <Svg>
      <rect x="3.3" y="3.3" width="5.4" height="5.4" rx="1.6" stroke={ICON_STROKE} strokeWidth="1.4" />
      <rect x="11.3" y="3.3" width="5.4" height="5.4" rx="1.6" stroke={ICON_STROKE} strokeWidth="1.4" />
      <rect x="3.3" y="11.3" width="5.4" height="5.4" rx="1.6" stroke={ICON_STROKE} strokeWidth="1.4" />
      <rect x="11.3" y="11.3" width="5.4" height="5.4" rx="1.6" stroke={ICON_STROKE} strokeWidth="1.4" />
    </Svg>
  ),
  logs: (
    <Svg>
      <path
        d="M6 2.5h5.5L15 6v11.5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1Z"
        stroke={ICON_STROKE}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M8 10h4M8 13h4" stroke={ICON_STROKE} strokeWidth="1.4" strokeLinecap="round" />
    </Svg>
  ),
  lang: (
    <Svg>
      <path
        d="M3 5h7M6.5 3.3v1.9M4.3 5c0 3.6 2.1 5.9 4.7 7M8.7 5c-.6 3.1-2.7 5.8-5.7 7.2"
        stroke={ICON_STROKE}
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="m12 17 2.6-6.6L17.2 17M12.9 14.6h3.4"
        stroke={ICON_STROKE}
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  ),
};

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
  right,
}: {
  variant?: 'app' | 'player';
  project?: Project | null;
  onPatchProject?: (mutator: (p: Project) => void) => void;
  left?: ReactNode;
  menuSlot?: ReactNode;
  right?: ReactNode;
}) {
  const container =
    variant === 'player'
      ? 'absolute inset-x-0 top-0 z-30 bg-[rgba(18,16,28,0.55)] backdrop-blur-xl border-b border-[rgba(180,150,255,0.14)]'
      : 'sticky top-0 z-20 bg-[rgba(18,16,28,0.55)] backdrop-blur-xl border-b border-[rgba(180,150,255,0.14)] shadow-[0_1px_20px_rgba(140,90,255,0.06)]';

  return (
    <header className={container}>
      <div className="max-w-6xl mx-auto px-4 sm:px-5 h-14 flex items-center gap-3">
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
          <span className="flex flex-col leading-none">
            <span className="font-brand font-extrabold text-[16px] tracking-[0.2px] text-[#f5f2fc]">
              VN Studio
            </span>
            <span className="text-[9px] font-semibold tracking-[1.6px] text-[#b18cff]">
              NOVEL ENGINE {variant === 'app' && `· v${__APP_VERSION__}`}
            </span>
          </span>
        </Link>
        {left}
        <div className="ml-auto flex items-center gap-2">
          {menuSlot}
          <TopBarControls variant={variant} project={project} onPatchProject={onPatchProject} />
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
}: {
  variant?: 'app' | 'player';
  project?: Project | null;
  onPatchProject?: (mutator: (p: Project) => void) => void;
}) {
  const { lang, setLang } = useLang();
  const L = (ru: string, en: string) => (lang === 'en' ? en : ru);
  const [connOpen, setConnOpen] = useState(false);
  const [extOpen, setExtOpen] = useState(false);
  const [presetOpen, setPresetOpen] = useState(false);
  const [gmOpen, setGmOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const errorCount = useLogs((s) => s.logs.reduce((n, l) => n + (l.level === 'error' ? 1 : 0), 0));

  const inPlayer = variant === 'player';

  return (
    <>
      {/* Порядок: Пресет · API · [в игре: GM · Расширения] · Логи · Язык */}
      <IconBtn title={L('Пресет промпта', 'Prompt preset')} onClick={() => setPresetOpen(true)}>
        {Icons.preset}
      </IconBtn>
      <IconBtn title={L('Подключение к ИИ', 'AI connection')} onClick={() => setConnOpen(true)}>
        {Icons.api}
      </IconBtn>
      {inPlayer && (
        <>
          <IconBtn title={L('Game Master', 'Game Master')} onClick={() => setGmOpen(true)}>
            {Icons.gm}
          </IconBtn>
          <IconBtn title={L('Расширения', 'Extensions')} onClick={() => setExtOpen(true)}>
            {Icons.ext}
          </IconBtn>
        </>
      )}
      <IconBtn title={L('Логи (события и ошибки)', 'Logs (events & errors)')} onClick={() => setLogsOpen(true)} badge={errorCount}>
        {Icons.logs}
      </IconBtn>
      <IconBtn
        title={L(`Язык интерфейса: ${lang === 'ru' ? 'сменить на English' : 'switch to Русский'}`, `UI language: switch to ${lang === 'en' ? 'Русский' : 'English'}`)}
        onClick={() => setLang(lang === 'ru' ? 'en' : 'ru')}
      >
        {Icons.lang}
      </IconBtn>

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
