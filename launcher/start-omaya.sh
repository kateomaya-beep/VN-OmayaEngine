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
  # package-lock.json переписывает САМ npm install: на Android ставятся другие
  # платформенные пакеты, чем на машине разработчика. Правкой пользователя это
  # не является — это мусор установки. Раньше он намертво блокировал обновление:
  # дерево никогда не чистое ⇒ pull пропускается КАЖДЫЙ раз, и лаунчер тихо
  # оставался на старой версии, пока git pull вручную не упирался в конфликт.
  if [ -n "$(git status --porcelain -- package-lock.json 2>/dev/null)" ]; then
    echo "▸ package-lock.json переписан установкой — откатываю (файл генерируемый)."
    git checkout -- package-lock.json 2>/dev/null || true
  fi
  DIRTY="$(git status --porcelain 2>/dev/null)"
  if [ -z "$DIRTY" ]; then
    echo "▸ Обновляю код (git pull)…"
    git pull --ff-only 2>/dev/null || echo "  (не удалось обновить — продолжаю на текущей версии)"
  else
    # Показываем ЧТО именно мешает и как это снять: раньше строка «есть локальные
    # изменения» ничего не объясняла, и понять причину без git-опыта было нельзя.
    echo "  ⚠ Пропускаю git pull — в репозитории есть изменённые файлы:"
    echo "$DIRTY" | sed 's/^/     /'
    echo "     Если это не ваши правки, откатите всё:  git checkout -- ."
  fi
fi

# 2) Зависимости. Ставим не только когда их нет, но и когда package.json стал
#    новее последней установки: после обновления кода с новой зависимостью сборка
#    иначе падает с невнятной ошибкой про отсутствующий модуль.
NEED_INSTALL=0
if [ ! -d node_modules ]; then
  NEED_INSTALL=1
elif [ -f node_modules/.package-lock.json ] && [ package.json -nt node_modules/.package-lock.json ]; then
  NEED_INSTALL=1
fi
if [ "$NEED_INSTALL" = "1" ]; then
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

# 4) Поднимаем НАШ сервер: статика из dist + локальный прокси к провайдерам
#    (server-side запросы, без CORS — как в SillyTavern). Открываем адрес.
echo "▸ Запускаю сервер на ${URL} (со встроенным прокси /__proxy — без CORS)"
echo "  (первый раз — установите как приложение: см. launcher/README.md)"
( sleep 2; open_url "$URL" ) &

# ПРИСМОТР ЗА СЕРВЕРОМ. Раньше здесь стоял exec: сервер падал — и лаунчер вместе с
# ним, а игра оставалась открытой в браузере и просто переставала отвечать. Со
# стороны это «прокси отвалился», причём непонятно почему: окно терминала могло
# быть свёрнуто или вовсе закрыто (запуск ярлыком).
#
# Перезапускаем ТОЛЬКО если сервер успел проработать хотя бы 5 секунд. Упал сразу
# (занят порт, нет node, нет dist) — это не сбой, а неправильный запуск: повторять
# его бесконечно значит завалить экран одинаковой ошибкой и спрятать причину.
# Ctrl+C (код 130) — намеренный выход, тоже не перезапускаем.
set +e
while true; do
  STARTED_AT=$(date +%s)
  env PORT="$PORT" HOST=127.0.0.1 node "$ROOT/launcher/serve.mjs"
  CODE=$?
  RAN=$(( $(date +%s) - STARTED_AT ))
  if [ "$CODE" = "0" ] || [ "$CODE" = "130" ] || [ "$CODE" = "143" ]; then
    exit "$CODE"
  fi
  if [ "$RAN" -lt 5 ]; then
    echo ""
    echo "✖ Сервер не смог запуститься (код $CODE). Причина — выше этой строки."
    exit "$CODE"
  fi
  echo ""
  echo "⚠ Сервер остановился (код $CODE), проработав ${RAN} с. Поднимаю заново…"
  echo "  Игру в браузере перезагружать не нужно — следующий ход пойдёт как обычно."
  sleep 1
done
