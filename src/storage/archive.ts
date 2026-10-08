import type { Project } from '../shared/types';
import { normalizeNarrativeMode } from '../shared/types';
import {
  getDB,
  getProject,
  listSavesRaw,
  removeProjectFromIdb,
  putProjectLocal,
  cancelDiskWrites,
  diskMirrorOn,
  forgetProjectSync,
} from './db';
import {
  saveProjectToDisk,
  saveSaveToDisk,
  archiveProjectOnDisk,
  unarchiveProjectOnDisk,
  deleteArchivedOnDisk,
  listArchivedOnDisk,
  loadProjectFromDisk,
} from './fileStore';
import { exportProjectZip, importProjectZip } from './zip';
import { logEvent } from '../shared/logStore';

// АРХИВ ПРОЕКТОВ. Только вручную, по кнопке в библиотеке. Архивный проект не
// показывается в библиотеке, не читается на старте и не занимает места в браузере.
//  - С лаунчером: каталог проекта на диске переезжает в .archive/ как есть (без
//    перепаковки — это мгновенно и ничего не теряет), из браузера проект убирается.
//  - Без лаунчера: в браузере это единственная копия, поэтому проект целиком
//    (ассеты, сейвы) пакуется в один zip и лежит в таблице archive — сжатый и
//    вне всех списков.
// «Вернуть» восстанавливает проект с тем же id: снимки мира, отметки и прочие
// ссылки на него продолжают работать.

export interface ArchivedProject {
  id: string;
  title: string;
  mode: string;
  archivedAt: number;
  size: number;
  where: 'disk' | 'browser';
}

export async function archiveProject(id: string): Promise<void> {
  const project = await getProject(id);
  if (!project) throw new Error('Проект не найден');
  const meta = { title: project.meta.title, mode: normalizeNarrativeMode(project.mode), archivedAt: Date.now() };
  if (await diskMirrorOn()) {
    // Отложенные записи иначе долетели бы ПОСЛЕ переезда и создали бы на старом
    // месте полупустой каталог. Отменяем их и пишем всё свежее сами, сразу.
    cancelDiskWrites(id);
    await saveProjectToDisk(project);
    for (const s of await listSavesRaw(id)) await saveSaveToDisk(s);
    await archiveProjectOnDisk(id, meta);
  } else {
    const blob = await exportProjectZip(project, { includeProgress: true });
    const db = await getDB();
    await db.put('archive', { id, ...meta, size: blob.size, blob });
  }
  await removeProjectFromIdb(id);
  logEvent('info', 'save', `Проект «${project.meta.title}» убран в архив`);
}

export async function listArchived(): Promise<ArchivedProject[]> {
  const out: ArchivedProject[] = [];
  if (await diskMirrorOn()) {
    for (const a of (await listArchivedOnDisk()) || []) {
      out.push({
        id: a.id,
        title: a.title || a.id,
        mode: a.mode || 'vn',
        archivedAt: a.archivedAt || 0,
        size: a.size,
        where: 'disk',
      });
    }
  }
  const db = await getDB();
  for (const r of await db.getAll('archive')) {
    out.push({ id: r.id, title: r.title, mode: r.mode, archivedAt: r.archivedAt, size: r.size, where: 'browser' });
  }
  return out.sort((a, b) => b.archivedAt - a.archivedAt);
}

export async function restoreArchived(a: ArchivedProject): Promise<Project | null> {
  if (a.where === 'disk') {
    await unarchiveProjectOnDisk(a.id);
    const p = await loadProjectFromDisk(a.id);
    if (!p) return null;
    await putProjectLocal(p);
    // Сейвы подтянутся при первом открытии — как у любого проекта с диска.
    forgetProjectSync(a.id);
    logEvent('info', 'save', `Проект «${p.meta.title}» возвращён из архива`);
    return p;
  }
  const db = await getDB();
  const rec = await db.get('archive', a.id);
  if (!rec) return null;
  const { project } = await importProjectZip(new File([rec.blob], `${a.id}.zip`, { type: 'application/zip' }), { keepId: true });
  await db.delete('archive', a.id);
  logEvent('info', 'save', `Проект «${project.meta.title}» возвращён из архива`);
  return project;
}

export async function deleteArchived(a: ArchivedProject): Promise<void> {
  if (a.where === 'disk') await deleteArchivedOnDisk(a.id);
  else await (await getDB()).delete('archive', a.id);
}
