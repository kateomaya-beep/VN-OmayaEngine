import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  // vectorWorker.ts dynamically imports @huggingface/transformers, which needs
  // code-splitting inside the worker — only the ES module worker format supports that.
  worker: { format: 'es' },
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
