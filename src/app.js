const express = require('express');
const http    = require('http');
const path    = require('path');
const crypto  = require('crypto');

const { createTransport } = require('./transport');

const ok = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;

/**
 * Builds the HTTP + WebSocket server with all access control wired in.
 * Everything with side effects (display listing, input injection) is injected so the
 * wiring can be tested without PowerShell, ffmpeg or a real display.
 */
function createApp({ token, display, handleInput, clientDir }) {
  const TOKEN = token || crypto.randomBytes(16).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(TOKEN).digest();

  function tokenOk(candidate) {
    if (typeof candidate !== 'string') return false;
    return crypto.timingSafeEqual(crypto.createHash('sha256').update(candidate).digest(), tokenHash);
  }

  function tokenFromUrl(url) {
    try { return new URL(url, 'http://x').searchParams.get('t'); } catch { return null; }
  }

  // Reject cross-site WebSocket hijacking: a browser Origin must match the Host.
  function originOk(req) {
    const origin = req.headers.origin;
    if (!origin) return true; // non-browser client
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
  }

  function verifyClient({ req }) {
    return originOk(req) && tokenOk(tokenFromUrl(req.url));
  }

  const app    = express();
  const server = http.createServer(app);

  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
    next();
  });

  // Auth runs BEFORE body parsing so unauthenticated callers cannot reach the parser.
  app.use('/api', (req, res, next) => {
    const supplied = req.get('x-screencast-token') || tokenFromUrl(req.url);
    if (!originOk(req) || !tokenOk(supplied)) return res.status(401).json({ error: 'unauthorized' });
    next();
  });
  app.use('/api', express.json({ limit: '10kb' }));

  app.use(express.static(clientDir || path.join(__dirname, '..', 'client')));

  app.get('/api/displays', (_req, res) => {
    try {
      const monitors   = display.listMonitors();
      const driverVer  = display.checkVirtualDisplayDriver();
      const setupGuide = driverVer ? null : display.getSetupGuide();
      res.json({ monitors, driverInstalled: !!driverVer, driverVersion: driverVer, setupGuide });
    } catch (err) {
      console.error('[api] /api/displays failed:', err.message);
      res.status(500).json({ error: 'failed to list displays' });
    }
  });

  app.post('/api/displays/add', async (req, res) => {
    const { width = 1920, height = 1080, refreshRate = 60 } = req.body || {};
    if (!ok(width, 320, 8192) || !ok(height, 240, 8192) || !ok(refreshRate, 24, 240)) {
      return res.status(400).json({ ok: false, message: 'invalid width/height/refreshRate' });
    }
    try {
      res.json(await display.addVirtualMonitor({ width, height, refreshRate }));
    } catch (err) {
      console.error('[api] /api/displays/add failed:', err.message);
      res.status(500).json({ ok: false, message: 'failed to add monitor' });
    }
  });

  // Never leak stack traces / file paths (Express's default handler does outside production).
  app.use((err, _req, res, _next) => {
    const status = err.status >= 400 && err.status < 500 ? err.status : 500;
    res.status(status).json({ error: status === 500 ? 'internal error' : 'bad request' });
  });

  const { broadcast, onClientMessage } = createTransport(server, { verifyClient });

  onClientMessage((msg, replyFn) => {
    try {
      const event = JSON.parse(msg);
      if (!event || typeof event !== 'object') return;
      if (event.type === 'ping') {
        replyFn(JSON.stringify({ type: 'pong' }));
        return;
      }
      handleInput(event);
    } catch {
      // ignore malformed
    }
  });

  return { app, server, broadcast, token: TOKEN, tokenOk };
}

/**
 * Listen on all interfaces, IPv6 included. The USB tunnel (usb-forward.bat) hands the iPad
 * an IPv6 address, which an IPv4-only 0.0.0.0 listener never answers. '::' is dual-stack on
 * Windows/Linux; fall back to IPv4 where IPv6 is unavailable.
 */
function listenAll(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      if (err.code === 'EAFNOSUPPORT' || err.code === 'EADDRNOTAVAIL') {
        server.once('error', reject);
        server.listen(port, '0.0.0.0', () => { server.removeListener('error', reject); resolve(server.address().port); });
      } else reject(err);
    };
    server.once('error', onError);
    server.listen(port, '::', () => { server.removeListener('error', onError); resolve(server.address().port); });
  });
}

module.exports = { createApp, listenAll };
