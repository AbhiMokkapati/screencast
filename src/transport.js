const { WebSocketServer } = require('ws');

const PING_INTERVAL_MS  = 20_000;  // ping every 20s
const ACK_TIMEOUT_MS    = 1000;    // a client that stops acking (old client / stalled) is un-gated after this
const ACK_MSG           = JSON.stringify({ type: 'ack' });
const KEYFRAME_MSG      = JSON.stringify({ type: 'keyframe' }); // client lost sync and wants the next key frame

// JPEG: every frame stands alone, so a slow client just skips to the newest.
const JPEG_MAX_BUFFERED  = 512 * 1024;
const JPEG_MAX_IN_FLIGHT = 2;
// H.264: frames depend on earlier ones, so dropping one corrupts the picture until the next key
// frame. A slow client is therefore cut off until the next key frame instead of skipping frames.
const VIDEO_MAX_BUFFERED  = 1024 * 1024;
const VIDEO_MAX_IN_FLIGHT = 8;

function createTransport(httpServer, { verifyClient } = {}) {
  const wss = new WebSocketServer({ server: httpServer, verifyClient, maxPayload: 64 * 1024 });
  // ws re-emits the HTTP server's errors (e.g. EADDRINUSE) on the wss; with no listener that
  // throws, pre-empting the caller's own server 'error' handling.
  wss.on('error', (err) => console.error('[ws] server error:', err.message));
  const clients = new Set();
  // Per-client flow control: ws -> { inFlight, since, sentLatest, needKey }.
  const flow = new Map();
  let latest = null;        // newest JPEG frame
  let videoConfig = null;   // current avcC config message
  let messageHandler = null;

  function drop(ws) { clients.delete(ws); flow.delete(ws); }

  function sendFrame(ws, f, buffer) {
    f.inFlight++;
    f.since = Date.now();
    f.sentLatest = true;
    ws.send(buffer, { binary: true }, (err) => { if (err) drop(ws); });
  }

  wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    console.log(`[ws] client connected: ${ip}  (total: ${clients.size + 1})`);
    clients.add(ws);
    const f = { inFlight: 0, since: 0, sentLatest: true, needKey: true };
    flow.set(ws, f);
    try { ws._socket.setNoDelay(true); } catch { /* not a real socket */ }
    // A static screen produces no new JPEG frames; give a fresh client the current picture right away.
    if (latest) sendFrame(ws, f, latest);
    if (videoConfig) ws.send(videoConfig, { binary: true });

    // ── Keepalive heartbeat ───────────────────────────────────────────────────
    let alive = true;
    const heartbeat = setInterval(() => {
      if (!alive) {
        console.warn(`[ws] client ${ip} missed pong — terminating`);
        clearInterval(heartbeat);
        ws.terminate();
        return;
      }
      alive = false;
      if (ws.readyState === 1) ws.ping();
    }, PING_INTERVAL_MS);

    ws.on('pong', () => { alive = true; });

    ws.on('message', (data) => {
      const text = data.toString();
      if (text === ACK_MSG) {
        f.inFlight = Math.max(0, f.inFlight - 1);
        if (!f.sentLatest && latest) sendFrame(ws, f, latest);
        return;
      }
      if (text === KEYFRAME_MSG) { f.needKey = true; f.inFlight = 0; return; }
      if (messageHandler) {
        const reply = (msg) => {
          if (ws.readyState === 1) ws.send(msg);
        };
        // A throwing handler must not become an uncaught exception that kills the server.
        try { messageHandler(text, reply); } catch (err) { console.error('[ws] handler error:', err.message); }
      }
    });

    const connectedAt = Date.now();
    ws.on('close', (code, reason) => {
      clearInterval(heartbeat);
      drop(ws);
      const secs = ((Date.now() - connectedAt) / 1000).toFixed(1);
      console.log(`[ws] client disconnected: ${ip}  code ${code}${reason && reason.length ? ` "${reason}"` : ''} after ${secs}s  (total: ${clients.size})`);
    });

    ws.on('error', (err) => {
      clearInterval(heartbeat);
      console.error(`[ws] error from ${ip}:`, err.message);
      drop(ws);
    });
  });

  // ── Broadcast ─────────────────────────────────────────────────────────────
  /** JPEG frame: the newest frame wins; a client that is behind simply misses frames. */
  function broadcast(buffer) {
    // Unchanged screen => identical JPEG. Re-sending it only burns bandwidth and adds queueing.
    if (latest && latest.equals(buffer)) return;
    latest = buffer;
    const now = Date.now();
    for (const ws of clients) {
      if (ws.readyState !== 1 /* OPEN */) continue;
      const f = flow.get(ws);
      if (!f) continue;
      f.sentLatest = false;
      if (f.inFlight >= JPEG_MAX_IN_FLIGHT && now - f.since > ACK_TIMEOUT_MS) f.inFlight = 0;
      if (f.inFlight >= JPEG_MAX_IN_FLIGHT) continue;   // wait for an ack; newest frame goes out then
      if (ws.bufferedAmount > JPEG_MAX_BUFFERED) continue;
      sendFrame(ws, f, latest);
    }
  }

  /** Set (or change) the H.264 decoder config; sent to every client now and to new ones on connect. */
  function setVideoConfig(message) {
    if (videoConfig && videoConfig.equals(message)) return;
    videoConfig = message;
    for (const ws of clients) {
      if (ws.readyState === 1) ws.send(message, { binary: true });
      const f = flow.get(ws);
      if (f) f.needKey = true; // a new config invalidates the decoder state
    }
  }

  /** One H.264 picture. A client that falls behind is held until the next key frame. */
  function broadcastVideo(buffer, isKey) {
    const now = Date.now();
    for (const ws of clients) {
      if (ws.readyState !== 1) continue;
      const f = flow.get(ws);
      if (!f) continue;
      if (f.inFlight >= VIDEO_MAX_IN_FLIGHT && now - f.since > ACK_TIMEOUT_MS) f.inFlight = 0;
      if (f.needKey && !isKey) continue;
      if (f.inFlight >= VIDEO_MAX_IN_FLIGHT || ws.bufferedAmount > VIDEO_MAX_BUFFERED) {
        f.needKey = true; // can't keep up: skip to the next key frame rather than corrupt the picture
        continue;
      }
      f.needKey = false;
      sendFrame(ws, f, buffer);
    }
  }

  function onClientMessage(fn) {
    messageHandler = fn;
  }

  return { broadcast, broadcastVideo, setVideoConfig, onClientMessage };
}

module.exports = { createTransport };
