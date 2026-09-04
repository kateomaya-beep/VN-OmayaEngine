import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { router } from './app/router';
import { logEvent } from './shared/logStore';
import { syncStorage } from './storage/db';
import './index.css';

// Заставка загрузки (index.html) ждёт от нас отметок о реальных шагах. Модуль
// исполняется — значит код уже скачан и разобран, это первая честная отметка.
window.__boot?.stage('code');

// Build stamp — makes it unambiguous which code is actually running in the tab.
console.info(`[NovelForge] v${__APP_VERSION__}`);
logEvent('info', 'app', `VN Studio v${__APP_VERSION__} запущен`);

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

// УМЕР ЛИ ЛАУНЧЕР. У офлайн-режима есть цена: когда сервер лаунчера не работает,
// сервис-воркер всё равно отдаёт приложение из кэша — оно открывается, выглядит
// совершенно обычным, и только запросы к ИИ перестают ходить через прокси. На
// Android это выглядит особенно обманчиво: система прибила Termux в фоне, пока вы
// читали ход, а игра как ни в чём не бывало открылась с иконки.
//
// Поэтому при старте проверяем: если адрес ЛОКАЛЬНЫЙ (то есть страницу по идее
// отдаёт наш сервер), а сервера на нём нет — говорим об этом сразу и вслух, а не
// ждём, пока человек полезет в «Подключение к ИИ» разбираться, почему ответы
// перестали приходить.
if (import.meta.env.PROD && /^https?:$/.test(location.protocol)) {
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(location.hostname);
  if (local) {
    // Ни 'load', ни readyState: до 'complete' это приложение доходит не скоро (в
    // фоне тянется тяжёлый wasm для векторного поиска), и проверка, повешенная на
    // загрузку страницы, просто не выполнялась. Ждать нечего — fetch работает
    // сразу; небольшая пауза только чтобы не соревноваться со стартом за поток.
    const runCheck = () => {
      void (async () => {
        try {
          const r = await fetch('/__proxy/health', { cache: 'no-store' });
          if (r.ok && r.headers.get('x-vn-proxy') === '1') return;
        } catch {
          /* сервера нет — сообщение ниже */
        }
        const { pushToast } = await import('./shared/toast');
        pushToast(
          'error',
          'Лаунчер не отвечает — страница открыта из кэша. Запросы к ИИ сейчас пойдут напрямую ' +
            'из браузера (у многих провайдеров это CORS-отказ). Откройте Termux/терминал и ' +
            'запустите start-omaya.sh заново.'
        );
      })();
    };
    setTimeout(runCheck, 1500);
  }
}

// Перед рендером синхронизируемся с файловым хранилищем на диске (если доступен
// локальный сервер): прогреваем/мигрируем IndexedDB из файлов. Так библиотека сразу
// показывает актуальный набор, а прогресс переживает очистку данных браузера.
async function boot() {
  window.__boot?.stage('storage');
  try {
    await syncStorage();
  } catch (e) {
    logEvent('warn', 'disk', 'Синхронизация с диском не удалась: ' + (e as Error).message);
  }
  window.__boot?.stage('ui');
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <RouterProvider router={router} />
    </React.StrictMode>
  );
  // Прячем заставку не по таймеру, а после того, как React отработал первый кадр:
  // иначе она уходила бы за миг до появления интерфейса и открывала пустоту.
  requestAnimationFrame(() => requestAnimationFrame(() => window.__boot?.done()));
}
boot();
