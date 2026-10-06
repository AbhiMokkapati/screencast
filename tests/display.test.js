const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { listMonitors, checkVirtualDisplayDriver, getSetupGuide, addVirtualMonitor } = require('../src/display');

const monitors = listMonitors();

test('listMonitors returns a non-empty array', () => {
  assert.ok(Array.isArray(monitors));
  assert.ok(monitors.length >= 1, `should have at least 1 monitor, got ${monitors.length}`);
});

test('every monitor has required numeric fields', () => {
  for (const m of monitors) {
    for (const field of ['index', 'x', 'y', 'w', 'h']) {
      assert.ok(Number.isFinite(m[field]), `monitor.${field} = ${m[field]} is not a finite number`);
    }
    assert.ok(m.w > 0 && m.h > 0, `monitor ${m.index} must have positive size`);
  }
});

test('exactly one monitor is marked primary', () => {
  assert.equal(monitors.filter((m) => m.primary).length, 1);
});

test('virtual iPad monitor (1668x1024) is present',
  { skip: !monitors.some((m) => m.w === 1668 && m.h === 1024) && 'no 1668x1024 virtual display on this machine' }, () => {
  const virtual = monitors.find((m) => m.w === 1668 && m.h === 1024);
  assert.equal(virtual.primary, 0, 'virtual monitor should not be primary');
});

test('monitor indices are 0-based and sequential', () => {
  monitors.forEach((m, i) => assert.equal(m.index, i));
});

test('listMonitors indices agree with capture.getMonitorBounds (same coordinate space)', () => {
  const { getMonitorBounds } = require('../src/capture');
  for (const m of monitors) {
    assert.deepEqual(getMonitorBounds(m.index), { x: m.x, y: m.y, w: m.w, h: m.h });
  }
});

test('checkVirtualDisplayDriver returns string or null (not undefined)', () => {
  const result = checkVirtualDisplayDriver();
  assert.ok(result === null || typeof result === 'string', `got ${typeof result}`);
});

test('getSetupGuide returns object with steps array', () => {
  const guide = getSetupGuide();
  assert.ok(Array.isArray(guide.steps) && guide.steps.length > 0);
  assert.equal(typeof guide.recommended, 'string');
});

test('addVirtualMonitor rejects out-of-range or non-integer parameters without spawning anything', async () => {
  const bad = [{ width: 10 }, { height: 99999 }, { refreshRate: 1 }, { width: '1920; calc' }, { width: 1920.5 }, { refreshRate: NaN }];
  for (const b of bad) assert.equal((await addVirtualMonitor(b)).ok, false, JSON.stringify(b));
});
