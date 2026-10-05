const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { getMonitorBounds } = require('../src/capture');

test('monitor 0 (primary) returns positive dimensions', () => {
  const b = getMonitorBounds(0);
  assert.equal(typeof b.x, 'number', 'x must be a number');
  assert.equal(typeof b.y, 'number', 'y must be a number');
  assert.ok(!isNaN(b.w) && b.w > 0, `width must be positive, got ${b.w}`);
  assert.ok(!isNaN(b.h) && b.h > 0, `height must be positive, got ${b.h}`);
  assert.equal(b.x, 0, 'primary monitor x offset should be 0');
  assert.equal(b.y, 0, 'primary monitor y offset should be 0');
});

test('monitor 1 (virtual iPad display) is 1668x1024', () => {
  const b = getMonitorBounds(1);
  assert.equal(b.w, 1668, `expected width 1668, got ${b.w}`);
  assert.equal(b.h, 1024, `expected height 1024, got ${b.h}`);
  assert.ok(b.x !== 0 || b.y !== 0, 'virtual monitor must not overlap primary at (0,0)');
});

test('bounds values are all finite integers', () => {
  for (const idx of [0, 1]) {
    const b = getMonitorBounds(idx);
    for (const [k, v] of Object.entries(b)) {
      assert.ok(Number.isFinite(v), `monitor ${idx}.${k} = ${v} is not a finite number`);
      assert.ok(Number.isInteger(v), `monitor ${idx}.${k} = ${v} is not an integer`);
    }
  }
});

test('out-of-range monitor index throws with helpful message', () => {
  assert.throws(
    () => getMonitorBounds(99),
    (err) => {
      assert.ok(err.message.includes('99') || err.message.toLowerCase().includes('not found'),
        `Error message should mention the index or "not found", got: ${err.message}`);
      return true;
    }
  );
});

const path = require('path');
test('startCapture reports a missing ffmpeg as an error event instead of crashing', async () => {
  const { startCapture } = require('../src/capture');
  const origPath = process.env.PATH;
  // keep only the PowerShell dir so bounds lookup works but ffmpeg cannot be found
  process.env.PATH = path.join(process.env.SystemRoot || 'C:\Windows', 'System32', 'WindowsPowerShell', 'v1.0');
  let cap;
  try { cap = startCapture({ monitorIndex: 0 }); } finally { process.env.PATH = origPath; }
  const err = await new Promise((resolve) => cap.once('error', resolve));
  assert.match(err.message, /ffmpeg/);
});
