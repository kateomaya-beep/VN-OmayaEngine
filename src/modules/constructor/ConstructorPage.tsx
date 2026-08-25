import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useProjectStore } from './projectStore';
import { useT, useLang } from '../../shared/i18n';
import { validateProject } from '../../shared/validator';
import { normalizeNarrativeMode } from '../../shared/types';
import { useAppMode } from '../../app/appMode';
import { ProjectSettings } from './editors/ProjectSettings';
import { LoreEditor } from './editors/LoreEditor';
import { CharacterEditor } from './editors/CharacterEditor';
import { StatsEditor } from './editors/StatsEditor';
import { AssetManager } from './editors/AssetManager';
import { LorebookEditor } from './editors/LorebookEditor';
import { AssistantChat } from './editors/AssistantChat';

// vnOnly — вкладка нужна только визуальной новелле. В текстовом РП спрайтов, фонов
// и музыки не существует, и целая вкладка «Ассеты» там просит загрузить то, чему
// негде показаться.
const TABS = [
  { id: 'settings', label: 'tab.settings', el: ProjectSettings },
  { id: 'lore', label: 'tab.lore', el: LoreEditor },
  { id: 'characters', label: 'tab.characters', el: CharacterEditor },
  { id: 'stats', label: 'tab.stats', el: StatsEditor },
  { id: 'assets', label: 'tab.assets', el: AssetManager, vnOnly: true },
  { id: 'lorebook', label: 'tab.lorebook', el: LorebookEditor },
  { id: 'assistant', label: 'tab.assistant', el: AssistantChat },
] as const;

export function ConstructorPage() {
  const { projectId } = useParams();
  const nav = useNavigate();
  const tr = useT();
  const lang = useLang((s) => s.lang);
  const L = (ru: string, en: string) => (lang === 'en' ? en : ru);
  const { project, load, persist, dirty, loading } = useProjectStore();
  const [tab, setTab] = useState<string>('settings');

  useEffect(() => {
    if (projectId) load(projectId);
  }, [projectId]);

  // Открыли проект чужого режима (ссылка из истории браузера, «назад», закладка) —
  // подстраиваем режим приложения под проект, а не наоборот. Иначе конструктор
  // показал бы вкладки одного режима для проекта из другого.
  const appMode = useAppMode((s) => s.mode);
  const setAppMode = useAppMode((s) => s.setMode);
  const projectMode = project ? normalizeNarrativeMode(project.mode) : null;
  useEffect(() => {
    if (projectMode && projectMode !== appMode) setAppMode(projectMode);
  }, [projectMode, appMode, setAppMode]);

  // Autosave shortly after edits.
  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(() => persist(), 800);
    return () => clearTimeout(t);
  }, [dirty, project]);

  if (loading || !project) {
    return <div className="max-w-6xl mx-auto px-4 py-16 text-gray-500">{tr('constructor.loading')}</div>;
  }

  const issues = validateProject(project);
  const errors = issues.filter((i) => i.level === 'error');
  const rp = normalizeNarrativeMode(project.mode) === 'rp';
  const tabs = TABS.filter((t) => !(rp && 'vnOnly' in t && t.vnOnly));
  // Режим переключили, стоя на скрытой теперь вкладке — уводим на первую, иначе
  // экран остался бы пустым.
  const Active = (tabs.find((t) => t.id === tab) ?? tabs[0]).el;

  return (
    <div className="max-w-6xl mx-auto px-4 py-6">
      <div className="flex items-center gap-3 mb-4">
        <button className="btn-ghost !px-3 !py-1.5" onClick={() => nav('/library')}>
          {tr('constructor.back')}
        </button>
        <h1 className="text-xl font-bold truncate">{project.meta.title}</h1>
        {/* Ярлык режима, не переключатель: у проекта он один и меняется только
            адаптацией (копией) из библиотеки. */}
        <span
          className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] border ${
            rp
              ? 'bg-[rgba(160,110,255,0.18)] border-[rgba(190,150,255,0.5)] text-[#e5deF7]'
              : 'bg-white/[0.05] border-[rgba(180,150,255,0.2)] text-[#a8a2c0]'
          }`}
          title={L('Режим проекта — меняется адаптацией из библиотеки', 'Project mode — change it by adapting from the library')}
        >
          {rp ? L('💬 Классический РП', '💬 Classic RP') : L('🎭 Визуальная новелла', '🎭 Visual novel')}
        </span>
        <span className="flex-1" />
        <span className="text-xs text-gray-500">
          {dirty ? tr('constructor.saving') : tr('constructor.saved')}
        </span>
        <button
          className="btn-primary"
          disabled={errors.length > 0}
          onClick={async () => {
            await persist();
            nav(`/play/${project.id}`);
          }}
        >
          {tr('constructor.play')}
        </button>
      </div>

      {issues.length > 0 && (
        <div className="card mb-4 border-l-4 border-l-amber-400/60">
          <div className="text-sm font-semibold mb-1">{tr('constructor.validator')}</div>
          <ul className="text-xs space-y-1">
            {issues.map((i, idx) => (
              <li key={idx} className={i.level === 'error' ? 'text-red-400' : 'text-amber-300'}>
                {i.level === 'error' ? '⛔' : '⚠️'} {i.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex gap-1 mb-4 flex-wrap border-b border-white/10 pb-2">
        {tabs.map((tb) => (
          <button
            key={tb.id}
            className={`px-3 py-1.5 rounded-lg text-sm ${
              tab === tb.id ? 'bg-accent text-white' : 'hover:bg-white/5 text-gray-300'
            }`}
            onClick={() => setTab(tb.id)}
          >
            {tr(tb.label)}
          </button>
        ))}
      </div>

      <Active />
    </div>
  );
}
