import { Outlet } from 'react-router-dom';
import { useProjectStore } from '../modules/constructor/projectStore';
import { TopBar } from './TopBar';
import { useAppMode } from './appMode';
import { ModePicker } from './ModePicker';

// Каркас главного экрана: постоянная верхняя панель (общая с плеером) + контент.
// Расширения панели действуют на открытый в конструкторе проект (если есть).
export function AppLayout() {
  const { project, update } = useProjectStore();
  const mode = useAppMode((s) => s.mode);

  // Режим ещё не выбран — до библиотеки не доходим вовсе: без него непонятно, что
  // в ней показывать и что означает кнопка «новый проект».
  if (!mode) return <ModePicker />;

  return (
    <div className="min-h-full flex flex-col relative bg-[#0a0912]">
      {/* Неоновые фоновые ореолы (импорт дизайна) — за контентом, не кликабельны */}
      <div aria-hidden className="pointer-events-none fixed inset-0 overflow-hidden z-0">
        <div
          className="absolute -top-32 -left-24 w-[380px] h-[380px] rounded-full blur-2xl"
          style={{ background: 'radial-gradient(circle, rgba(168,120,255,0.22) 0%, rgba(168,120,255,0) 70%)' }}
        />
        <div
          className="absolute top-56 -right-28 w-[320px] h-[320px] rounded-full blur-2xl"
          style={{ background: 'radial-gradient(circle, rgba(130,90,230,0.16) 0%, rgba(130,90,230,0) 70%)' }}
        />
        <div
          className="absolute bottom-0 left-1/4 w-[300px] h-[300px] rounded-full blur-2xl"
          style={{ background: 'radial-gradient(circle, rgba(180,140,255,0.1) 0%, rgba(180,140,255,0) 70%)' }}
        />
      </div>
      <TopBar variant="app" project={project} onPatchProject={update} />
      <main className="flex-1 relative z-[1]">
        <Outlet />
      </main>
    </div>
  );
}
