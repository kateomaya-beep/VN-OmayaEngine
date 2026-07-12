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

# 1) Обновление кода (если это git-репозиторий и нет локальных правок) — чтобы
#    «запустил лаунчер» = «получил свежую версию». При наличии своих изменений
#    НЕ трогаем, просто предупреждаем.
if [ "$NO_PULL" != "1" ] && command -v git >/dev/null 2>&1 && [ -d .git ]; then
  if [ -z "$(git status --porcelain 2>/dev/null)" ]; then
    echo "▸ Обновляю код (git pull)…"
    git pull --ff-only 2>/dev/null || echo "  (не удалось обновить — продолжаю на текущей версии)"
  else
    echo "  ⚠ Есть локальные изменения — пропускаю git pull."
  fi
fi

# 2) Зависимости.
if [ ! -d node_modules ]; then
  echo "▸ Ставлю зависимости (npm install)…"
  npm install
fi

# 3) Сборка. ВАЖНО: пересобираем, если исходники НОВЕЕ, чем dist (иначе после
#    обновления кода лаунчер показал бы старую сборку — «вроде ничего не изменилось»).
NEED_BUILD=0
if [ ! -f dist/index.html ]; then
  NEED_BUILD=1
elif [ -n "$(find src public index.html vite.config.ts package.json -newer dist/index.html -print -quit 2>/dev/null)" ]; then
  NEED_BUILD=1
fi
if [ "$1" = "--build" ] || [ "$1" = "-b" ] || [ "$NEED_BUILD" = "1" ]; then
  echo "▸ Собираю приложение (npm run build)…"
  npm run build
else
  echo "▸ Сборка актуальна — пропускаю build."
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
