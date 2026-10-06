// Client wiring: index.html ↔ app.js element ids, and app.js behaviour run in a vm with a fake DOM/clock.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const clientDir = path.join(__dirname, '..', 'client');
const html  = fs.readFileSync(path.join(clientDir, 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(clientDir, 'app.js'), 'utf8');

test('every id app.js looks up exists exactly once in index.html', () => {
  const ids = [...appJs.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(ids.length >= 10);
  for (const id of new Set(ids)) {
    const n = [...html.matchAll(new RegExp(`\\sid="${id}"`, 'g'))].length;
    assert.equal(n, 1, `id "${id}" appears ${n} times in index.html`);
  }
});

test('index.html loads app.js, which exists, and has a viewport and description', () => {
  assert.match(html, /<script src="app\.js"><\/script>/);
  assert.match(html, /<meta name="viewport"/);
  assert.match(html, /<meta name="description"/);
});

test('app.js is syntactically valid', () => { new vm.Script(appJs); });

// ─── harness ──────────────────────────────────────────────────────────────────
function makeEl(id) {
  const listeners = {};
  const cls = new Set();
  return {
    id, listeners, textContent: '', value: '', style: {}, offsetWidth: 0,
    width: 0, height: 0,
    classList: { add: (...c) => c.forEach((x) => cls.add(x)), remove: (...c) => c.forEach((x) => cls.delete(x)), has: (c) => cls.has(c) },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    focus() {}, remove() {},
    getContext: () => ({ drawImage() {} }),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 1000 }),
  };
}

function boot({ search = '?t=tok', stored = {} } = {}) {
  const els = {};
  const sockets = [];
  let now = 0;
  const timers = new Map();
  let nextTimer = 1;
  class FakeWS {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(m) { this.sent.push(JSON.parse(m)); }
    close() { this.readyState = 3; this.onclose && this.onclose(); }
    open() { this.readyState = 1; this.onopen(); }
  }
  FakeWS.OPEN = 1;
  const store = { ...stored };
  const ctx = {
    document: { getElementById: (id) => (els[id] ||= makeEl(id)), createElement: () => makeEl('x'), body: { appendChild() {} } },
    location: { search, host: 'pc:9001', protocol: 'http:' },
    sessionStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } },
    WebSocket: FakeWS,
    window: { addEventListener() {}, innerWidth: 1000, innerHeight: 1000 },
    navigator: {},
    performance: { now: () => now },
    Date: { now: () => now },
    Blob: class {}, createImageBitmap: () => new Promise(() => {}),
    setTimeout: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
    setInterval: () => 0,
    URLSearchParams, encodeURIComponent, Math, Map, JSON,
  };
  vm.runInNewContext(appJs, ctx);
  const h = {
    els, sockets, store,
    get ws() { return sockets.at(-1); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]); now = Math.max(now, due[1].at); due[1].fn();
      }
      now = end;
    },
    pendingTimers: () => timers.size,
    msgs: () => h.ws.sent,
    fire(type, touchList) {
      const e = { changedTouches: touchList, preventDefault() {} };
      for (const fn of els.screen.listeners[type] || []) fn(e);
    },
  };
  return h;
}
const touch = (identifier, clientX, clientY) => ({ identifier, clientX, clientY });

// ─── connection / token ──────────────────────────────────────────────────────
test('connects to ws://host/?t=<token> using the token from the page URL, and remembers it', () => {
  const h = boot({ search: '?t=a%20b' });
  assert.equal(h.ws.url, 'ws://pc:9001/?t=a%20b');
  assert.equal(h.store['sc-token'], 'a b');
});

test('falls back to the remembered token on reload, and tells the user when there is none', () => {
  assert.equal(boot({ search: '', stored: { 'sc-token': 'old' } }).ws.url, 'ws://pc:9001/?t=old');
  const h = boot({ search: '' });
  h.ws.open(); h.ws.close();
  assert.match(h.els.status.textContent, /token missing/i);
});

test('reconnects with growing backoff after a drop', () => {
  const h = boot();
  h.ws.open();
  h.ws.close();
  assert.equal(h.sockets.length, 1);
  h.advance(1000);
  assert.equal(h.sockets.length, 2, 'first retry after 1s');
  h.ws.close();
  h.advance(1000);
  assert.equal(h.sockets.length, 2, 'second retry waits longer than 1s');
  h.advance(1000);
  assert.equal(h.sockets.length, 3);
});

