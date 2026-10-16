// PWA için HTTP (statik + API) ve WebSocket (canlı transkript)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { EventEmitter } from 'node:events';
import { config } from './config.js';

const WEB_DIR = path.resolve(new URL('../../web', import.meta.url).pathname);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || ''; // ör. https://ceviri.pages.dev
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

const failed = new Map(); // ip -> {n, until}
function tokenOk(given, ip) {
  const f = failed.get(ip);
  if (f && f.until > Date.now()) return false;
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(config.web.token);
  const ok = a.length === b.length && b.length > 0 && timingSafeEqual(a, b);
  if (!ok) {
    const n = (f?.n || 0) + 1;
    failed.set(ip, { n, until: n >= 5 ? Date.now() + 15 * 60 * 1000 : 0 });
  } else failed.delete(ip);
  return ok;
}

export class Web extends EventEmitter {
  constructor() {
    super();
    this.clients = new Set();
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url, 'http://x');
      const ip = req.socket.remoteAddress;
      if (!tokenOk(url.searchParams.get('token'), ip)) { socket.destroy(); return; }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.clients.add(ws);
        ws.on('close', () => this.clients.delete(ws));
        ws.on('message', (raw) => {
          try { this.emit('command', JSON.parse(raw.toString())); } catch {}
        });
        ws.send(JSON.stringify({ type: 'hello', ok: true }));
        this.emit('client');
      });
    });
  }

  listen() {
    this.server.listen(config.web.port, () => console.log('Web :' + config.web.port));
  }

  broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const c of this.clients) if (c.readyState === 1) c.send(s);
  }

  async handle(req, res) {
    const ip = req.socket.remoteAddress;
    const url = new URL(req.url, 'http://x');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (ALLOWED_ORIGIN) {
      res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    if (url.pathname.startsWith('/api/')) {
      const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!tokenOk(token, ip)) { res.writeHead(401); return res.end('{"error":"unauthorized"}'); }
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 10000) break; }
      let data = {};
      try { data = body ? JSON.parse(body) : {}; } catch {}
      res.setHeader('Content-Type', 'application/json');
      const result = await new Promise((resolve) => this.emit('api', { path: url.pathname, method: req.method, data, resolve }));
      res.writeHead(result?.status || 200);
      return res.end(JSON.stringify(result?.body ?? { ok: true }));
    }

    // Statik PWA
    let p = url.pathname === '/' ? '/index.html' : url.pathname;
    p = path.normalize(p).replace(/^(\.\.[/\\])+/, '');
    const file = path.join(WEB_DIR, p);
    if (!file.startsWith(WEB_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); return res.end('not found');
    }
    res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  }
}
