const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig, resolveSettings } = require('../src/config');

function withConfig(bytes, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-cfg-'));
  fs.writeFileSync(path.join(dir, 'screencast.config.json'), bytes);
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('config written by Windows PowerShell (UTF-8 with BOM) is still loaded', () => {
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"monitor":2,"fps":45}')]);
  assert.deepEqual(withConfig(bytes, loadConfig), { monitor: 2, fps: 45 });
});

test('plain UTF-8 config is loaded', () => {
  assert.deepEqual(withConfig('{"port":9100}', loadConfig), { port: 9100 });
});

test('missing or corrupt config falls back to empty defaults', () => {
  assert.deepEqual(loadConfig(path.join(os.tmpdir(), 'sc-no-such-dir')), {});
  assert.deepEqual(withConfig('{not json', loadConfig), {});
});

test('config that is valid JSON but not an object falls back to empty defaults', () => {
  for (const raw of ['null', '[1,2]', '"x"', '5']) assert.deepEqual(withConfig(raw, loadConfig), {}, raw);
});

test('resolveSettings: defaults', () => {
  assert.deepEqual(resolveSettings({}, {}), {
    port: 9001, monitor: 1, fps: 30, quality: 5, scaleW: undefined, scaleH: undefined, token: '',
    codec: 'h264', codecExplicit: false, encoder: 'auto', bitrate: 8, https: true, caPort: undefined,
  });
});

test('resolveSettings: codec / encoder / bitrate / https are validated, env beats file', () => {
  const r = resolveSettings({ CODEC: 'MJPEG', ENCODER: 'h264_nvenc', BITRATE: '20', SCREENCAST_HTTPS: 'off' },
    { codec: 'h264', encoder: 'libx264', bitrate: 4, https: true });
  assert.equal(r.codec, 'mjpeg');
  assert.equal(r.encoder, 'h264_nvenc');
  assert.equal(r.bitrate, 20);
  assert.equal(r.https, false);
  const bad = resolveSettings({ CODEC: 'vp9', ENCODER: 'rm -rf', BITRATE: '0', SCREENCAST_HTTPS: 'maybe' }, {});
  assert.deepEqual([bad.codec, bad.encoder, bad.bitrate, bad.https], ['h264', 'auto', 8, true]);
});

test('resolveSettings: MONITOR=0 is honoured (0 is falsy but valid) from env and file', () => {
  assert.equal(resolveSettings({ MONITOR: '0' }, { monitor: 2 }).monitor, 0);
  assert.equal(resolveSettings({}, { monitor: 0 }).monitor, 0);
});

test('resolveSettings: env overrides file, file overrides default', () => {
  const s = resolveSettings({ FPS: '60' }, { fps: 15, quality: 9, port: 9100 });
  assert.equal(s.fps, 60);
  assert.equal(s.quality, 9);
  assert.equal(s.port, 9100);
});

test('resolveSettings: garbage never becomes NaN or out-of-range (falls through to the next source)', () => {
  const s = resolveSettings({ PORT: 'abc', MONITOR: '-1', FPS: '', QUALITY: '99', SCALE_W: '1e3' },
                            { port: 9100, monitor: null, fps: '45', quality: 8, scaleW: 1280 });
  assert.equal(s.port, 9100);
  assert.equal(s.monitor, 1);
  assert.equal(s.fps, 45);
  assert.equal(s.quality, 8);
  assert.equal(s.scaleW, 1280);
});

test('resolveSettings: token from env beats file; numeric file token is stringified; empty env falls through', () => {
  assert.equal(resolveSettings({ SCREENCAST_TOKEN: 'envtok' }, { token: 'filetok' }).token, 'envtok');
  assert.equal(resolveSettings({}, { token: 12345 }).token, '12345');
  assert.equal(resolveSettings({ SCREENCAST_TOKEN: '' }, { token: 'filetok' }).token, 'filetok');
});

test('the committed screencast.config.json loads and resolves to sane values', () => {
  const file = loadConfig(path.join(__dirname, '..'));
  assert.notDeepEqual(file, {}, 'committed config must parse (BOM-safe)');
  const s = resolveSettings({}, file);
  assert.ok(s.port >= 1 && s.fps >= 1 && s.quality >= 2 && s.monitor >= 0);
});
