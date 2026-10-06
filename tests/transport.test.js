const { test } = require('node:test');
const assert   = require('node:assert/strict');
const http     = require('http');
const WebSocket = require('ws');
const { createTransport } = require('../src/transport');

function listenOnFreePort(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    server.once('error', reject);
  });
}

function wsConnect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once('open',  () => resolve(ws));
    ws.once('error', reject);
  });
}

function closeAll(...closeables) {
  // ws clients use terminate() for immediate close; http.Server.close() takes a callback
  for (const c of closeables) {
    try {
      if (typeof c.terminate === 'function') c.terminate(); // WebSocket client
      else c.close(() => {});                                // http.Server
    } catch { /* ignore */ }
  }
  return new Promise(r => setTimeout(r, 50)); // let sockets drain
}

test('broadcast sends binary frame to a connected client', async () => {
  const server = http.createServer();
  const { broadcast } = createTransport(server);
  const port = await listenOnFreePort(server);
  const ws   = await wsConnect(port);

  const received = new Promise((resolve) => ws.once('message', resolve));
  const frame = Buffer.from([0xFF, 0xD8, 0xAB, 0xCD, 0xFF, 0xD9]);
  broadcast(frame);

  const msg = await received;
  assert.ok(Buffer.isBuffer(msg), 'received message should be a Buffer');
  assert.deepEqual(msg, frame, 'received frame should match sent frame');

  await closeAll(ws, server);
});

test('broadcast sends to multiple clients simultaneously', async () => {
  const server = http.createServer();
  const { broadcast } = createTransport(server);
  const port = await listenOnFreePort(server);

  const [ws1, ws2] = await Promise.all([wsConnect(port), wsConnect(port)]);
  const r1 = new Promise(r => ws1.once('message', r));
  const r2 = new Promise(r => ws2.once('message', r));

  const frame = Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]);
  broadcast(frame);

  const [m1, m2] = await Promise.all([r1, r2]);
  assert.deepEqual(m1, frame);
  assert.deepEqual(m2, frame);

  await closeAll(ws1, ws2, server);
});

test('client message is delivered to handler with a reply function', async () => {
  const server = http.createServer();
  const { onClientMessage } = createTransport(server);
  const port = await listenOnFreePort(server);

  let capturedMsg = null;
  let capturedReply = null;
  onClientMessage((msg, reply) => {
    capturedMsg   = msg;
    capturedReply = reply;
    reply(JSON.stringify({ type: 'pong' }));
  });

  const ws = await wsConnect(port);
  const response = new Promise(r => ws.once('message', r));
  ws.send(JSON.stringify({ type: 'ping' }));

  const resp = await response;
  assert.equal(capturedMsg, '{"type":"ping"}', 'handler should receive the sent message');
  assert.equal(typeof capturedReply, 'function', 'reply should be a function');
  assert.equal(resp.toString(), '{"type":"pong"}', 'reply should be received by client');

  await closeAll(ws, server);
});

test('broadcast does not throw after a client disconnects', async () => {
  const server = http.createServer();
  const { broadcast } = createTransport(server);
  const port = await listenOnFreePort(server);
  const ws   = await wsConnect(port);

  await new Promise(r => { ws.close(); ws.once('close', r); });
  await new Promise(r => setTimeout(r, 50)); // let server process the close

  assert.doesNotThrow(() => broadcast(Buffer.from([0x00])),
    'broadcast should not throw when no clients are connected');

  await closeAll(server);
});

test('broadcast is a no-op with zero clients connected', () => {
  const server = http.createServer();
  const { broadcast } = createTransport(server);
  // Never listen — no clients can connect
  assert.doesNotThrow(() => broadcast(Buffer.from([0xFF, 0xD8, 0xFF, 0xD9])));
});

test('verifyClient rejects connections it does not approve', async () => {
  const server = http.createServer();
  createTransport(server, { verifyClient: ({ req }) => req.url.includes('t=ok') });
  const port = await listenOnFreePort(server);

  await assert.rejects(wsConnect(port), 'connection without token must be refused');
  const ws = await new Promise((resolve, reject) => {
    const c = new WebSocket(`ws://127.0.0.1:${port}/?t=ok`);
    c.once('open', () => resolve(c));
    c.once('error', reject);
  });
  await closeAll(ws, server);
});

test('a throwing message handler does not crash the process and the socket stays usable', async () => {
  const server = http.createServer();
  const { onClientMessage } = createTransport(server);
  const port = await listenOnFreePort(server);
  let calls = 0;
  onClientMessage((msg, reply) => { calls++; if (calls === 1) throw new Error('boom'); reply('ok'); });

  const ws = await wsConnect(port);
  const origErr = console.error; console.error = () => {};
  try {
    const got = new Promise((r) => ws.once('message', r));
    ws.send('first');
    ws.send('second');
    assert.equal((await got).toString(), 'ok');
  } finally { console.error = origErr; }
  await closeAll(ws, server);
});

