import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { router } from './app/router';
import { logEvent } from './shared/logStore';
import './index.css';

// Build stamp — makes it unambiguous which code is actually running in the tab.
console.info(`[NovelForge] v${__APP_VERSION__}`);
logEvent('info', 'app', `Novel Forge v${__APP_VERSION__} запущен`);

// Ловим необработанные ошибки и промисы — чтобы «молчаливые» сбои и вечная
// загрузка были видны в панели логов (см. запрос про логи как в Таверне).
window.addEventListener('error', (e) => {
  logEvent('error', 'window', e.message || 'Ошибка страницы', (e.error as Error)?.stack);
});
window.addEventListener('unhandledrejection', (e) => {
  const r: any = e.reason;
  logEvent('error', 'promise', r?.message || String(r) || 'Необработанное отклонение промиса', r?.stack);
});

// Просим у браузера ПОСТОЯННОЕ хранилище — чтобы IndexedDB (проекты/сейвы/ассеты)
// не вытеснялась при нехватке места или по эвристикам браузера. У установленного
// PWA грант выдаётся почти всегда. Не критично, если откажет.
if (navigator.storage?.persist) {
  navigator.storage
    .persisted()
    .then((already) => (already ? true : navigator.storage.persist()))
    .then((granted) => console.info(`[NovelForge] persistent storage: ${granted}`))
    .catch(() => {});
}

// PWA: регистрируем сервис-воркер только в проде (в dev мешает HMR). Даёт установку
// как отдельного приложения (ярлык + окно без браузера) и офлайн-режим.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((e) => {
      console.warn('[NovelForge] SW registration failed:', e);
    });
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>
);
