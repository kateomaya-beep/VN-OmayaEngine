import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLang } from '../../../shared/i18n';
import { usePlayerStore } from '../playerStore';
import { listPlaythroughs, type PlaythroughInfo } from '../../../storage/playthroughs';
import { getProject, duplicateProject } from '../../../storage/db';
import type { NarrativeMode, SaveSlot } from '../../../shared/types';
import { normalizeNarrativeMode } from '../../../shared/types';
import { formatDate } from '../../../shared/utils';

// Экран запуска истории (Batch 5.2): три варианта — Продолжить / Загрузить сейв /
// Новая история. «Новая» при наличии прогресса спрашивает, что делать со старым:
// вести параллельно в этом же проекте, начать в ОТДЕЛЬНОМ проекте-копии (оригинал
// вообще не трогаем) или удалить старое.
type View = 'menu' | 'load' | 'new';

export function LaunchScreen({ projectId, onStarted }: { projectId: string; onStarted: () => void }) {
  const lang = useLang((s) => s.lang);
  const L = (ru: string, en: string) => (lang === 'en' ? en : ru);
  const nav = useNavigate();
  const s = usePlayerStore();
  const [view, setView] = useState<View>('menu');
  const [playthroughs, setPlaythroughs] = useState<PlaythroughInfo[]>([]);
  // Режим повествования показываем ДО запуска: он определяет, что вообще будет на
  // экране — сцена со спрайтами или лента переписки.
  const [mode, setMode] = useState<NarrativeMode>('vn');
  const [loaded, setLoaded] = useState(false);
  const [copying, setCopying] = useState(false);

  useEffect(() => {
    // Сменился проект (в т.ч. после «в отдельном проекте») — начинаем с меню и
    // перечитываем прохождения уже нового проекта.
    setView('menu');
    setLoaded(false);
    let alive = true;
    (async () => {
      const [list, proj] = await Promise.all([listPlaythroughs(projectId), getProject(projectId)]);
      if (!alive) return;
      setPlaythroughs(list);
      setMode(normalizeNarrativeMode(proj?.mode));
      setLoaded(true);
    })();
    return () => {
      alive = false;
    };
  }, [projectId]);

  const hasProgress = playthroughs.length > 0;

  function start(fn: () => Promise<unknown>) {
    onStarted();
    void fn();
  }

  const shell = (children: React.ReactNode) => (
    <div className="min-h-screen flex items-center justify-center bg-ink p-4">
      <div className="card w-full max-w-lg">{children}</div>
    </div>
  );

  if (!loaded) {
    return shell(<p className="text-center text-gray-400 py-8">{L('Загрузка…', 'Loading…')}</p>);
  }

  // ---- Меню ----
  if (view === 'menu') {
    return shell(
      <>
        <h2 className="text-lg font-semibold mb-1 text-center">{L('Запуск истории', 'Start the story')}</h2>
        <p className="text-center mb-2">
          <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] bg-white/[0.05] border border-[rgba(180,150,255,0.22)] text-[#c8c2dd]">
            {mode === 'rp'
              ? L('💬 Классический РП — только текст', '💬 Classic RP — text only')
              : L('🎭 Визуальная новелла', '🎭 Visual novel')}
          </span>
        </p>
        <p className="text-sm text-gray-500 mb-5 text-center">
          {hasProgress
            ? L('Продолжите, загрузите сейв или начните заново.', 'Continue, load a save, or start over.')
            : L('Начните первое прохождение.', 'Begin your first playthrough.')}
        </p>
        <div className="space-y-2">
          {hasProgress && (
            <button className="btn-primary w-full !py-3" onClick={() => start(() => s.continuePlaythrough(projectId))}>
              ▶ {L('Продолжить', 'Continue')}
            </button>
          )}
          {hasProgress && (
            <button className="btn-ghost w-full !py-3" onClick={() => setView('load')}>
              🗂 {L('Загрузить сейв', 'Load save')}
            </button>
          )}
          <button
            className={`w-full !py-3 ${hasProgress ? 'btn-ghost' : 'btn-primary'}`}
            onClick={() => (hasProgress ? setView('new') : start(() => s.newPlaythrough(projectId, { wipe: false })))}
          >
            ✦ {L('Новая история', 'New story')}
          </button>
        </div>
        <button className="text-xs text-gray-500 mt-5 mx-auto block" onClick={() => nav('/library')}>
          {L('← В библиотеку', '← To library')}
        </button>
      </>
    );
  }

  // ---- Новая история: удалить старый прогресс или вести параллельно ----
  if (view === 'new') {
    return shell(
      <>
        <h2 className="text-lg font-semibold mb-1 text-center">{L('Новая история', 'New story')}</h2>
        <p className="text-sm text-gray-500 mb-5 text-center">
          {L('У проекта уже есть прохождения. Что сделать со старым прогрессом?', 'This project already has playthroughs. What about the old progress?')}
        </p>
        <div className="space-y-2">
          <button
            className="btn-ghost w-full !py-3 text-left"
            onClick={() => start(() => s.newPlaythrough(projectId, { wipe: false }))}
          >
            <div className="font-medium">➕ {L('Вести параллельно', 'Keep in parallel')}</div>
            <div className="text-xs text-gray-500">
              {L('Старые прохождения остаются, создаётся новое рядом.', 'Old playthroughs stay; a new one is created alongside.')}
            </div>
          </button>
          <button
            className="btn-ghost w-full !py-3 text-left"
            disabled={copying}
            onClick={async () => {
              setCopying(true);
              try {
                const p = await getProject(projectId);
                if (!p) return;
                const res = await duplicateProject(
                  p,
                  `${p.meta.title || 'Проект'} — новая история`,
                  { includeProgress: false }
                );
                nav(`/play/${res.project.id}`);
              } finally {
                setCopying(false);
              }
            }}
          >
            <div className="font-medium">
              ⧉ {copying ? L('Копирую…', 'Copying…') : L('В отдельном проекте', 'In a separate project')}
            </div>
            <div className="text-xs text-gray-500">
              {L(
                'Создаётся копия проекта — те же персонажи и ассеты, но своя история. Этот проект и всё, что в нём пройдено, останутся нетронутыми.',
                'A copy of the project is created — same characters and assets, but its own story. This project and everything played in it stay untouched.'
              )}
            </div>
          </button>
          <button
            className="btn-ghost w-full !py-3 text-left !border-red-500/30"
            onClick={() => {
              if (window.confirm(L('Удалить ВСЕ старые прохождения этого проекта? Это необратимо.', 'Delete ALL old playthroughs of this project? This cannot be undone.')))
                start(() => s.newPlaythrough(projectId, { wipe: true }));
            }}
          >
            <div className="font-medium text-red-300">🗑 {L('Удалить старый прогресс', 'Delete old progress')}</div>
            <div className="text-xs text-gray-500">{L('Существующие прохождения удаляются, начинаем чисто.', 'Existing playthroughs are removed; start clean.')}</div>
          </button>
        </div>
        <button className="text-xs text-gray-500 mt-5 mx-auto block" onClick={() => setView('menu')}>
          {L('← Назад', '← Back')}
        </button>
      </>
    );
  }

  // ---- Загрузить сейв: список прохождений → их курсор/чекпоинты ----
  const pick = (save: SaveSlot) => start(() => s.resumeSave(projectId, save));
  return shell(
    <>
      <h2 className="text-lg font-semibold mb-3 text-center">{L('Загрузить сейв', 'Load save')}</h2>
      <div className="max-h-[60vh] overflow-y-auto scrollbar-thin space-y-3 pr-1">
        {playthroughs.map((p) => (
          <div key={p.id} className="rounded-lg border border-white/10 bg-panel2 p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="font-medium text-sm">{p.label}</div>
              <div className="text-xs text-gray-500">{formatDate(p.createdAt)}</div>
            </div>
            {p.autosave && (
              <button
                className="w-full flex items-center justify-between rounded-md bg-panel px-3 py-2 mb-1 hover:bg-white/5"
                onClick={() => pick(p.autosave!)}
              >
                <span className="text-sm">▶ {L('Продолжить (автосейв)', 'Continue (autosave)')}</span>
                <span className="text-xs text-gray-500">
                  {L('ход', 'turn')} {p.autosave.state.turnCount} · {formatDate(p.autosave.savedAt)}
                </span>
              </button>
            )}
            {p.checkpoints.length > 0 && (
              <div className="mt-1 space-y-1">
                <div className="text-xs uppercase tracking-wide text-gray-500">{L('Чекпоинты/ветки', 'Checkpoints/branches')}</div>
                {p.checkpoints.map((c) => (
                  <button
                    key={c.slot}
                    className="w-full flex items-center justify-between rounded-md bg-panel px-3 py-2 hover:bg-white/5"
                    onClick={() => pick(c)}
                  >
                    <span className="text-sm truncate">⑂ {c.branchName || c.title}</span>
                    <span className="text-xs text-gray-500 shrink-0 ml-2">
                      {L('ход', 'turn')} {c.state.turnCount}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      <button className="text-xs text-gray-500 mt-4 mx-auto block" onClick={() => setView('menu')}>
        {L('← Назад', '← Back')}
      </button>
    </>
  );
}
