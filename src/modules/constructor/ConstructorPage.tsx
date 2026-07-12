import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useProjectStore } from './projectStore';
import { useT } from '../../shared/i18n';
import { validateProject } from '../../shared/validator';
import { ProjectSettings } from './editors/ProjectSettings';
import { LoreEditor } from './editors/LoreEditor';
import { CharacterEditor } from './editors/CharacterEditor';
import { StatsEditor } from './editors/StatsEditor';
import { AssetManager } from './editors/AssetManager';
import { LorebookEditor } from './editors/LorebookEditor';

const TABS = [
  { id: 'settings', label: 'tab.settings', el: ProjectSettings },
  { id: 'lore', label: 'tab.lore', el: LoreEditor },
  { id: 'characters', label: 'tab.characters', el: CharacterEditor },
  { id: 'stats', label: 'tab.stats', el: StatsEditor },
  { id: 'assets', label: 'tab.assets', el: AssetManager },
  { id: 'lorebook', label: 'tab.lorebook', el: LorebookEditor },
] as const;

export function ConstructorPage() {
  const { projectId } = useParams();
  const nav = useNavigate();
  const tr = useT();
  const { project, load, persist, dirty, loading } = useProjectStore();
  const [tab, setTab] = useState<string>('settings');

  useEffect(() => {
    if (projectId) load(projectId);
  }, [projectId]);

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
  const Active = TABS.find((t) => t.id === tab)!.el;

  return (
    <div className="max-w-6xl mx-auto px-4 py-6">
      <div className="flex items-center gap-3 mb-4">
        <button className="btn-ghost !px-3 !py-1.5" onClick={() => nav('/library')}>
          {tr('constructor.back')}
        </button>
        <h1 className="text-xl font-bold truncate flex-1">{project.meta.title}</h1>
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
        {TABS.map((tb) => (
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
