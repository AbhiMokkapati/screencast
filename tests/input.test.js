const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

// We re-require with cache-busting so stopDaemon actually cleans up between test runs.
// The daemon takes ~2-3s to compile C# on first launch — we start it once and reuse.
let handleInput, setMonitorContext, stopDaemon;

before(() => {
  // Clear cached module so we get a fresh daemon
  delete require.cache[require.resolve('../src/input')];
  ({ handleInput, setMonitorContext, stopDaemon } = require('../src/input'));
});

after(() => {
  stopDaemon();
});

test('module exports the three expected functions', () => {
  assert.equal(typeof handleInput,      'function', 'handleInput must be a function');
  assert.equal(typeof setMonitorContext, 'function', 'setMonitorContext must be a function');
  assert.equal(typeof stopDaemon,        'function', 'stopDaemon must be a function');
});

test('setMonitorContext accepts valid bounds without throwing', () => {
  assert.doesNotThrow(() => setMonitorContext({ x: 1920, y: 0, w: 1668, h: 1024 }));
});

test('handleInput does not throw for all valid event types', () => {
  const events = [
    { type: 'mousemove', x: 0.5,  y: 0.5  },
    { type: 'mousedown', x: 0.25, y: 0.75, button: 0 },
    { type: 'mousedown', x: 0.25, y: 0.75, button: 2 },
    { type: 'mouseup',   x: 0.25, y: 0.75, button: 0 },
    { type: 'mouseup',   x: 0.25, y: 0.75, button: 2 },
    { type: 'scroll',    x: 0.5,  y: 0.5,  dy:  0.5  },
    { type: 'scroll',    x: 0.5,  y: 0.5,  dy: -0.5  },
    { type: 'keydown',   key: 'Escape'     },
    { type: 'keydown',   key: 'Enter'      },
    { type: 'keydown',   key: 'Meta'       },
    { type: 'keydown',   key: 'ArrowLeft'  },
    { type: 'keydown',   key: 'UnknownKey' }, // unknown key — should be silently ignored
    { type: 'keychar',   char: 'a'         },
    { type: 'keychar',   char: ' '         },
    { type: 'ping'                         }, // unknown type — should be silently ignored
    { type: 'unknown_event_type'           },
  ];
  for (const e of events) {
    assert.doesNotThrow(() => handleInput(e), `handleInput threw for event: ${JSON.stringify(e)}`);
  }
});

test('handleInput does not throw for out-of-bounds normalized coords', () => {
  // Coords outside 0-1 range (e.g. edge scroll) should not crash
  const edgeCases = [
    { type: 'mousemove', x: 0,    y: 0    },
    { type: 'mousemove', x: 1,    y: 1    },
    { type: 'mousemove', x: -0.1, y: 1.1  }, // outside bounds
    { type: 'scroll',    x: 0.5,  y: 0.5, dy: 0 },
  ];
  for (const e of edgeCases) {
    assert.doesNotThrow(() => handleInput(e));
  }
});

test('handleInput does not throw with missing optional fields', () => {
  assert.doesNotThrow(() => handleInput({ type: 'scroll',   x: 0.5, y: 0.5 })); // missing dy
  assert.doesNotThrow(() => handleInput({ type: 'mousedown', x: 0.5, y: 0.5 })); // missing button
  assert.doesNotThrow(() => handleInput({ type: 'keychar' })); // missing char
  assert.doesNotThrow(() => handleInput({}));                   // missing everything
  assert.doesNotThrow(() => handleInput(null));                 // null
});

test('escapeSendKeys wraps every SendKeys metacharacter exactly once', () => {
  const { escapeSendKeys } = require('../src/input');
  assert.equal(escapeSendKeys('+'), '{+}');
  assert.equal(escapeSendKeys('('), '{(}');
  assert.equal(escapeSendKeys('{'), '{{}');
  assert.equal(escapeSendKeys('}'), '{}}');
  assert.equal(escapeSendKeys('a^b%c~'), 'a{^}b{%}c{~}');
  assert.equal(escapeSendKeys('hello world'), 'hello world');
});
