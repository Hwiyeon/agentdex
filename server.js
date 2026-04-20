'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const http = require('http');
const EventEmitter = require('events');
const { POKEAPI_SPRITES_DIR, spriteCandidatesIn } = require('./paths');
const { buildPublicSnapshot } = require('./snapshotPayload');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml; charset=utf-8'
};

class DashboardServer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.host = options.host || '127.0.0.1';
    this.port = options.port || 8123;
    this.publicDir = path.resolve(options.publicDir || path.join(process.cwd(), 'public'));
    this.state = options.state;
    this.publicConfig = options.publicConfig || {};
    this.onHardReset = typeof options.onHardReset === 'function' ? options.onHardReset : null;

    this.clients = new Set();
    this.server = null;
    this.keepAliveTimer = null;
    this.onStateUpdate = this.handleStateUpdate.bind(this);
  }

  async start() {
    if (!this.state) {
      throw new Error('DashboardServer requires a state object');
    }

    this.state.on('update', this.onStateUpdate);

    this.server = http.createServer((req, res) => {
      this.route(req, res).catch((error) => {
        this.emit('warn', `request failed: ${error.message}`);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
        }
        res.end(JSON.stringify({ error: 'Internal server error' }));
      });
    });

    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, resolve);
    });

    this.keepAliveTimer = setInterval(() => {
      this.broadcastComment('keep-alive');
    }, 20000);
    this.keepAliveTimer.unref();

    this.emit('info', `dashboard listening on http://${this.host}:${this.port}`);
  }

  async stop() {
    this.state.off('update', this.onStateUpdate);

    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }

    for (const res of this.clients) {
      try {
        res.end();
      } catch (error) {
        // Ignore.
      }
    }
    this.clients.clear();

    if (!this.server) {
      return;
    }

    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
  }

  snapshotPayload() {
    return buildPublicSnapshot(this.state, this.publicConfig);
  }

  handleStateUpdate() {
    this.broadcast('state', this.snapshotPayload());
  }

  broadcast(eventName, data) {
    const body = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) {
      res.write(body);
    }
  }

  broadcastComment(comment) {
    for (const res of this.clients) {
      res.write(`: ${comment}\n\n`);
    }
  }

  async route(req, res) {
    const parsed = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = parsed.pathname || '/';

    if (pathname === '/events') {
      this.handleSse(req, res);
      return;
    }

    if (pathname === '/api/state') {
      this.sendJson(res, 200, this.snapshotPayload());
      return;
    }

    if (pathname.startsWith('/api/box/') && req.method === 'POST') {
      const agentId = decodeURIComponent(pathname.slice('/api/box/'.length));
      const ok = this.state.manualBox(agentId);
      this.sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'Agent not found' });
      return;
    }

    if (pathname.startsWith('/api/unbox/') && req.method === 'POST') {
      const agentId = decodeURIComponent(pathname.slice('/api/unbox/'.length));
      const ok = this.state.manualUnbox(agentId);
      this.sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'Boxed agent not found' });
      return;
    }

    if (pathname === '/api/hard-reset' && req.method === 'POST') {
      if (!this.onHardReset) {
        this.sendJson(res, 404, { error: 'Hard reset unavailable' });
        return;
      }
      this.onHardReset();
      this.sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname === '/') {
      await this.serveStatic('/index.html', res);
      return;
    }

    if (pathname === '/app.js' || pathname === '/style.css') {
      await this.serveStatic(pathname, res);
      return;
    }

    if (pathname.startsWith('/data/')) {
      const safeName = path.basename(pathname);
      const dataPath = path.join(process.cwd(), 'data', safeName);
      try {
        const buf = await fsp.readFile(dataPath);
        const ext = path.extname(safeName).toLowerCase();
        res.statusCode = 200;
        res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(buf);
        return;
      } catch (_) {
        this.sendJson(res, 404, { error: 'Not found' });
        return;
      }
    }

    if (pathname.startsWith('/sprites/')) {
      await this.serveSprite(pathname, res);
      return;
    }

    this.sendJson(res, 404, { error: 'Not found' });
  }

  handleSse(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });

    this.clients.add(res);

    const payload = this.snapshotPayload();
    res.write(`event: state\ndata: ${JSON.stringify(payload)}\n\n`);

    req.on('close', () => {
      this.clients.delete(res);
    });
  }

  sendJson(res, statusCode, obj) {
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(obj));
  }

  async serveStatic(requestPath, res) {
    const cleaned = requestPath.replace(/^\/+/, '');
    const safePath = path.normalize(cleaned).replace(/^(\.\.(\/|\\|$))+/, '');
    const absolutePath = path.join(this.publicDir, safePath);

    if (!absolutePath.startsWith(this.publicDir)) {
      this.sendJson(res, 403, { error: 'Forbidden' });
      return;
    }

    let fileBuffer;
    try {
      fileBuffer = await fsp.readFile(absolutePath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.sendJson(res, 404, { error: 'Not found' });
        return;
      }
      throw error;
    }

    const ext = path.extname(absolutePath).toLowerCase();
    res.statusCode = 200;
    res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.end(fileBuffer);
  }

  async serveSprite(requestPath, res) {
    const cleaned = requestPath.replace(/^\/+/, '');
    const parts = cleaned.split('/');

    if (parts.length === 3 && parts[0] === 'sprites' && (parts[1] === 'static' || parts[1] === 'animated' || parts[1] === 'icon' || parts[1] === 'icon-static')) {
      const kind = parts[1];
      const safeName = path.basename(parts[2]);
          const candidates = spriteCandidatesIn(POKEAPI_SPRITES_DIR, kind, safeName);

      for (const absolutePath of candidates) {
        try {
          const fileBuffer = await fsp.readFile(absolutePath);
          const ext = path.extname(absolutePath).toLowerCase();
          res.statusCode = 200;
          res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.end(fileBuffer);
          return;
        } catch (error) {
          if (error.code !== 'ENOENT') {
            throw error;
          }
        }
      }

      this.sendJson(res, 404, { error: 'Not found' });
      return;
    }

    await this.serveStatic(requestPath, res);
  }
}

module.exports = {
  DashboardServer
};
