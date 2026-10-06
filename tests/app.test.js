// End-to-end wiring of the real HTTP/WebSocket server (src/app.js) with display + input stubbed out.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http   = require('http');
const net    = require('net');
const WebSocket = require('ws');
const { createApp, listenAll } = require('../src/app');

const TOKEN = 'secret-token-123';
const inputs = [];
let added = [];
const display = {
  listMonitors: () => [{ index: 0, primary: 1, x: 0, y: 0, w: 1920, h: 1080, name: 'D1' }],
  checkVirtualDisplayDriver: () => null,
  getSetupGuide: () => ({ steps: ['s'], recommended: 'x' }),
  addVirtualMonitor: async (p) => { added.push(p); return { ok: true, message: 'added' }; },
};

let ctx, port;
before(async () => {
  ctx = createApp({ token: TOKEN, display, handleInput: (e) => inputs.push(e) });
  port = await listenAll(ctx.server, 0);
});
after(() => { ctx.server.closeAllConnections?.(); ctx.server.close(); });

function req(path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    r.on('error', reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}
const json = (r) => JSON.parse(r.body);

function wsOpen(url, opts) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, opts);
    ws.once('open', () => resolve({ ws, ok: true }));
    ws.once('unexpected-response', (_q, res) => { res.resume(); resolve({ ok: false, status: res.statusCode }); });
    ws.once('error', () => resolve({ ok: false }));
  });
}

test('static client is served without a token, with hardening headers and no x-powered-by', async () => {
  const r = await req('/');
  assert.equal(r.status, 200);
  assert.match(r.body, /<canvas id="screen"/);
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['x-frame-options'], 'DENY');
  assert.equal(r.headers['referrer-policy'], 'no-referrer');
  assert.equal(r.headers['x-powered-by'], undefined);
  assert.equal((await req('/app.js')).status, 200);
});

