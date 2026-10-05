const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { listMonitors, checkVirtualDisplayDriver, getSetupGuide } = require('../src/display');

test('listMonitors returns a non-empty array', () => {
  const monitors = listMonitors();
  assert.ok(Array.isArray(monitors), 'should return an array');
  assert.ok(monitors.length >= 1, `should have at least 1 monitor, got ${monitors.length}`);
});

test('every monitor has required numeric fields', () => {
  const monitors = listMonitors();
  for (const m of monitors) {
    for (const field of ['index', 'x', 'y', 'w', 'h']) {
      assert.ok(field in m, `monitor is missing field "${field}"`);
      assert.ok(Number.isFinite(m[field]), `monitor.${field} = ${m[field]} is not a finite number`);
    }
    assert.ok(m.w > 0, `monitor ${m.index} width must be positive`);
    assert.ok(m.h > 0, `monitor ${m.index} height must be positive`);
  }
});

test('exactly one monitor is marked primary', () => {
  const monitors = listMonitors();
  const primaries = monitors.filter(m => m.primary);
  assert.equal(primaries.length, 1, `expected 1 primary monitor, found ${primaries.length}`);
});

test('virtual iPad monitor (1668x1024) is present', () => {
  const monitors = listMonitors();
  const virtual = monitors.find(m => m.w === 1668 && m.h === 1024);
  assert.ok(virtual, `expected a 1668x1024 monitor — run: npm run list-displays`);
  assert.equal(virtual.primary, 0, 'virtual monitor should not be primary');
});

test('monitor indices are 0-based and sequential', () => {
  const monitors = listMonitors();
  monitors.forEach((m, i) => {
    assert.equal(m.index, i, `monitor at position ${i} has index ${m.index}, expected ${i}`);
  });
});

test('checkVirtualDisplayDriver returns string or null (not undefined)', () => {
  const result = checkVirtualDisplayDriver();
  assert.ok(result === null || typeof result === 'string',
    `expected string or null, got ${typeof result}`);
});

test('getSetupGuide returns object with steps array', () => {
  const guide = getSetupGuide();
  assert.ok(guide && typeof guide === 'object', 'should return an object');
  assert.ok(Array.isArray(guide.steps), 'should have a steps array');
  assert.ok(guide.steps.length > 0, 'steps should not be empty');
  assert.ok(typeof guide.recommended === 'string', 'should have a recommended field');
});
