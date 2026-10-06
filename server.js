const os = require('os');

const { startCapture }                    = require('./src/capture');
const { handleInput, setMonitorContext, startDaemon, stopDaemon } = require('./src/input');
const display                             = require('./src/display');
const { loadConfig, resolveSettings }     = require('./src/config');
const { createApp, listenAll }            = require('./src/app');

// Config file written by install.ps1, with env vars as overrides
const { port: PORT, monitor: MONITOR, fps: FPS, quality: QUALITY, scaleW: SCALE_W, scaleH: SCALE_H, token } =
  resolveSettings(process.env, loadConfig(__dirname));

// The server exposes the screen and injects mouse/keyboard input, so every API and
// WebSocket connection must present a secret token (SCREENCAST_TOKEN, config, or a random
// one per start) which is included in the URL printed below.
const { server, broadcast, token: TOKEN } = createApp({ token, display, handleInput });

// ─── Screen capture ───────────────────────────────────────────────────────────
let capture;
try {
  capture = startCapture({ monitorIndex: MONITOR, fps: FPS, quality: QUALITY, scaleWidth: SCALE_W, scaleHeight: SCALE_H });
} catch (err) {
  console.error('[capture] Failed to start:', err.message);
  console.error('          Run `npm run list-displays` to see available monitors.');
  process.exit(1);
}

startDaemon();
setMonitorContext(capture.monitorBounds);

capture.on('frame',  broadcast);
capture.on('error', (err) => console.error('[capture]', err.message));

function shutdown() {
  capture.stop();
  stopDaemon();
}
process.on('exit', shutdown); // also covers process.exit() after errors
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(sig, () => process.exit(0));

// ─── Start ────────────────────────────────────────────────────────────────────
listenAll(server, PORT).then(() => {
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
}, (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[error] Port ${PORT} is already in use — another instance is running.`);
    console.error('        Run:  npm run kill-port   then try again.\n');
  } else {
    console.error('[error] Could not start server:', err.message);
  }
  process.exit(1);
});
