const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig } = require('../src/config');

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
