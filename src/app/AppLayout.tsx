import { Link, Outlet, useLocation } from 'react-router-dom';

export function AppLayout() {
  const loc = useLocation();
  const inProject = loc.pathname.startsWith('/project/');
  return (
    <div className="min-h-full flex flex-col">
      <header className="border-b border-white/10 bg-panel/60 backdrop-blur sticky top-0 z-20">
        <div className="max-w-6xl mx-auto px-4 h-14 flex items-center gap-4">
          <Link to="/library" className="font-bold text-lg tracking-tight">
            <span className="text-accent">Novel</span>
            <span className="text-accent2">Forge</span>
          </Link>
          <nav className="flex items-center gap-1 text-sm">
            <Link
              to="/library"
              className={`px-3 py-1.5 rounded-lg ${
                !inProject ? 'bg-white/10' : 'hover:bg-white/5'
              }`}
            >
              Библиотека
            </Link>
          </nav>
          <div className="ml-auto text-xs text-gray-500">
            локальное приложение · данные в вашем браузере
          </div>
        </div>
      </header>
      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  );
}
