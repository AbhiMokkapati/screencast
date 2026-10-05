const express = require('express');
const http    = require('http');
const path    = require('path');
const os      = require('os');
const crypto  = require('crypto');

const { createTransport }                     = require('./src/transport');
const { startCapture }                        = require('./src/capture');
const { handleInput, setMonitorContext }      = require('./src/input');
const { listMonitors, checkVirtualDisplayDriver, addVirtualMonitor, getSetupGuide } = require('./src/display');

// Load config file written by install.ps1, with env vars as overrides
const fileConfig = require('./src/config').loadConfig(__dirname);

const PORT    = parseInt(process.env.PORT    || fileConfig.port    || '9001');
const MONITOR = parseInt(process.env.MONITOR || (fileConfig.monitor ?? 1));
const FPS     = parseInt(process.env.FPS     || fileConfig.fps     || '30');
const QUALITY = parseInt(process.env.QUALITY || fileConfig.quality || '5');
const SCALE_W = process.env.SCALE_W ? parseInt(process.env.SCALE_W) : (fileConfig.scaleW || undefined);
const SCALE_H = process.env.SCALE_H ? parseInt(process.env.SCALE_H) : (fileConfig.scaleH || undefined);

// ─── App setup ────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

// ─── Access control ───────────────────────────────────────────────────────────
// The server exposes the screen and injects mouse/keyboard input, so every API
// and WebSocket connection must present a secret token. The token comes from
// SCREENCAST_TOKEN (or config) or is generated randomly on each start and is
// included in the URL printed to the console.
const TOKEN = process.env.SCREENCAST_TOKEN || fileConfig.token || crypto.randomBytes(16).toString('hex');

function tokenOk(candidate) {
  if (typeof candidate !== 'string') return false;
  const a = crypto.createHash('sha256').update(candidate).digest();
  const b = crypto.createHash('sha256').update(TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
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

app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
  next();
});
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'client')));

app.use('/api', (req, res, next) => {
  const supplied = req.get('x-screencast-token') || tokenFromUrl(req.url);
  if (!originOk(req) || !tokenOk(supplied)) return res.status(401).json({ error: 'unauthorized' });
  next();
});

// ─── REST API ─────────────────────────────────────────────────────────────────
app.get('/api/displays', (_req, res) => {
  try {
    const monitors     = listMonitors();
    const driverVer    = checkVirtualDisplayDriver();
    const setupGuide   = driverVer ? null : getSetupGuide();
    res.json({ monitors, driverInstalled: !!driverVer, driverVersion: driverVer, setupGuide });
  } catch (err) {
    console.error('[api] /api/displays failed:', err.message);
    res.status(500).json({ error: 'failed to list displays' });
  }
});

app.post('/api/displays/add', async (req, res) => {
  const { width = 1920, height = 1080, refreshRate = 60 } = req.body || {};
  const ok = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;
  if (!ok(width, 320, 8192) || !ok(height, 240, 8192) || !ok(refreshRate, 24, 240)) {
    return res.status(400).json({ ok: false, message: 'invalid width/height/refreshRate' });
  }
  const result = await addVirtualMonitor({ width, height, refreshRate });
  res.json(result);
});

// ─── WebSocket transport ──────────────────────────────────────────────────────
const { broadcast, onClientMessage } = createTransport(server, { verifyClient });

onClientMessage((msg, replyFn) => {
  try {
    const event = JSON.parse(msg);
    if (event.type === 'ping') {
      replyFn(JSON.stringify({ type: 'pong' }));
      return;
    }
    handleInput(event);
  } catch {
    // ignore malformed
  }
});

// ─── Screen capture ───────────────────────────────────────────────────────────
let capture;
try {
  capture = startCapture({ monitorIndex: MONITOR, fps: FPS, quality: QUALITY, scaleWidth: SCALE_W, scaleHeight: SCALE_H });
} catch (err) {
  console.error('[capture] Failed to start:', err.message);
  console.error('          Run `npm run list-displays` to see available monitors.');
  process.exit(1);
}

setMonitorContext(capture.monitorBounds);

capture.on('frame',  broadcast);
capture.on('error', (err) => console.error('[capture]', err.message));

// ─── Start ────────────────────────────────────────────────────────────────────
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[error] Port ${PORT} is already in use — another instance is running.`);
    console.error(`        Run:  npm run kill-port   then try again.\n`);
    capture.stop();
    stopDaemon();
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);

  console.log('\n┌─ ScreenCast ─────────────────────────────────────────┐');
  console.log(`│  Monitor : ${MONITOR}   FPS : ${FPS}   Quality : ${QUALITY}              │`);
  console.log('│                                                      │');
  console.log('│  Open on iPad Safari:                                │');
  ips.forEach((ip) => console.log(`│    http://${ip}:${PORT}/?t=${TOKEN}`.padEnd(53) + '│'));
  console.log('└──────────────────────────────────────────────────────┘\n');

  // Warn if the requested monitor doesn't exist
  try {
    const mons = listMonitors();
    if (MONITOR >= mons.length) {
      console.warn(`⚠  MONITOR=${MONITOR} but only ${mons.length} display(s) detected.`);
      console.warn('   Available monitors:');
      mons.forEach((m) => console.warn(`     ${m.index}: ${m.w}×${m.h}${m.primary ? ' (primary)' : ''}`));
      console.warn('   Set MONITOR=<index> before running.\n');
    }
  } catch { /* non-fatal */ }
});

const { stopDaemon } = require('./src/input');

process.on('SIGINT', () => {
  capture.stop();
  stopDaemon();
  process.exit(0);
});
