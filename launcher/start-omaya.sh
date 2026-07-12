#!/usr/bin/env bash
# Лаунчер Novel Forge / OmayaEngine.
# Собирает приложение (если надо), поднимает локальный сервер и открывает его.
# Работает в Termux (Android), Linux и macOS. Для установки как отдельного
# приложения (ярлык + окно без браузера) — см. launcher/README.md.
set -e

# Корень репозитория = родитель папки этого скрипта.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Порт 5173 — ТОТ ЖЕ, что у `npm run dev`. Это критично: IndexedDB (проекты, сейвы,
# ассеты) привязана к origin с портом, и смена порта = «пустая игра» (данные целы,
# но под другим адресом). Не меняйте порт, если уже играли — иначе не увидите проекты.
PORT="${PORT:-5173}"
URL="http://localhost:${PORT}/"

echo "▸ Novel Forge — лаунчер"
echo "  Каталог: $ROOT"

# 1) Зависимости.
if [ ! -d node_modules ]; then
  echo "▸ Ставлю зависимости (npm install)…"
  npm install
fi

# 2) Сборка (если нет dist или передан --build).
if [ ! -d dist ] || [ "$1" = "--build" ] || [ "$1" = "-b" ]; then
  echo "▸ Собираю приложение (npm run build)…"
  npm run build
fi

# 3) Открывалка URL под текущую платформу.
open_url() {
  if command -v termux-open-url >/dev/null 2>&1; then
    termux-open-url "$1"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$1" >/dev/null 2>&1 || true
  elif command -v open >/dev/null 2>&1; then
    open "$1" || true
  else
    echo "  Откройте вручную: $1"
  fi
}

# 4) Поднимаем статический сервер (vite preview) и открываем адрес.
echo "▸ Запускаю сервер на ${URL}"
echo "  (первый раз — установите как приложение: см. launcher/README.md)"
( sleep 2; open_url "$URL" ) &
exec npx vite preview --host 127.0.0.1 --port "$PORT" --strictPort