test('the server never serves source files outside client/', async () => {
  for (const p of ['/../server.js', '/..%2fserver.js', '/%2e%2e/package.json', '/screencast.config.json']) {
    const r = await req(p);
    assert.notEqual(r.status, 200, p);
    assert.ok(!/require\(|"name": "screencast"/.test(r.body), p);
  }
});

test('API requires the token: none, wrong, empty and array-valued tokens are all 401', async () => {
  for (const p of ['/api/displays', '/api/displays?t=wrong', '/api/displays?t=', `/api/displays?t[]=${TOKEN}`]) {
    const r = await req(p);
    assert.equal(r.status, 401, p);
    assert.deepEqual(json(r), { error: 'unauthorized' });
  }
  assert.equal((await req('/api/displays', { headers: { 'x-screencast-token': 'nope' } })).status, 401);
});

test('API accepts the token via query string or header', async () => {
  for (const r of [await req(`/api/displays?t=${TOKEN}`), await req('/api/displays', { headers: { 'x-screencast-token': TOKEN } })]) {
    assert.equal(r.status, 200);
    const body = json(r);
    assert.equal(body.monitors.length, 1);
    assert.equal(body.driverInstalled, false);
    assert.ok(body.setupGuide.steps.length);
  }
});

test('API rejects a browser request from a foreign Origin even with a valid token (CSRF)', async () => {
  const r = await req(`/api/displays?t=${TOKEN}`, { headers: { origin: 'http://evil.example' } });
  assert.equal(r.status, 401);
  const same = await req(`/api/displays?t=${TOKEN}`, { headers: { origin: `http://127.0.0.1:${port}` } });
  assert.equal(same.status, 200);
});

test('listing failures return a generic 500 with no internal detail', async () => {
  const orig = display.listMonitors;
  display.listMonitors = () => { throw new Error('C:\\secret\\path exploded'); };
  try {
    const r = await req(`/api/displays?t=${TOKEN}`);
    assert.equal(r.status, 500);
    assert.ok(!/secret|path|exploded/.test(r.body));
  } finally { display.listMonitors = orig; }
});

test('POST /api/displays/add: validates input and forwards only validated integers', async () => {
  const post = (body, token = TOKEN) => req(`/api/displays/add?t=${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  added = [];
  assert.equal((await post({}, 'bad')).status, 401);
  for (const bad of [{ width: 'x' }, { width: 10 }, { height: 1e9 }, { refreshRate: 1000 }, { width: 1920.5 }, { width: '1920; calc' }]) {
    assert.equal((await post(bad)).status, 400, JSON.stringify(bad));
  }
  assert.deepEqual(added, []);
  const ok = await post({ width: 1668, height: 1024, refreshRate: 60 });
  assert.equal(ok.status, 200);
  assert.deepEqual(added, [{ width: 1668, height: 1024, refreshRate: 60 }]);
  assert.equal((await post({})).status, 200); // defaults
  assert.deepEqual(added.at(-1), { width: 1920, height: 1080, refreshRate: 60 });
});

test('malformed or oversized JSON gets a clean JSON error with no stack trace, and never reaches the parser unauthenticated', async () => {
  const bad = await req(`/api/displays/add?t=${TOKEN}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
  assert.equal(bad.status, 400);
  assert.ok(!/at |\.js:|node_modules|SyntaxError/.test(bad.body), bad.body);

  const big = await req(`/api/displays/add?t=${TOKEN}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pad: 'x'.repeat(20000) }) });
  assert.equal(big.status, 413);
  assert.ok(!/at |\.js:|node_modules/.test(big.body));

  // Unauthenticated + malformed → 401 (auth first), not a parser error that leaks anything
  const unauth = await req('/api/displays/add', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
  assert.equal(unauth.status, 401);
});

test('WebSocket: refused without a valid token or from a foreign Origin; accepted otherwise', async () => {
  assert.equal((await wsOpen(`ws://127.0.0.1:${port}/`)).ok, false);
  assert.equal((await wsOpen(`ws://127.0.0.1:${port}/?t=wrong`)).ok, false);
  assert.equal((await wsOpen(`ws://127.0.0.1:${port}/?t=${TOKEN}`, { origin: 'http://evil.example' })).ok, false);
  const good = await wsOpen(`ws://127.0.0.1:${port}/?t=${TOKEN}`, { origin: `http://127.0.0.1:${port}` });
  assert.equal(good.ok, true);
  good.ws.terminate();
});

test('WebSocket wiring: ping→pong, input events reach handleInput, malformed messages are ignored', async () => {
  const { ws } = await wsOpen(`ws://127.0.0.1:${port}/?t=${TOKEN}`);
  inputs.length = 0;
  const pong = new Promise((r) => ws.once('message', (m) => r(m.toString())));
  ws.send('not json');
  ws.send('null');
  ws.send(JSON.stringify({ type: 'mousemove', x: 0.1, y: 0.2 }));
  ws.send(JSON.stringify({ type: 'ping' }));
  assert.deepEqual(JSON.parse(await pong), { type: 'pong' });
  assert.deepEqual(inputs, [{ type: 'mousemove', x: 0.1, y: 0.2 }], 'ping must not be forwarded as input; garbage must not crash');
  ws.terminate();
});

test('frames passed to broadcast arrive as binary on authorized sockets only', async () => {
  const { ws } = await wsOpen(`ws://127.0.0.1:${port}/?t=${TOKEN}`);
  const got = new Promise((r) => ws.once('message', (d, isBinary) => r({ d, isBinary })));
  const frame = Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]);
  ctx.broadcast(frame);
  const { d, isBinary } = await got;
  assert.equal(isBinary, true);
  assert.deepEqual(d, frame);
  ws.terminate();
});

test('oversized WebSocket messages are rejected by the transport (maxPayload)', async () => {
  const { ws } = await wsOpen(`ws://127.0.0.1:${port}/?t=${TOKEN}`);
  const closed = new Promise((r) => ws.once('close', (code) => r(code)));
  ws.send('x'.repeat(200 * 1024));
  assert.equal(await closed, 1009);
});

test('tokenOk is strict about type and value', () => {
  assert.equal(ctx.tokenOk(TOKEN), true);
  for (const bad of ['', 'secret-token-12', TOKEN + 'x', null, undefined, 123, [TOKEN], { toString: () => TOKEN }]) {
    assert.equal(ctx.tokenOk(bad), false, String(bad));
  }
});

test('a random token is generated when none is supplied', () => {
  const a = createApp({ display, handleInput() {} });
  const b = createApp({ display, handleInput() {} });
  assert.match(a.token, /^[0-9a-f]{32}$/);
  assert.notEqual(a.token, b.token);
});

test('listenAll accepts both IPv4 and IPv6 connections (USB tunnel hands the iPad an IPv6 address)', async (t) => {
  const s = createApp({ token: 'x', display, handleInput() {} }).server;
  const p = await listenAll(s, 0);
  t.after(() => { s.closeAllConnections?.(); s.close(); });
  const connect = (host) => new Promise((resolve) => {
    const c = net.connect({ host, port: p }, () => { c.destroy(); resolve(true); });
    c.on('error', () => resolve(false));
  });
  assert.equal(await connect('127.0.0.1'), true, 'IPv4 must work');
  const v6 = s.address().family === 'IPv6';
  if (!v6) return t.skip('IPv6 unavailable on this host');
  assert.equal(await connect('::1'), true, 'IPv6 must work');
});

test('listenAll rejects with EADDRINUSE when the port is taken', async () => {
  const s2 = createApp({ token: 'x', display, handleInput() {} }).server;
  await assert.rejects(listenAll(s2, port), (e) => e.code === 'EADDRINUSE');
});
