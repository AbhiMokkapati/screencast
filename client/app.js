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

  function connect() {
    ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      reconnectDelay = 1000;
      setStatus('Connected', true);
      setConnStat('Connected');
      schedulePing();
    };

    ws.onclose = () => {
      setStatus(`Reconnecting in ${reconnectDelay / 1000}s…`);
      setConnStat('Disconnected');
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.5, 10000);
    };

    ws.onerror = () => ws.close();

    ws.onmessage = (evt) => {
      if (typeof evt.data === 'string') {
        handleServerMessage(JSON.parse(evt.data));
      } else {
        renderFrame(evt.data);
      }
    };
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }

  // ─── Ping / latency ──────────────────────────────────────────────────────────
  function schedulePing() {
    setTimeout(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        pingTime = performance.now();
        send({ type: 'ping' });
      }
    }, 2000);
  }

  function handleServerMessage(msg) {
    if (msg.type === 'pong') {
      const lat = Math.round(performance.now() - pingTime);
      statLat.textContent = `${lat} ms`;
      setTimeout(schedulePing, 3000);
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

  function renderFrame(buf) {
    createImageBitmap(new Blob([buf], { type: 'image/jpeg' })).then((bmp) => {
      if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
        canvas.width  = bmp.width;
        canvas.height = bmp.height;
        statRes.textContent = `${bmp.width}×${bmp.height}`;
      }
      ctx.drawImage(bmp, 0, 0);
      bmp.close();
      frameCount++;
    }).catch(() => {});
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
  let longPressTimer = null;
  let scrollPrevY    = null;
  let panelOpen      = false;

  function norm(cx, cy) {
    const r = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (cx - r.left) / r.width)),
      y: Math.max(0, Math.min(1, (cy - r.top)  / r.height)),
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
      const t = e.changedTouches[0];
      const info = touches.get(t.identifier);
      if (!info) return;

      const movedEnough = Math.hypot(t.clientX - info.startX, t.clientY - info.startY) > DRAG_THRESHOLD;

      if (movedEnough && !isDragging) {
        clearLongPress();
        isDragging = true;
        send({ type: 'mousedown', ...norm(t.clientX, t.clientY), button: 0 });
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
      isDragging   = false;
      scrollPrevY  = null;
    }
  }, { passive: false });

  canvas.addEventListener('touchcancel', (e) => {
    for (const t of e.changedTouches) touches.delete(t.identifier);
    clearLongPress();
    isDragging = false;
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