test('ping chain: exactly one outstanding ping timer, even across reconnects', () => {
  const h = boot();
  h.ws.open();
  h.advance(1500);                      // reconnect happens before the 2s ping fires
  h.ws.close();
  h.advance(1000);                      // new socket created
  h.ws.open();
  h.advance(2000);
  const pings = h.msgs().filter((m) => m.type === 'ping');
  assert.equal(pings.length, 1, 'only the new connection pings, once');
  h.ws.onmessage({ data: '{"type":"pong"}' });
  h.advance(5000);
  assert.equal(h.msgs().filter((m) => m.type === 'ping').length, 2, 'next ping 3s + 2s after pong');
  assert.ok(h.pendingTimers() <= 1, 'at most one ping timer is pending');
});

test('malformed server text frames do not throw', () => {
  const h = boot();
  h.ws.open();
  assert.doesNotThrow(() => h.ws.onmessage({ data: 'not json' }));
});

// ─── gestures ────────────────────────────────────────────────────────────────
function input(h) { return h.msgs().filter((m) => m.type !== 'ping'); }

test('tap → mousemove, left mousedown, then left mouseup 30ms later', () => {
  const h = boot(); h.ws.open();
  h.fire('touchstart', [touch(1, 500, 250)]);
  h.advance(100);
  h.fire('touchend', [touch(1, 500, 250)]);
  h.advance(40);
  assert.deepEqual(input(h).map((m) => [m.type, m.button]), [['mousemove', undefined], ['mousedown', 0], ['mouseup', 0]]);
  assert.deepEqual([input(h)[1].x, input(h)[1].y], [0.5, 0.25]);
});

test('long press (600ms) → right click, and releasing afterwards does not also left-click', () => {
  const h = boot(); h.ws.open();
  h.fire('touchstart', [touch(1, 100, 100)]);
  h.advance(650);
  h.fire('touchend', [touch(1, 100, 100)]);
  h.advance(100);
  const buttons = input(h).filter((m) => m.type !== 'mousemove').map((m) => [m.type, m.button]);
  assert.deepEqual(buttons, [['mousedown', 2], ['mouseup', 2]]);
});

test('drag: left mousedown at the ORIGINAL touch point, moves follow, mouseup on release', () => {
  const h = boot(); h.ws.open();
  h.fire('touchstart', [touch(1, 100, 100)]);
  h.advance(50);
  h.fire('touchmove', [touch(1, 150, 100)]);
  h.fire('touchmove', [touch(1, 200, 100)]);
  h.fire('touchend', [touch(1, 200, 100)]);
  h.advance(100);
  const m = input(h);
  const down = m.find((x) => x.type === 'mousedown');
  assert.deepEqual([down.x, down.y, down.button], [0.1, 0.1, 0], 'press where the finger landed, not 10px+ later');
  assert.equal(m.at(-1).type, 'mouseup');
  assert.equal(m.filter((x) => x.type === 'mousedown').length, 1);
  assert.equal(m.filter((x) => x.type === 'mouseup' && x.button === 0).length, 1, 'no stray click after drag');
});

test('two-finger vertical drag scrolls (fingers up = scroll down) and does not click', () => {
  const h = boot(); h.ws.open();
  h.fire('touchstart', [touch(1, 100, 500)]);
  h.fire('touchstart', [touch(2, 200, 500)]);
  h.fire('touchmove', [touch(1, 100, 400), touch(2, 200, 400)]);
  h.fire('touchend', [touch(1, 100, 400), touch(2, 200, 400)]);
  h.advance(100);
  const m = input(h);
  const scroll = m.find((x) => x.type === 'scroll');
  assert.ok(scroll && scroll.dy > 0, 'fingers moved up → positive dy');
  assert.ok(!m.some((x) => x.type === 'mousedown'), 'no click');
});

