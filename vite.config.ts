import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));

export default defineConfig({
  plugins: [react()],
  // ВАЖНО: dev, preview и лаунчер ДОЛЖНЫ работать на ОДНОМ порту. IndexedDB (проекты,
  // сейвы, ассеты) привязана к origin = scheme+host+ПОРТ. Если порт «уплывёт»
  // (dev 5173 → preview 4173, или strictPort=false подберёт 5174), приложение
  // откроет ДРУГУЮ пустую базу и покажется, что данные пропали (они целы, просто
  // под старым адресом). strictPort=true: лучше явная ошибка «порт занят», чем
  // тихий переход на новый origin и «пустая игра».
  server: { port: 5173, strictPort: true },
  preview: { port: 5173, strictPort: true },
  // vectorWorker.ts dynamically imports @huggingface/transformers, which needs
  // code-splitting inside the worker — only the ES module worker format supports that.
  worker: { format: 'es' },
  // Крупный чанк — библиотека векторизации (transformers/wasm), это ожидаемо.
  // Поднимаем порог, чтобы жёлтое предупреждение «chunks larger than 500 kB» не
  // пугало (это НЕ ошибка — сборка проходит успешно).
  build: { chunkSizeWarningLimit: 2000 },
  // Keep the dep-optimizer cache OUT of the project tree (OneDrive/antivirus on
  // Windows can lock or half-write files under node_modules/.vite, producing a
  // corrupted React runtime: "hasValidRef ... reading 'get'"). The OS temp dir
  // is never cloud-synced, and a stale in-repo .vite becomes irrelevant.
  cacheDir: path.join(os.tmpdir(), 'novel-forge-vite-cache'),
  // Version stamp shown in the UI so it's always clear which build is running.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  // Guarantee a single React instance across all pre-bundled deps.
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      'react-dom/client',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
      'react-router-dom',
    ],
  },
});
