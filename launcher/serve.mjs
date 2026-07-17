// VN Studio — локальный сервер лаунчера (zero-dependency).
// Раздаёт собранное приложение из ../dist И проксирует запросы к провайдерам ИИ
// на СТОРОНЕ СЕРВЕРА — как это делает SillyTavern. CORS — правило только для
// браузера; запрос «сервер→провайдер» под него не попадает, поэтому работает с
// любым провайдером (DeepSeek, нативный Gemini и т.д.), а не только с теми, кто
// отдаёт CORS-заголовки.
//
// Как использует приложение: вместо fetch(providerUrl) оно шлёт запрос на
// /__proxy с заголовком x-target-url: <providerUrl>. Сервер пересылает метод/тело/
// заголовки провайдеру и возвращает ответ. Всё локально (127.0.0.1), ключ дальше
// нашего же сервера не уходит.

import http from 'node:http';
import { readFile, writeFile, mkdir, rm, readdir, stat } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '..', 'dist');
const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || '127.0.0.1';

// Корень файлового хранилища (источник истины, как папка data/ у SillyTavern).
// Настраивается через DATA_ROOT; по умолчанию — рядом с проектом (переживает
// очистку данных браузера, виден в файловом менеджере).
const DATA_ROOT = process.env.DATA_ROOT
  ? path.resolve(process.env.DATA_ROOT)
  : path.resolve(HERE, '..', 'vn-data');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
};

// Заголовки, которые НЕ пересылаем провайдеру (host/тело считаем заново и т.п.).
const HOP_BY_HOP = new Set([
  'host', 'x-target-url', 'origin', 'referer', 'connection', 'content-length',
  'accept-encoding', 'cookie', 'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-dest',
]);

function handleProxy(req, res) {
  const target = req.headers['x-target-url'];
  if (typeof target !== 'string' || !/^https?:\/\//i.test(target)) {
    res.writeHead(400, { 'content-type': 'application/json', 'x-vn-proxy': '1' });
    return res.end(JSON.stringify({ error: 'bad_target', message: 'missing/invalid x-target-url' }));
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const body = Buffer.concat(chunks);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (HOP_BY_HOP.has(k.toLowerCase())) continue;
      headers[k] = v;
    }
    try {
      const upstream = await fetch(target, {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
      });
      const out = {};
      upstream.headers.forEach((v, k) => {
        const lk = k.toLowerCase();
        if (['content-encoding', 'content-length', 'transfer-encoding'].includes(lk)) return;
        out[k] = v;
      });
      out['access-control-allow-origin'] = '*';
      out['x-vn-proxy'] = '1';
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(upstream.status, out);
      res.end(buf);
    } catch (e) {
      res.writeHead(502, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'x-vn-proxy': '1' });
      res.end(JSON.stringify({ error: 'proxy_failed', message: String((e && e.message) || e) }));
    }
  });
}

async function serveStatic(pathname, res) {
  // Защита от обхода каталога.
  const rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  let file = path.resolve(DIST, rel);
  if (!file.startsWith(DIST)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  // SPA / hash-routing: нет файла → отдаём index.html.
  if (!rel || !existsSync(file) || statSync(file).isDirectory()) {
    file = path.join(DIST, 'index.html');
  }
  try {
    const data = await readFile(file);
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      // dist статика с хешами — можно кэшировать; index.html/sw — нет.
      'cache-control': /index\.html$|sw\.js$|\.webmanifest$/.test(file) ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}

// ---- Файловое хранилище (data API) ----
// Сервер «тупой»: generic чтение/запись файлов под DATA_ROOT/<projectId>/... .
// Декомпозицией Project↔файлы занимается клиент (src/storage/fileStore.ts).

function safeDataPath(rel) {
  // rel = "<projectId>/<relpath>" или "<projectId>". Запрещаем обход каталога.
  const clean = decodeURIComponent(rel).replace(/\\/g, '/').replace(/^\/+/, '');
  if (clean.split('/').some((seg) => seg === '..')) return null;
  const abs = path.resolve(DATA_ROOT, clean);
  if (abs !== DATA_ROOT && !abs.startsWith(DATA_ROOT + path.sep)) return null;
  return abs;
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

async function listTree(dir, base = '') {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listTree(path.join(dir, e.name), rel)));
    else out.push(rel);
  }
  return out;
}

