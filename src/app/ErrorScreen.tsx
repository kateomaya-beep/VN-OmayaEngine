import { useRouteError, useNavigate, isRouteErrorResponse } from 'react-router-dom';

// Route-level error boundary (errorElement). Turns an unexpected render/runtime
// error into a friendly, recoverable screen instead of a white page + raw stack.
export function ErrorScreen() {
  const error = useRouteError();
  const nav = useNavigate();

  let message = 'Неизвестная ошибка';
  let detail = '';
  if (isRouteErrorResponse(error)) {
    message = `${error.status} ${error.statusText}`;
    detail = typeof error.data === 'string' ? error.data : '';
  } else if (error instanceof Error) {
    message = error.message;
    detail = error.stack || '';
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-ink p-6">
      <div className="card max-w-lg w-full">
        <h1 className="text-lg font-bold mb-2 text-red-400">Что-то пошло не так</h1>
        <p className="text-sm text-gray-300 mb-3">{message}</p>
        {detail && (
          <pre className="text-xs bg-black/40 rounded-lg p-3 mb-4 max-h-48 overflow-auto scrollbar-thin text-gray-500 whitespace-pre-wrap">
            {detail.slice(0, 1200)}
          </pre>
        )}
        <div className="flex gap-2">
          <button className="btn-primary" onClick={() => location.reload()}>
            Перезагрузить
          </button>
          <button
            className="btn-ghost"
            onClick={() => {
              nav('/library');
              setTimeout(() => location.reload(), 0);
            }}
          >
            В библиотеку
          </button>
        </div>
        <p className="text-xs text-gray-600 mt-4">
          Если ошибка повторяется: остановите dev-сервер, запустите{' '}
          <code>npm run dev:clean</code> и откройте страницу в режиме инкогнито
          (Ctrl+Shift+N) — это исключит устаревший кэш браузера и Vite.
        </p>
      </div>
    </div>
  );
}