test('quick two-finger tap → right click (as documented in the gesture map)', () => {
  const h = boot(); h.ws.open();
  h.fire('touchstart', [touch(1, 100, 100)]);
  h.fire('touchstart', [touch(2, 200, 100)]);
  h.advance(80);
  h.fire('touchend', [touch(1, 100, 100)]);
  h.fire('touchend', [touch(2, 200, 100)]);
  h.advance(100);
  assert.deepEqual(input(h).filter((m) => m.type !== 'mousemove').map((m) => [m.type, m.button]), [['mousedown', 2], ['mouseup', 2]]);
});

test('a slow two-finger hold is not a tap', () => {
  const h = boot(); h.ws.open();
  h.fire('touchstart', [touch(1, 100, 100)]);
  h.fire('touchstart', [touch(2, 200, 100)]);
  h.advance(800);
  h.fire('touchend', [touch(1, 100, 100)]);
  h.fire('touchend', [touch(2, 200, 100)]);
  h.advance(100);
  assert.ok(!input(h).some((m) => m.type === 'mousedown'));
});

test('touchcancel during a drag releases the mouse button', () => {
  const h = boot(); h.ws.open();
  h.fire('touchstart', [touch(1, 100, 100)]);
  h.fire('touchmove', [touch(1, 200, 100)]);
  h.fire('touchcancel', [touch(1, 200, 100)]);
  assert.equal(input(h).at(-1).type, 'mouseup');
});

test('touch coordinates are normalized against the letterboxed frame, not the element box', () => {
  const h = boot();
  h.ws.open();
  // 1000x1000 element showing a 2000x1000 frame → drawn frame is 1000x500, centred (top=250)
  h.els.screen.width = 2000; h.els.screen.height = 1000;
  h.fire('touchstart', [touch(1, 500, 500)]);   // exact centre
  h.fire('touchend', [touch(1, 500, 500)]);
  h.advance(40);
  const down = input(h).find((m) => m.type === 'mousedown');
  assert.deepEqual([down.x, down.y], [0.5, 0.5]);
  h.fire('touchstart', [touch(2, 500, 10)]);    // in the black bar above the frame → clamped to the top edge
  assert.equal(input(h).filter((m) => m.type === 'mousemove').at(-1).y, 0);
});

// ─── keyboard / buttons ──────────────────────────────────────────────────────
test('soft keyboard: typed characters → keychar, shrinking value → Backspace, Enter/Tab → keydown', () => {
  const h = boot(); h.ws.open();
  h.els['btn-keyboard'].listeners.click[0]();                   // seeds '  '
  const kb = h.els['kb-proxy'];
  kb.value = '  ab'; kb.listeners.input[0]();
  kb.value = '  a';  kb.listeners.input[0]();
  kb.listeners.keydown[0]({ key: 'Enter' });
  kb.listeners.keydown[0]({ key: 'Tab' });
  kb.listeners.keydown[0]({ key: 'x' });
  assert.deepEqual(input(h), [
    { type: 'keychar', char: 'a' }, { type: 'keychar', char: 'b' },
    { type: 'keydown', key: 'Backspace' },
    { type: 'keydown', key: 'Enter' }, { type: 'keydown', key: 'Tab' },
  ]);
});

test('Esc and Win buttons send the keys the server maps', () => {
  const h = boot(); h.ws.open();
  h.els['btn-esc'].listeners.click[0]();
  h.els['btn-winkey'].listeners.click[0]();
  assert.deepEqual(input(h), [{ type: 'keydown', key: 'Escape' }, { type: 'keydown', key: 'Meta' }]);
});

test('nothing is sent while the socket is not open', () => {
  const h = boot();
  h.els['btn-esc'].listeners.click[0]();
  assert.equal(h.ws.sent.length, 0);
});

// ─── client ↔ server contract ────────────────────────────────────────────────
test('every event type the client sends is one input.js handles (or the ping handled by the server)', () => {
  const sentTypes = new Set([...appJs.matchAll(/type:\s*'(\w+)'/g)].map((m) => m[1]));
  const inputSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'input.js'), 'utf8');
  const appSrc   = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
  for (const t of sentTypes) {
    if (t === 'pong') continue; // server → client message type that the client matches on
    const handled = inputSrc.includes(`case '${t}'`) || appSrc.includes(`'${t}'`);
    assert.ok(handled, `client sends "${t}" but no server handler exists`);
  }
});
