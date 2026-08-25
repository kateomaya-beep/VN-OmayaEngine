/// <reference types="vite/client" />

// Injected by vite.config.ts `define` from package.json.
declare const __APP_VERSION__: string;

// Заставка загрузки живёт в index.html и существует ДО того, как соберётся бандл,
// поэтому её API — глобальный объект, а не импорт. Опциональный: в тестовой среде
// и при открытии собранных файлов без index.html его может не быть.
interface BootSplash {
  stage(name: 'start' | 'code' | 'storage' | 'ui'): void;
  done(): void;
}
interface Window {
  __boot?: BootSplash;
}
