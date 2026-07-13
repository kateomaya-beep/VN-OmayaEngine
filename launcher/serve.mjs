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
import { readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '..', 'dist');
const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || '127.0.0.1';

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

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
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
  console.log(`▸ VN Studio: http://localhost:${PORT}/  (статика + локальный прокси /__proxy — без CORS)`);
  if (!existsSync(path.join(DIST, 'index.html'))) {
    console.warn('  ⚠ dist/index.html не найден — сначала соберите приложение (npm run build).');
  }
});
