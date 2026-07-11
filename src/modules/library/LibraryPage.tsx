import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Project } from '../../shared/types';
import { listProjects, saveProject, deleteProject } from '../../storage/db';
import { createEmptyProject } from '../../shared/factory';
import { exportProjectZip, downloadBlob, importProjectZip } from '../../storage/zip';
import { AssetImage, Modal } from '../../shared/ui';
import { formatDate } from '../../shared/utils';
import { useT } from '../../shared/i18n';

export function LibraryPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const nav = useNavigate();
  const t = useT();

  async function refresh() {
    setProjects(await listProjects());
  }
  useEffect(() => {
    refresh();
  }, []);

  async function create() {
    const p = createEmptyProject(title.trim() || 'Без названия');
    await saveProject(p);
    setCreating(false);
    setTitle('');
    nav(`/project/${p.id}`);
  }

  const [shareTarget, setShareTarget] = useState<Project | null>(null);

  async function onImport(file: File) {
    setBusy('Импорт...');
    try {
      const { warnings } = await importProjectZip(file);
      await refresh();
      if (warnings.length) alert('Проект импортирован с замечаниями:\n' + warnings.join('\n'));
    } catch (e) {
      alert('Ошибка импорта: ' + (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function onExport(p: Project) {
    setBusy('Экспорт...');
    try {
      const blob = await exportProjectZip(p);
      downloadBlob(blob, `${p.meta.title || 'project'}.zip`);
    } finally {
      setBusy(null);
    }
  }

  async function onShareDownload(p: Project) {
    setBusy('Экспорт...');
    try {
      const blob = await exportProjectZip(p);
      downloadBlob(blob, `${p.meta.title || 'project'}.zip`);
      setShareTarget(null);
    } finally {
      setBusy(null);
    }
  }

  async function onDelete(p: Project) {
    if (!confirm(`Удалить проект «${p.meta.title}» и все его ассеты?`)) return;
    await deleteProject(p.id);
    await refresh();
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">{t('library.title')}</h1>
          <p className="text-gray-400 text-sm">{t('library.subtitle')}</p>
        </div>
        <div className="flex gap-2">
          <button className="btn-ghost" onClick={() => fileRef.current?.click()}>
            {t('library.import')}
          </button>
          <button className="btn-primary" onClick={() => setCreating(true)}>
            {t('library.new')}
          </button>
        </div>
      </div>

      {busy && <div className="mb-4 text-sm text-accent2">{busy}</div>}

      <input
        ref={fileRef}
        type="file"
        accept=".zip"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onImport(f);
          e.target.value = '';
        }}
      />

      {projects.length === 0 ? (
        <div className="card text-center py-16 text-gray-500">{t('library.empty')}</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {projects.map((p) => (
            <div key={p.id} className="card flex flex-col">
              <div
                className="aspect-video rounded-lg overflow-hidden mb-3 cursor-pointer bg-panel2"
                onClick={() => nav(`/project/${p.id}`)}
              >
                <AssetImage
                  blobKey={p.assets.find((a) => a.id === p.meta.coverAssetId)?.blobKey}
                  className="w-full h-full object-cover"
                />
              </div>
              <h3 className="font-semibold truncate">{p.meta.title}</h3>
              <p className="text-xs text-gray-500 mb-1">
                {p.characters.length} {t('library.charactersShort')} · {p.assets.length}{' '}
                {t('library.assetsShort')}
              </p>
              <p className="text-xs text-gray-600 mb-3">{formatDate(p.updatedAt)}</p>
              <div className="mt-auto flex flex-wrap gap-2">
                <button className="btn-primary !px-3 !py-1.5 text-xs" onClick={() => nav(`/play/${p.id}`)}>
                  {t('library.play')}
                </button>
                <button
                  className="btn-ghost !px-3 !py-1.5 text-xs"
                  onClick={() => nav(`/project/${p.id}`)}
                >
                  {t('library.editor')}
                </button>
                <button className="btn-ghost !px-3 !py-1.5 text-xs" onClick={() => onExport(p)}>
                  {t('library.export')}
                </button>
                <button className="btn-ghost !px-3 !py-1.5 text-xs" onClick={() => setShareTarget(p)}>
                  🔗 Поделиться
                </button>
                <button className="btn-danger !px-3 !py-1.5 text-xs" onClick={() => onDelete(p)}>
                  {t('library.delete')}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal open={creating} onClose={() => setCreating(false)} title={t('library.newTitle')}>
        <input
          className="input mb-4"
          placeholder={t('library.namePlaceholder')}
          value={title}
          autoFocus
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && create()}
        />
        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setCreating(false)}>
            {t('library.cancel')}
          </button>
          <button className="btn-primary" onClick={create}>
            {t('library.create')}
          </button>
        </div>
      </Modal>

      {/* Экспорт для шаринга: превью-карточка + дисклеймер про права на контент (CR v2 §L) */}
      <Modal open={!!shareTarget} onClose={() => setShareTarget(null)} title="Экспортировать для шаринга">
        {shareTarget && (
          <>
            <div className="aspect-video rounded-lg overflow-hidden mb-3 bg-panel2">
              <AssetImage
                blobKey={shareTarget.assets.find((a) => a.id === shareTarget.meta.coverAssetId)?.blobKey}
                className="w-full h-full object-cover"
              />
            </div>
            <h3 className="font-semibold mb-1">{shareTarget.meta.title}</h3>
            {shareTarget.lore.worldDescription && (
              <p className="text-xs text-gray-400 mb-3 line-clamp-3">
                {shareTarget.lore.worldDescription.slice(0, 200)}
              </p>
            )}
            <div className="bg-amber-500/10 border border-amber-400/30 rounded-lg p-3 text-xs text-amber-200 mb-4">
              ⚠️ Вы делитесь файлами, которые могут быть защищены авторским правом или условиями
              стороннего сервиса (сток, AI-генератор и т.д.) — убедитесь, что имеете право их
              распространять. Ответственность за содержимое — на вас.
            </div>
            <div className="flex justify-end gap-2">
              <button className="btn-ghost" onClick={() => setShareTarget(null)}>
                Отмена
              </button>
              <button className="btn-primary" onClick={() => onShareDownload(shareTarget)}>
                Скачать .zip
              </button>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}