test('flow control: newest frame wins and is sent only after the client acks', async () => {
  const server = http.createServer();
  const { broadcast } = createTransport(server);
  const port = await listenOnFreePort(server);
  const ws   = await wsConnect(port);
  const got  = [];
  ws.on('message', (m) => got.push(m[0]));
  const wait = () => new Promise((r) => setTimeout(r, 60));

  for (let i = 1; i <= 5; i++) broadcast(Buffer.from([i]));
  await wait();
  assert.deepEqual(got, [1, 2], 'only 2 frames may be in flight before an ack');

  ws.send('{"type":"ack"}');
  await wait();
  assert.deepEqual(got, [1, 2, 5], 'after an ack the NEWEST frame is sent; stale 3 and 4 are dropped');

  await closeAll(ws, server);
});

test('unchanged frames are not re-sent, and a new client gets the current frame on connect', async () => {
  const server = http.createServer();
  const { broadcast } = createTransport(server);
  const port = await listenOnFreePort(server);
  const ws   = await wsConnect(port);
  const got  = [];
  ws.on('message', (m) => got.push(m[0]));
  const wait = () => new Promise((r) => setTimeout(r, 60));

  broadcast(Buffer.from([7])); broadcast(Buffer.from([7])); broadcast(Buffer.from([7]));
  await wait();
  assert.deepEqual(got, [7], 'identical frames are sent once');

  const lateGot = [];
  const late = new WebSocket(`ws://127.0.0.1:${port}`); // listener must exist before the first frame lands
  late.on('message', (m) => lateGot.push(m[0]));
  await wait();
  const lateOk = lateGot.length === 1 && lateGot[0] === 7;
  await closeAll(ws, late, server);
  assert.ok(lateOk, 'late joiner receives the latest frame immediately');
});

// ─── H.264 flow control ──────────────────────────────────────────────────────
function collect(ws) {
  const got = [];
  ws.on('message', (m) => got.push([...m]));
  return got;
}
const settle = () => new Promise((r) => setTimeout(r, 60));

test('video: config goes to existing and late clients; nothing is decoded before a key frame', async () => {
  const server = http.createServer();
  const { setVideoConfig, broadcastVideo } = createTransport(server);
  const port = await listenOnFreePort(server);

  const a = new WebSocket(`ws://127.0.0.1:${port}`);
  const gotA = collect(a);
  await new Promise((r) => a.once('open', r));
  setVideoConfig(Buffer.from([1, 0xAA]));
  await settle();
  assert.deepEqual(gotA, [[1, 0xAA]]);

  broadcastVideo(Buffer.from([3, 1]), false);              // delta before any key frame: useless to a new decoder
  await settle();
  assert.deepEqual(gotA, [[1, 0xAA]], 'deltas are withheld until a key frame');

  broadcastVideo(Buffer.from([2, 2]), true);
  broadcastVideo(Buffer.from([3, 3]), false);
  await settle();
  assert.deepEqual(gotA.slice(1), [[2, 2], [3, 3]]);

  const b = new WebSocket(`ws://127.0.0.1:${port}`);
  const gotB = collect(b);
  await new Promise((r) => b.once('open', r));
  await settle();
  assert.deepEqual(gotB, [[1, 0xAA]], 'late client gets the config straight away');

  await closeAll(a, b, server);
});

test('video: a client that stops acking is cut off at the in-flight limit and resumes on a key frame', async () => {
  const server = http.createServer();
  const { setVideoConfig, broadcastVideo } = createTransport(server);
  const port = await listenOnFreePort(server);
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const got = collect(ws);
  await new Promise((r) => ws.once('open', r));
  setVideoConfig(Buffer.from([1, 9]));

  broadcastVideo(Buffer.from([2, 0]), true);
  for (let i = 1; i <= 20; i++) broadcastVideo(Buffer.from([3, i]), false);
  await settle();
  const frames = got.filter((m) => m[0] !== 1);
  assert.equal(frames.length, 8, 'at most 8 unacked frames are in flight');
  assert.deepEqual(frames[0], [2, 0]);

  broadcastVideo(Buffer.from([3, 99]), false);
  await settle();
  assert.equal(got.filter((m) => m[0] !== 1).length, 8, 'still behind: nothing more is sent');

  for (let i = 0; i < 8; i++) ws.send('{"type":"ack"}');
  await settle();
  broadcastVideo(Buffer.from([3, 100]), false);
  await settle();
  assert.equal(got.filter((m) => m[0] !== 1).length, 8, 'after the cut-off even deltas wait for a key frame');
  broadcastVideo(Buffer.from([2, 101]), true);
  broadcastVideo(Buffer.from([3, 102]), false);
  await settle();
  assert.deepEqual(got.filter((m) => m[0] !== 1).slice(8), [[2, 101], [3, 102]]);

  await closeAll(ws, server);
});

test('video: a keyframe request from the client holds back deltas until the next key frame', async () => {
  const server = http.createServer();
  const { broadcastVideo } = createTransport(server);
  const port = await listenOnFreePort(server);
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const got = collect(ws);
  await new Promise((r) => ws.once('open', r));

  broadcastVideo(Buffer.from([2, 1]), true);
  broadcastVideo(Buffer.from([3, 2]), false);
  await settle();
  assert.equal(got.length, 2);

  ws.send('{"type":"keyframe"}');
  await settle();
  broadcastVideo(Buffer.from([3, 3]), false);
  await settle();
  assert.equal(got.length, 2, 'delta withheld after the client lost sync');
  broadcastVideo(Buffer.from([2, 4]), true);
  await settle();
  assert.deepEqual(got.at(-1), [2, 4]);

  await closeAll(ws, server);
});
