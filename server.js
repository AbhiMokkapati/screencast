const express = require('express');
const http    = require('http');
const path    = require('path');
const os      = require('os');

const { createTransport }                     = require('./src/transport');
const { startCapture }                        = require('./src/capture');
const { handleInput, setMonitorContext }      = require('./src/input');
const { listMonitors, checkVirtualDisplayDriver, addVirtualMonitor, getSetupGuide } = require('./src/display');

// Load config file written by install.ps1, with env vars as overrides
let fileConfig = {};
try {
  fileConfig = JSON.parse(require('fs').readFileSync(
    require('path').join(__dirname, 'screencast.config.json'), 'utf8'
  ));
} catch { /* no config file yet — use defaults */ }

const PORT    = parseInt(process.env.PORT    || fileConfig.port    || '9001');
const MONITOR = parseInt(process.env.MONITOR || (fileConfig.monitor ?? 1));
const FPS     = parseInt(process.env.FPS     || fileConfig.fps     || '30');
const QUALITY = parseInt(process.env.QUALITY || fileConfig.quality || '5');
const SCALE_W = process.env.SCALE_W ? parseInt(process.env.SCALE_W) : (fileConfig.scaleW || undefined);
const SCALE_H = process.env.SCALE_H ? parseInt(process.env.SCALE_H) : (fileConfig.scaleH || undefined);

// ─── App setup ────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'client')));

// ─── REST API ─────────────────────────────────────────────────────────────────
app.get('/api/displays', (_req, res) => {
  try {
    const monitors     = listMonitors();
    const driverVer    = checkVirtualDisplayDriver();
    const setupGuide   = driverVer ? null : getSetupGuide();
    res.json({ monitors, driverInstalled: !!driverVer, driverVersion: driverVer, setupGuide });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/displays/add', async (req, res) => {
  const { width = 1920, height = 1080, refreshRate = 60 } = req.body || {};
  const result = await addVirtualMonitor({ width, height, refreshRate });
  res.json(result);
});

// ─── WebSocket transport ──────────────────────────────────────────────────────
const { broadcast, onClientMessage } = createTransport(server);

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
  ips.forEach((ip) => console.log(`│    http://${ip}:${PORT}`.padEnd(53) + '│'));
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
