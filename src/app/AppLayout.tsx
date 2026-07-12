import { Outlet } from 'react-router-dom';
import { useProjectStore } from '../modules/constructor/projectStore';
import { TopBar } from './TopBar';

// Каркас главного экрана: постоянная верхняя панель (общая с плеером) + контент.
// Расширения панели действуют на открытый в конструкторе проект (если есть).
export function AppLayout() {
  const { project, update } = useProjectStore();

  return (
    <div className="min-h-full flex flex-col">
      <TopBar variant="app" project={project} onPatchProject={update} />
      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  );
}
