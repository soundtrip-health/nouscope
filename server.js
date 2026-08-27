/**
 * server.js — minimal production static server for dist/ (no dependencies).
 *
 * Run `npm run build && npm start`, then point the Cloudflare tunnel (or any
 * reverse proxy) at http://127.0.0.1:8080. Override with PORT / HOST env vars.
 *
 * Do NOT serve the Vite dev server (`npm run dev`) through the tunnel:
 * Cloudflare's edge caches by file extension, and the dev server serves raw
 * source modules at stable `.js` URLs (/src/js/App.js …), so browsers end up
 * running stale edge-cached modules against fresh HTML. The production build
 * is immune — every asset filename carries a content hash, which is what the
 * cache headers below rely on:
 *   /assets/*  → immutable, cache for a year (a new build means new filenames)
 *   the rest   → no-cache (revalidate every time, ETag keeps 304s cheap)
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist')
const PORT = Number(process.env.PORT) || 8080
const HOST = process.env.HOST || '127.0.0.1'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end()
    return
  }

  // Strip the query string, decode, and resolve inside ROOT only.
  let urlPath
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  } catch {
    res.writeHead(400).end('Bad request')
    return
  }
  if (urlPath.endsWith('/')) urlPath += 'index.html'
  const filePath = path.join(ROOT, urlPath)
  if (!filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end('Forbidden')
    return
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found')
      return
    }

    const etag = `"${stat.size}-${stat.mtimeMs}"`
    const immutable = urlPath.startsWith('/assets/')
    const headers = {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      ETag: etag,
    }

    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers).end()
      return
    }

    headers['Content-Length'] = stat.size
    res.writeHead(200, headers)
    if (req.method === 'HEAD') { res.end(); return }
    fs.createReadStream(filePath).pipe(res)
  })
})

server.listen(PORT, HOST, () => {
  console.log(`nouscope: serving ${ROOT} at http://${HOST}:${PORT}`)
})
