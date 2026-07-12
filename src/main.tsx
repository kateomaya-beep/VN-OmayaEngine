import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { router } from './app/router';
import './index.css';

// Build stamp — makes it unambiguous which code is actually running in the tab.
console.info(`[NovelForge] v${__APP_VERSION__}`);

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
