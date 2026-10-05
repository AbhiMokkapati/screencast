const { WebSocketServer } = require('ws');

const PING_INTERVAL_MS  = 20_000;  // ping every 20s
const PONG_TIMEOUT_MS   =  8_000;  // kill if no pong within 8s
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024; // 2 MB — drop frame if client is behind

function createTransport(httpServer) {
  const wss = new WebSocketServer({ server: httpServer });
  const clients = new Set();
  let messageHandler = null;

  wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    console.log(`[ws] client connected: ${ip}  (total: ${clients.size + 1})`);
    clients.add(ws);

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

    // Give the first pong a longer window (client may be slow to load)
    setTimeout(() => { alive = true; }, PONG_TIMEOUT_MS);

    ws.on('pong', () => { alive = true; });

    ws.on('message', (data) => {
      if (messageHandler) {
        const reply = (msg) => {
          if (ws.readyState === 1) ws.send(msg);
        };
        messageHandler(data.toString(), reply);
      }
    });

    ws.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(ws);
      console.log(`[ws] client disconnected: ${ip}  (total: ${clients.size})`);
    });

    ws.on('error', (err) => {
      clearInterval(heartbeat);
      console.error(`[ws] error from ${ip}:`, err.message);
      clients.delete(ws);
    });
  });

  // ── Broadcast ─────────────────────────────────────────────────────────────
  function broadcast(buffer) {
    for (const ws of clients) {
      if (ws.readyState !== 1 /* OPEN */) continue;

      // Backpressure: skip frame if client's send buffer is too full.
      // This prevents slow WiFi clients from causing memory growth and
      // eventual socket death.
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) continue;

      ws.send(buffer, { binary: true }, (err) => {
        if (err) clients.delete(ws);
      });
    }
  }

  function onClientMessage(fn) {
    messageHandler = fn;
  }

  return { broadcast, onClientMessage };
}

module.exports = { createTransport };
