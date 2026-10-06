const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const input  = require('../src/input');
const { handleInput, setMonitorContext, setSender, escapeSendKeys, VK } = input;

// Capture commands instead of driving the real PowerShell daemon (which would move the real mouse).
let sent;
beforeEach(() => { sent = []; setSender((c) => sent.push(c)); setMonitorContext({ x: 1920, y: 100, w: 1000, h: 500 }); });
afterEach(() => setSender(null));

test('module exports the expected API and does not start a daemon on require', () => {
  for (const fn of ['handleInput', 'setMonitorContext', 'startDaemon', 'stopDaemon', 'escapeSendKeys']) {
    assert.equal(typeof input[fn], 'function', fn);
  }
});

test('mousemove maps normalized coords onto the monitor rectangle (secondary-monitor offset applied)', () => {
  handleInput({ type: 'mousemove', x: 0.5, y: 0.5 });
  assert.deepEqual(sent, [{ t: 'mv', x: 2420, y: 350 }]);
});

test('coords outside 0-1 and non-numeric coords are clamped to the monitor edges', () => {
  handleInput({ type: 'mousemove', x: -5, y: 9 });
  handleInput({ type: 'mousemove', x: 'abc', y: null });
  handleInput({ type: 'mousemove', x: 1, y: 1 });
  assert.deepEqual(sent, [
    { t: 'mv', x: 1920, y: 600 },
    { t: 'mv', x: 1920, y: 100 },
    { t: 'mv', x: 2920, y: 600 },
  ]);
});

test('negative monitor origin (monitor left of primary) is honoured', () => {
  setMonitorContext({ x: -1920, y: 0, w: 1920, h: 1080 });
  handleInput({ type: 'mousemove', x: 0, y: 0 });
  assert.deepEqual(sent, [{ t: 'mv', x: -1920, y: 0 }]);
});

test('mousedown moves first, then presses the correct button', () => {
  handleInput({ type: 'mousedown', x: 0, y: 0, button: 0 });
  handleInput({ type: 'mousedown', x: 0, y: 0, button: 2 });
  handleInput({ type: 'mousedown', x: 0, y: 0 }); // missing button → left
  assert.deepEqual(sent.map((c) => c.t), ['mv', 'ld', 'mv', 'rd', 'mv', 'ld']);
});

test('mouseup releases the matching button', () => {
  handleInput({ type: 'mouseup', button: 0 });
  handleInput({ type: 'mouseup', button: 2 });
  handleInput({ type: 'mouseup' });
  assert.deepEqual(sent.map((c) => c.t), ['lu', 'ru', 'lu']);
});

test('scroll: client dy>0 (scroll down) becomes a NEGATIVE wheel delta; dy is clamped; zero sends no wheel event', () => {
  handleInput({ type: 'scroll', x: 0, y: 0, dy: 1 });
  handleInput({ type: 'scroll', x: 0, y: 0, dy: -1 });
  handleInput({ type: 'scroll', x: 0, y: 0, dy: 1e9 });
  handleInput({ type: 'scroll', x: 0, y: 0, dy: 0 });
  handleInput({ type: 'scroll', x: 0, y: 0, dy: 'x' });
  const wheels = sent.filter((c) => c.t === 'wh').map((c) => c.d);
  assert.deepEqual(wheels, [-360, 360, -50 * 360]);
});

test('keydown: known keys map to their Windows virtual-key codes; unknown keys are ignored', () => {
  for (const [key, vk] of [['Enter', 0x0D], ['Backspace', 0x08], ['Escape', 0x1B], ['Tab', 0x09], ['Meta', 0x5B]]) {
    sent = [];
    handleInput({ type: 'keydown', key });
    assert.deepEqual(sent, [{ t: 'vk', k: vk }], key);
  }
  sent = [];
  handleInput({ type: 'keydown', key: 'Nope' });
  handleInput({ type: 'keydown', key: '__proto__' });
  handleInput({ type: 'keydown', key: 'constructor' }); // inherited property, must not map
  assert.deepEqual(sent, []);
});

test('every VK code fits in a byte (keybd_event takes a byte)', () => {
  for (const [k, v] of Object.entries(VK)) assert.ok(Number.isInteger(v) && v > 0 && v <= 0xff, k);
});

test('every key the client sends has a VK mapping', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'client', 'app.js'), 'utf8');
  const keys = [...src.matchAll(/type:\s*'keydown',\s*key:\s*'(\w+)'/g)].map((m) => m[1]);
  assert.ok(keys.length >= 4, 'expected the client to send several keys');
  for (const k of keys) assert.ok(k in VK, `client sends key "${k}" but input.js has no VK for it`);
});

test('keychar: escapes SendKeys metacharacters; rejects empty, oversized and non-string input', () => {
  handleInput({ type: 'keychar', char: 'a' });
  handleInput({ type: 'keychar', char: '+' });
  handleInput({ type: 'keychar', char: '' });
  handleInput({ type: 'keychar', char: 'x'.repeat(9) });
  handleInput({ type: 'keychar', char: 5 });
  handleInput({ type: 'keychar' });
  assert.deepEqual(sent, [{ t: 'txt', s: 'a' }, { t: 'txt', s: '{+}' }]);
});

test('malformed events never throw and never send', () => {
  for (const e of [null, undefined, 5, 'str', [], {}, { type: 'ping' }, { type: 'bogus' }]) {
    assert.doesNotThrow(() => handleInput(e));
  }
  assert.deepEqual(sent, []);
});

test('escapeSendKeys wraps every SendKeys metacharacter exactly once', () => {
  assert.equal(escapeSendKeys('+'), '{+}');
  assert.equal(escapeSendKeys('('), '{(}');
  assert.equal(escapeSendKeys('{'), '{{}');
  assert.equal(escapeSendKeys('}'), '{}}');
  assert.equal(escapeSendKeys('[]'), '{[}{]}');
  assert.equal(escapeSendKeys('a^b%c~'), 'a{^}b{%}c{~}');
  assert.equal(escapeSendKeys('hello world'), 'hello world');
});

// ─── real daemon lifecycle (no input is injected) ────────────────────────────
test('stopDaemon does not trigger the crash-restart loop', async () => {
  const logs = [];
  const origLog = console.log, origWarn = console.warn;
  console.log = (...a) => logs.push(a.join(' '));
  console.warn = (...a) => logs.push(a.join(' '));
  try {
    input.startDaemon();
    await new Promise((r) => setTimeout(r, 300));
    input.stopDaemon();
    await new Promise((r) => setTimeout(r, 3000)); // longer than the 2s restart delay
  } finally { console.log = origLog; console.warn = origWarn; }
  assert.equal(logs.filter((l) => /Starting PowerShell/.test(l)).length, 1, `daemon respawned after stop: ${logs.join(' | ')}`);
  assert.equal(logs.filter((l) => /restarting/.test(l)).length, 0, 'must not schedule a restart after an intentional stop');
});