async function handleData(req, res, url) {
  const p = url.pathname;
  const json = (code, obj, extra = {}) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'x-vn-data': '1', 'access-control-allow-origin': '*', ...extra });
    res.end(JSON.stringify(obj));
  };

  try {
    if (p === '/__data/health') return json(200, { ok: true, root: DATA_ROOT });

    if (p === '/__data/projects') {
      await mkdir(DATA_ROOT, { recursive: true });
      const entries = await readdir(DATA_ROOT, { withFileTypes: true });
      const ids = entries.filter((e) => e.isDirectory()).map((e) => e.name);
      return json(200, { ids });
    }

    // /__data/tree/<id>
    if (p.startsWith('/__data/tree/')) {
      const id = p.slice('/__data/tree/'.length);
      const dir = safeDataPath(id);
      if (!dir) return json(400, { error: 'bad_path' });
      return json(200, { files: await listTree(dir) });
    }

    // /__data/p/<id>  — удалить весь проект
    if (p.startsWith('/__data/p/') && req.method === 'DELETE') {
      const id = p.slice('/__data/p/'.length);
      const dir = safeDataPath(id);
      if (!dir) return json(400, { error: 'bad_path' });
      await rm(dir, { recursive: true, force: true });
      return json(200, { ok: true });
    }

    // /__data/f/<id>/<relpath>  — файл (GET/PUT/DELETE)
    if (p.startsWith('/__data/f/')) {
      const abs = safeDataPath(p.slice('/__data/f/'.length));
      if (!abs) return json(400, { error: 'bad_path' });
      if (req.method === 'GET') {
        try {
          const data = await readFile(abs);
          res.writeHead(200, { 'content-type': 'application/octet-stream', 'x-vn-data': '1', 'access-control-allow-origin': '*' });
          return res.end(data);
        } catch {
          return json(404, { error: 'not_found' });
        }
      }
      if (req.method === 'PUT') {
        const body = await readBody(req);
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, body);
        return json(200, { ok: true, size: body.length });
      }
      if (req.method === 'DELETE') {
        await rm(abs, { force: true });
        return json(200, { ok: true });
      }
    }

    return json(404, { error: 'unknown_endpoint' });
  } catch (e) {
    return json(500, { error: 'data_failed', message: String((e && e.message) || e) });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  if (url.pathname.startsWith('/__data/')) return handleData(req, res, url);
  if (url.pathname === '/__proxy/health') {
    res.writeHead(200, { 'content-type': 'application/json', 'x-vn-proxy': '1', 'access-control-allow-origin': '*' });
    return res.end('{"ok":true}');
  }
  if (url.pathname === '/__proxy') {
    // Префлайт (на случай другого origin) — разрешаем.
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': '*',
        'x-vn-proxy': '1',
      });
      return res.end();
    }
    return handleProxy(req, res);
  }
  return serveStatic(url.pathname, res);
});

server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.error(`\n✖ Порт ${PORT} уже занят. Закройте прошлый сервер или задайте PORT=<другой>.\n`);
  } else {
    console.error('Ошибка сервера:', e);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`▸ VN Studio: http://localhost:${PORT}/`);
  console.log(`  · прокси к ИИ: /__proxy (server-side, без CORS)`);
  console.log(`  · данные на диске: ${DATA_ROOT}  (переживают очистку данных браузера)`);
  if (!existsSync(path.join(DIST, 'index.html'))) {
    console.warn('  ⚠ dist/index.html не найден — сначала соберите приложение (npm run build).');
  }
});
