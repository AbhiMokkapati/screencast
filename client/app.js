(() => {
  // ─── Elements ───────────────────────────────────────────────────────────────
  const canvas     = document.getElementById('screen');
  const ctx        = canvas.getContext('2d');
  const statusEl   = document.getElementById('status');
  const settingsBtn= document.getElementById('settings-btn');
  const panel      = document.getElementById('panel');
  const kbProxy    = document.getElementById('kb-proxy');
  const holdRing   = document.getElementById('hold-ring');
  const statFps    = document.getElementById('stat-fps');
  const statLat    = document.getElementById('stat-latency');
  const statRes    = document.getElementById('stat-res');
  const statConn   = document.getElementById('stat-conn');

  // ─── WebSocket ───────────────────────────────────────────────────────────────
  // Access token comes from the URL printed by the server (?t=...) and is
  // remembered for this tab so reloads keep working.
  let token = new URLSearchParams(location.search).get('t');
  try {
    if (token) sessionStorage.setItem('sc-token', token);
    else token = sessionStorage.getItem('sc-token');
  } catch { /* storage unavailable */ }
  const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
  const wsUrl = `${wsProto}://${location.host}/?t=${encodeURIComponent(token || '')}`;
  let ws = null;
  let reconnectDelay = 1000;
  let pingTime = 0;
  let pingTimer = null;
  let deadTimer = null;     // fires when a ping goes unanswered: the socket is dead (e.g. after the iPad slept)
  let reconnectTimer = null;

  function connect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    const sock = new WebSocket(wsUrl);
    ws = sock;
    sock.binaryType = 'arraybuffer';

    sock.onopen = () => {
      if (ws !== sock) return;
      reconnectDelay = 1000;
      setStatus('Connected', true);
      setConnStat('Connected');
      schedulePing();
    };

    sock.onclose = (evt) => {
      if (ws !== sock) return;          // a superseded socket must not start another reconnect chain
      clearTimeout(pingTimer);
      clearTimeout(deadTimer);
      closeDecoder();
      const why = evt && evt.code ? ` (code ${evt.code}${evt.reason ? ': ' + evt.reason : ''})` : '';
      setStatus(token ? `Reconnecting in ${Math.round(reconnectDelay / 100) / 10}s…${why}` : 'Access token missing: open the full URL printed by the server');
      setConnStat('Disconnected');
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.5, 10000);
    };

    sock.onerror = () => sock.close();

    sock.onmessage = (evt) => {
      if (ws !== sock) return;
      if (typeof evt.data === 'string') {
        try { handleServerMessage(JSON.parse(evt.data)); } catch { /* ignore malformed */ }
      } else {
        // Binary: a JPEG starts with 0xFF; video messages start with a type byte (see src/h264.js).
        const kind = new Uint8Array(evt.data, 0, 1)[0];
        if (kind === 0xFF) renderFrame(evt.data);
        else if (kind === MSG_CONFIG) configureDecoder(new Uint8Array(evt.data, 1));
        else if (kind === MSG_KEY || kind === MSG_DELTA) decodeVideo(kind === MSG_KEY, new Uint8Array(evt.data, 1));
      }
    };
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }

  // Safari freezes a backgrounded/locked page and its socket dies silently, so onclose may never
  // fire. On resume, drop whatever socket is there and reconnect straight away.
  function reconnectNow() {
    if (ws && ws.readyState === WebSocket.CONNECTING) return;
    if (ws && ws.readyState === WebSocket.OPEN) {
      // Looks alive, but verify: an unanswered ping closes it (see schedulePing).
      pingTime = performance.now();
      send({ type: 'ping' });
      armDeadTimer();
      return;
    }
    reconnectDelay = 1000;
    connect();
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) reconnectNow(); });
  window.addEventListener('pageshow', (e) => { if (e.persisted) reconnectNow(); });
  window.addEventListener('online', reconnectNow);

  // ─── Ping / latency ──────────────────────────────────────────────────────────
  // One ping chain only: a stray timer from a previous connection would otherwise start a
  // second chain on the new socket after every reconnect.
  function armDeadTimer() {
    clearTimeout(deadTimer);
    const sock = ws;
    deadTimer = setTimeout(() => {
      try { sock.close(); } catch { /* already closed */ }
      // close() on a dead socket can take very long to report; treat it as closed shortly after
      deadTimer = setTimeout(() => { if (ws === sock && sock.onclose) sock.onclose({ code: 4000, reason: 'ping timeout' }); }, 1500);
    }, 6000);
  }

  function schedulePing() {
    clearTimeout(pingTimer);
    pingTimer = setTimeout(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        pingTime = performance.now();
        send({ type: 'ping' });
        armDeadTimer();
      }
    }, 2000);
  }

  function handleServerMessage(msg) {
    if (msg.type === 'pong') {
      clearTimeout(deadTimer);
      const lat = Math.round(performance.now() - pingTime);
      statLat.textContent = `${lat} ms`;
      clearTimeout(pingTimer);
      pingTimer = setTimeout(schedulePing, 3000);
    }
  }

  // ─── Frame rendering ─────────────────────────────────────────────────────────
  let frameCount = 0;
  let fpsLastTime = performance.now();

  setInterval(() => {
    const now = performance.now();
    const fps = (frameCount / ((now - fpsLastTime) / 1000)).toFixed(0);
    statFps.textContent = `${fps}`;
    frameCount = 0;
    fpsLastTime = now;
  }, 1000);

  // Newest-frame-wins: if a decode is running, remember only the latest buffer and decode that next.
  // Each decoded frame is acked so the server never has more than a couple of frames in flight.
  let decoding = false;
  let pendingBuf = null;

  function renderFrame(buf) {
    if (decoding) {
      if (pendingBuf) send({ type: 'ack' }); // superseded frame still frees a server slot
      pendingBuf = buf;
      return;
    }
    decoding = true;
    createImageBitmap(new Blob([buf], { type: 'image/jpeg' })).then((bmp) => {
      if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
        canvas.width  = bmp.width;
        canvas.height = bmp.height;
        statRes.textContent = `${bmp.width}×${bmp.height}`;
      }
      ctx.drawImage(bmp, 0, 0);
      bmp.close();
      frameCount++;
    }).catch(() => {}).then(() => {
      decoding = false;
      send({ type: 'ack' });
      if (pendingBuf) { const next = pendingBuf; pendingBuf = null; renderFrame(next); }
    });
  }

  // ─── H.264 via WebCodecs ─────────────────────────────────────────────────────
  // The server sends length-prefixed (AVCC) samples plus an avcC description, so the browser's
  // hardware decoder can be used directly. WebCodecs only exists on secure (HTTPS) pages.
  const MSG_CONFIG = 1, MSG_KEY = 2, MSG_DELTA = 3;
  const MAX_DECODE_QUEUE = 4;   // frames waiting to decode before we give up and resync on a key frame
  const FRAME_US = 33333;       // nominal timestamp step; only ordering matters

  let decoder = null;
  let decoderCfg = null;
  let needKey = true;
  let nextTs = 0;
  let paintFrame = null;        // newest decoded VideoFrame, painted on the next animation frame
  let paintQueued = false;

  function closeDecoder() {
    if (decoder) { try { decoder.close(); } catch { /* already closed */ } }
    if (paintFrame) { paintFrame.close(); paintFrame = null; }
    decoder = null;
    decoderCfg = null;
    needKey = true;
  }

  function sameBytes(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function requestKeyFrame() {
    needKey = true;
    send({ type: 'keyframe' });
  }

  function configureDecoder(avcc) {
    if (typeof VideoDecoder === 'undefined') {
      setStatus('This browser cannot decode video on this page. Open the https:// address printed by the server.');
      return;
    }
    if (decoder && sameBytes(decoderCfg, avcc)) return;
    closeDecoder();
    const hex = (b) => b.toString(16).padStart(2, '0');
    decoderCfg = avcc.slice();
    decoder = new VideoDecoder({
      output: (frame) => {
        if (paintFrame) paintFrame.close();   // newest wins
        paintFrame = frame;
        if (!paintQueued) { paintQueued = true; requestAnimationFrame(paintVideo); }
        send({ type: 'ack' });
      },
      error: () => {                        // decode error: rebuild the decoder and wait for a key frame
        const cfg = decoderCfg;
        closeDecoder();
        if (cfg) configureDecoder(cfg);
      },
    });
    try {
      decoder.configure({
        codec: 'avc1.' + hex(avcc[1]) + hex(avcc[2]) + hex(avcc[3]),
        description: decoderCfg,
        optimizeForLatency: true,
      });
    } catch {
      closeDecoder();
      setStatus('Video decoder rejected the stream; set "codec": "mjpeg" in screencast.config.json');
      return;
    }
    needKey = true;
    send({ type: 'keyframe' });
  }

  function decodeVideo(isKey, data) {
    if (!decoder || decoder.state !== 'configured') { send({ type: 'ack' }); return; }
    if (needKey && !isKey) { send({ type: 'ack' }); return; }   // waiting for a key frame
    if (!isKey && decoder.decodeQueueSize > MAX_DECODE_QUEUE) {
      requestKeyFrame();                                         // can't keep up: resync
      return;
    }
    needKey = false;
    try {
      decoder.decode(new EncodedVideoChunk({ type: isKey ? 'key' : 'delta', timestamp: nextTs, data }));
      nextTs += FRAME_US;
    } catch {
      requestKeyFrame();
    }
  }

  function paintVideo() {
    paintQueued = false;
    const frame = paintFrame;
    paintFrame = null;
    if (!frame) return;
    const w = frame.displayWidth, h = frame.displayHeight;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width  = w;
      canvas.height = h;
      statRes.textContent = `${w}×${h}`;
    }
    ctx.drawImage(frame, 0, 0);
    frame.close();
    frameCount++;
  }

  // ─── Touch → input events ────────────────────────────────────────────────────
  //
  // Gesture map:
  //   1 finger tap           → left click
  //   1 finger hold (600ms)  → right click  (vibrates if supported)
  //   1 finger drag          → mouse move (sends mousedown on drag start)
  //   2 fingers vertical     → scroll
  //   2 fingers tap (quick)  → right click (alternative)

  const DRAG_THRESHOLD = 10;   // px — movement before a tap becomes a drag
  const TAP_MAX_MS     = 350;  // ms — max duration for tap
  const HOLD_MS        = 600;  // ms — long press → right click

  let touches        = new Map();  // id → {startX,startY,startTime,lastX,lastY}
  let isDragging     = false;
  let multiTouch     = false;  // a 2+ finger gesture is in progress; never turn it into a drag
  let multiStart     = 0;      // when the current 2-finger gesture began
  let multiScrolled  = false;  // 2-finger gesture turned into a scroll (so it is not a tap)
  let longPressTimer = null;
  let scrollPrevY    = null;
  let panelOpen      = false;

  // The canvas uses object-fit: contain, so the frame may be letterboxed inside its
  // element box. Map touches against the drawn frame, not the whole element.
  function norm(cx, cy) {
    const r = canvas.getBoundingClientRect();
    const scale = canvas.width && canvas.height ? Math.min(r.width / canvas.width, r.height / canvas.height) : 1;
    const w = canvas.width  ? canvas.width  * scale : r.width;
    const h = canvas.height ? canvas.height * scale : r.height;
    const left = r.left + (r.width  - w) / 2;
    const top  = r.top  + (r.height - h) / 2;
    return {
      x: Math.max(0, Math.min(1, (cx - left) / w)),
      y: Math.max(0, Math.min(1, (cy - top)  / h)),
    };
  }

  canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (panelOpen) { closePanel(); return; }

    for (const t of e.changedTouches) {
      touches.set(t.identifier, {
        startX: t.clientX, startY: t.clientY,
        startTime: Date.now(),
        lastX: t.clientX, lastY: t.clientY,
      });
    }

    if (touches.size === 1) {
      const t = e.changedTouches[0];
      send({ type: 'mousemove', ...norm(t.clientX, t.clientY) });

      longPressTimer = setTimeout(() => {
        longPressTimer = null;
        const pos = norm(t.clientX, t.clientY);
        showHoldRing(t.clientX, t.clientY, true);
        send({ type: 'mousedown', ...pos, button: 2 });
        setTimeout(() => send({ type: 'mouseup', ...pos, button: 2 }), 30);
        if (navigator.vibrate) navigator.vibrate(40);
      }, HOLD_MS);

      showHoldRing(t.clientX, t.clientY, false);

    } else if (touches.size === 2) {
      multiTouch = true;
      multiStart = Date.now();
      multiScrolled = false;
      clearLongPress();
      const vals = [...touches.values()];
      scrollPrevY = (vals[0].lastY + vals[1].lastY) / 2;
    }
  }, { passive: false });

  canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();

    for (const t of e.changedTouches) {
      const info = touches.get(t.identifier);
      if (info) { info.lastX = t.clientX; info.lastY = t.clientY; }
    }

    if (touches.size === 1) {
      if (multiTouch) return;
      const t = e.changedTouches[0];
      const info = touches.get(t.identifier);
      if (!info) return;

      const movedEnough = Math.hypot(t.clientX - info.startX, t.clientY - info.startY) > DRAG_THRESHOLD;

      if (movedEnough && !isDragging) {
        clearLongPress();
        isDragging = true;
        send({ type: 'mousedown', ...norm(info.startX, info.startY), button: 0 });
      }

      if (isDragging) {
        send({ type: 'mousemove', ...norm(t.clientX, t.clientY) });
      }

    } else if (touches.size === 2) {
      const vals = [...touches.values()];
      const centerY = (vals[0].lastY + vals[1].lastY) / 2;
      const delta   = scrollPrevY - centerY;  // positive = fingers moved up = scroll down

      if (Math.abs(delta) > 3) {
        const t = e.changedTouches[0];
        send({ type: 'scroll', ...norm(t.clientX, t.clientY), dy: delta / 60 });
        scrollPrevY = centerY;
        multiScrolled = true;
      }
    }
  }, { passive: false });

  canvas.addEventListener('touchend', (e) => {
    e.preventDefault();

    for (const t of e.changedTouches) {
      const info = touches.get(t.identifier);
      touches.delete(t.identifier);
      if (!info) continue;

      const elapsed  = Date.now() - info.startTime;
      const dist     = Math.hypot(t.clientX - info.startX, t.clientY - info.startY);
      const wasTap   = elapsed < TAP_MAX_MS && dist < DRAG_THRESHOLD;

      if (touches.size === 0) {
        if (wasTap && longPressTimer !== null) {
          // Clean tap — send left click
          clearLongPress();
          const pos = norm(t.clientX, t.clientY);
          send({ type: 'mousedown', ...pos, button: 0 });
          setTimeout(() => send({ type: 'mouseup', ...pos, button: 0 }), 30);
          showRipple(t.clientX, t.clientY);
        } else if (isDragging) {
          send({ type: 'mouseup', ...norm(t.clientX, t.clientY), button: 0 });
        }
      }
    }

    if (touches.size === 0) {
      if (multiTouch && !multiScrolled && !isDragging && Date.now() - multiStart < TAP_MAX_MS) {
        // Quick two-finger tap → right click at the last touch position
        const t = e.changedTouches[0];
        const pos = norm(t.clientX, t.clientY);
        send({ type: 'mousedown', ...pos, button: 2 });
        setTimeout(() => send({ type: 'mouseup', ...pos, button: 2 }), 30);
      }
      isDragging   = false;
      multiTouch   = false;
      scrollPrevY  = null;
    }
  }, { passive: false });

  canvas.addEventListener('touchcancel', (e) => {
    for (const t of e.changedTouches) touches.delete(t.identifier);
    clearLongPress();
    // Release the held button, otherwise the PC keeps the mouse pressed after a system-cancelled drag
    if (isDragging) send({ type: 'mouseup', button: 0, ...norm(e.changedTouches[0].clientX, e.changedTouches[0].clientY) });
    isDragging = false;
    if (touches.size === 0) multiTouch = false;
    scrollPrevY = null;
  }, { passive: false });

  function clearLongPress() {
    clearTimeout(longPressTimer);
    longPressTimer = null;
    holdRing.classList.remove('show', 'fire');
  }

  // ─── Visual feedback ──────────────────────────────────────────────────────────
  function showRipple(x, y) {
    const el = document.createElement('div');
    el.className = 'ripple';
    const size = 60;
    el.style.cssText = `width:${size}px;height:${size}px;left:${x - size/2}px;top:${y - size/2}px`;
    document.body.appendChild(el);
    el.addEventListener('animationend', () => el.remove());
  }

  function showHoldRing(x, y, fire) {
    holdRing.style.left = x + 'px';
    holdRing.style.top  = y + 'px';
    holdRing.classList.remove('show', 'fire');
    // Force reflow
    void holdRing.offsetWidth;
    if (fire) {
      holdRing.classList.add('show', 'fire');
    } else {
      holdRing.classList.add('show');
    }
  }

  // ─── Keyboard (iOS software keyboard) ────────────────────────────────────────
  let lastKbValue = '';

  kbProxy.addEventListener('input', () => {
    const curr = kbProxy.value;
    const prev = lastKbValue;

    if (curr.length < prev.length) {
      // Backspace
      send({ type: 'keydown', key: 'Backspace' });
    } else {
      // New character(s) typed
      const newChars = curr.slice(prev.length);
      for (const ch of newChars) {
        send({ type: 'keychar', char: ch });
      }
    }

    lastKbValue = curr;

    // Keep value short so we always detect backspace reliably
    if (curr.length > 20) {
      kbProxy.value = curr.slice(-10);
      lastKbValue = kbProxy.value;
    }
  });

  kbProxy.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') send({ type: 'keydown', key: 'Enter' });
    if (e.key === 'Tab')   send({ type: 'keydown', key: 'Tab' });
  });

  document.getElementById('btn-keyboard').addEventListener('click', () => {
    // Seed value so backspace is always detectable
    kbProxy.value = '  ';
    lastKbValue   = '  ';
    kbProxy.focus();
  });

  document.getElementById('btn-esc').addEventListener('click', () => {
    send({ type: 'keydown', key: 'Escape' });
  });

  document.getElementById('btn-winkey').addEventListener('click', () => {
    send({ type: 'keydown', key: 'Meta' });
  });

  // ─── Settings panel ───────────────────────────────────────────────────────────
  settingsBtn.addEventListener('click', () => {
    panelOpen ? closePanel() : openPanel();
  });

  panel.addEventListener('click', (e) => e.stopPropagation());

  function openPanel()  { panelOpen = true;  panel.classList.add('open'); }
  function closePanel() { panelOpen = false; panel.classList.remove('open'); }

  // ─── Status helpers ───────────────────────────────────────────────────────────
  let hideTimer = null;
  function setStatus(msg, autoHide = false) {
    statusEl.textContent = msg;
    statusEl.classList.remove('hidden');
    clearTimeout(hideTimer);
    if (autoHide) hideTimer = setTimeout(() => statusEl.classList.add('hidden'), 2500);
  }

  function setConnStat(s) { statConn.textContent = s; }

  // ─── Canvas sizing ───────────────────────────────────────────────────────────
  function resize() {
    canvas.style.width  = window.innerWidth  + 'px';
    canvas.style.height = window.innerHeight + 'px';
  }
  window.addEventListener('resize', resize);
  resize();

  // ─── Boot ────────────────────────────────────────────────────────────────────
  connect();
})();
