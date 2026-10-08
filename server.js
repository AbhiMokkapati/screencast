const os   = require('os');
const qrcode = require('qrcode-terminal');
const path = require('path');

const { startCapture }                    = require('./src/capture');
const { handleInput, setMonitorContext, startDaemon, stopDaemon } = require('./src/input');
const display                             = require('./src/display');
const { loadConfig, resolveSettings }     = require('./src/config');
const { createApp, listenAll }            = require('./src/app');
const { ensureTls, createCaServer }       = require('./src/tls');
const { pickEncoder }                     = require('./src/encoder');

// Config file written by install.ps1, with env vars as overrides
const settings = resolveSettings(process.env, loadConfig(__dirname));
const { port: PORT, monitor: MONITOR, fps: FPS, quality: QUALITY, scaleW: SCALE_W, scaleH: SCALE_H, token } = settings;

// ─── Codec / HTTPS ────────────────────────────────────────────────────────────
// H.264 is decoded in Safari with WebCodecs, which only exists on secure (HTTPS) pages.
let codec = settings.codec;
let encoder = null;
if (codec === 'h264' && !settings.https) {
  if (settings.codecExplicit) {
    // localhost counts as a secure context, so this is still useful for local testing
    console.warn('[codec] https is off: only a browser on this PC (localhost) can decode h264');
  } else {
    console.warn('[codec] h264 needs HTTPS (https is off): falling back to mjpeg');
    codec = 'mjpeg';
  }
}
if (codec === 'h264') {
  encoder = pickEncoder(settings.encoder);
  if (!encoder) {
    console.warn('[codec] no working H.264 encoder found in ffmpeg: falling back to mjpeg');
    codec = 'mjpeg';
  }
}
let tls = null;
if (settings.https) {
  try {
    tls = ensureTls(path.join(__dirname, 'certs'));
  } catch (err) {
    console.error('[tls] could not set up HTTPS:', err.message);
    if (codec === 'h264') { console.warn('[codec] falling back to mjpeg over plain HTTP'); codec = 'mjpeg'; }
  }
}
const SCHEME = tls ? 'https' : 'http';

// The server exposes the screen and injects mouse/keyboard input, so every API and
// WebSocket connection must present a secret token (SCREENCAST_TOKEN, config, or a random
// one per start) which is included in the URL printed below.
const { server, broadcast, broadcastVideo, setVideoConfig, token: TOKEN } = createApp({ token, display, handleInput, tls });

// ─── Screen capture ───────────────────────────────────────────────────────────
let capture;
try {
  capture = startCapture({ monitorIndex: MONITOR, fps: FPS, quality: QUALITY, scaleWidth: SCALE_W, scaleHeight: SCALE_H,
    codec, encoder, bitrateMbps: settings.bitrate });
} catch (err) {
  console.error('[capture] Failed to start:', err.message);
  console.error('          Run `npm run list-displays` to see available monitors.');
  process.exit(1);
}

startDaemon();
setMonitorContext(capture.monitorBounds);

capture.on('frame',  broadcast);        // mjpeg
capture.on('config', setVideoConfig);   // h264
capture.on('video',  broadcastVideo);
capture.on('error', (err) => console.error('[capture]', err.message));

function shutdown() {
  capture.stop();
  stopDaemon();
}
process.on('exit', shutdown); // also covers process.exit() after errors
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(sig, () => process.exit(0));

// ─── Start ────────────────────────────────────────────────────────────────────
const CA_PORT = settings.caPort || PORT + 1;
let caServer = null;
if (tls) {
  caServer = createCaServer(tls.caDer);
  caServer.on('error', (err) => console.warn(`[tls] certificate download page unavailable on port ${CA_PORT}: ${err.message}`));
  listenAll(caServer, CA_PORT).catch(() => { /* already warned by the error handler */ });
}

const lanRank = (ip) => (/^(192\.168\.|10\.)/.test(ip) ? 0 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 1 : 2);

listenAll(server, PORT).then(() => {
  const ips = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i.family === 'IPv4' && !i.internal)
    .map((i) => i.address)
    .sort((a, b) => lanRank(a) - lanRank(b));

  const video = codec === 'h264' ? `h264 (${encoder}, ${settings.bitrate} Mbit/s)` : 'mjpeg';
  console.log('\n── ScreenCast ───────────────────────────────────────────');
  console.log(`  Monitor : ${MONITOR}   FPS : ${FPS}   Video : ${video}`);
  console.log('\n  Open on iPad Safari:');
  ips.forEach((ip) => console.log(`    ${SCHEME}://${ip}:${PORT}/?t=${TOKEN}`));
  if (ips.length) {
    // The QR code encodes the first URL (home-LAN addresses sorted first) so the iPad camera can open it.
    console.log('\n  Or scan with the iPad camera:');
    qrcode.generate(`${SCHEME}://${ips[0]}:${PORT}/?t=${TOKEN}`, { small: true }, (qr) => console.log(qr.replace(/^/gm, '    ')));
  }
  if (tls) {
    console.log('\n  First time on an iPad? Trust this PC once by opening:');
    ips.forEach((ip) => console.log(`    http://${ip}:${CA_PORT}/`));
    if (tls.created) console.log('  (A new local certificate authority was just created: every iPad must trust it again.)');
  }
  console.log('─────────────────────────────────────────────────────────\n');
}, (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[error] Port ${PORT} is already in use — another instance is running.`);
    console.error('        Run:  npm run kill-port   then try again.\n');
  } else {
    console.error('[error] Could not start server:', err.message);
  }
  process.exit(1);
});
