import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useProjectStore } from './projectStore';
import { validateProject } from '../../shared/validator';
import { ProjectSettings } from './editors/ProjectSettings';
import { LoreEditor } from './editors/LoreEditor';
import { CharacterEditor } from './editors/CharacterEditor';
import { StatsEditor } from './editors/StatsEditor';
import { AssetManager } from './editors/AssetManager';
import { LorebookEditor } from './editors/LorebookEditor';
import { PromptTuner } from './editors/PromptTuner';

const TABS = [
  { id: 'settings', label: 'Настройки', el: ProjectSettings },
  { id: 'lore', label: 'Лор', el: LoreEditor },
  { id: 'characters', label: 'Персонажи', el: CharacterEditor },
  { id: 'stats', label: 'Статы', el: StatsEditor },
  { id: 'assets', label: 'Ассеты', el: AssetManager },
  { id: 'lorebook', label: 'Лорбук', el: LorebookEditor },
  { id: 'ai', label: 'ИИ / Промпт', el: PromptTuner },
] as const;

export function ConstructorPage() {
  const { projectId } = useParams();
  const nav = useNavigate();
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
    return <div className="max-w-6xl mx-auto px-4 py-16 text-gray-500">Загрузка проекта…</div>;
  }

  const issues = validateProject(project);
  const errors = issues.filter((i) => i.level === 'error');
  const Active = TABS.find((t) => t.id === tab)!.el;

  return (
    <div className="max-w-6xl mx-auto px-4 py-6">
      <div className="flex items-center gap-3 mb-4">
        <button className="btn-ghost !px-3 !py-1.5" onClick={() => nav('/library')}>
          ← Библиотека
        </button>
        <h1 className="text-xl font-bold truncate flex-1">{project.meta.title}</h1>
        <span className="text-xs text-gray-500">{dirty ? 'сохранение…' : 'сохранено'}</span>
        <button
          className="btn-primary"
          disabled={errors.length > 0}
          title={errors.length ? 'Исправьте ошибки валидатора' : 'Запустить'}
          onClick={async () => {
            await persist();
            nav(`/play/${project.id}`);
          }}
        >
          ▶ Играть
        </button>
      </div>

      {issues.length > 0 && (
        <div className="card mb-4 border-l-4 border-l-amber-400/60">
          <div className="text-sm font-semibold mb-1">Валидатор проекта</div>
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
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`px-3 py-1.5 rounded-lg text-sm ${
              tab === t.id ? 'bg-accent text-white' : 'hover:bg-white/5 text-gray-300'
            }`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <Active />
    </div>
  );
}
