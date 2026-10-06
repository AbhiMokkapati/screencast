const { test } = require('node:test');
const assert   = require('node:assert/strict');
const path     = require('path');
const { getMonitorBounds, computeOutputSize, buildFfmpegArgs, createFrameParser } = require('../src/capture');

const monitorExists = (i) => { try { getMonitorBounds(i); return true; } catch { return false; } };
// Hardware-specific: only meaningful on a machine with the iPad virtual display installed.
const hasVirtual = (() => { try { const b = getMonitorBounds(1); return b.w === 1668 && b.h === 1024; } catch { return false; } })();

test('monitor 0 (primary) returns positive dimensions', () => {
  const b = getMonitorBounds(0);
  assert.equal(typeof b.x, 'number', 'x must be a number');
  assert.equal(typeof b.y, 'number', 'y must be a number');
  assert.ok(!isNaN(b.w) && b.w > 0, `width must be positive, got ${b.w}`);
  assert.ok(!isNaN(b.h) && b.h > 0, `height must be positive, got ${b.h}`);
  assert.equal(b.x, 0, 'primary monitor x offset should be 0');
  assert.equal(b.y, 0, 'primary monitor y offset should be 0');
});

test('monitor 1 (virtual iPad display) is 1668x1024',
  { skip: !hasVirtual && 'no 1668x1024 virtual display on this machine' }, () => {
  const b = getMonitorBounds(1);
  assert.equal(b.w, 1668);
  assert.equal(b.h, 1024);
  assert.ok(b.x !== 0 || b.y !== 0, 'virtual monitor must not overlap primary at (0,0)');
});

test('bounds values are all finite integers', () => {
  for (const idx of [0, 1].filter(monitorExists)) {
    for (const [k, v] of Object.entries(getMonitorBounds(idx))) {
      assert.ok(Number.isInteger(v), `monitor ${idx}.${k} = ${v} is not a finite integer`);
    }
  }
});

test('out-of-range monitor index throws with helpful message', () => {
  assert.throws(
    () => getMonitorBounds(99),
    (err) => {
      assert.ok(err.message.includes('99') || err.message.toLowerCase().includes('not found'), err.message);
      return true;
    }
  );
});

test('getMonitorBounds rejects NaN, negative and fractional indexes before running PowerShell', () => {
  // -1 would otherwise select the LAST screen via $screens[-1]
  for (const bad of [NaN, -1, 1.5, undefined, '1', null]) {
    assert.throws(() => getMonitorBounds(bad), /Invalid monitor index/, `index ${String(bad)}`);
  }
});

test('startCapture reports a missing ffmpeg as an error event instead of crashing', async () => {
  const { startCapture } = require('../src/capture');
  const origPath = process.env.PATH;
  // keep only the PowerShell dir so bounds lookup works but ffmpeg cannot be found
  process.env.PATH = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0');
  let cap;
  try { cap = startCapture({ monitorIndex: 0 }); } finally { process.env.PATH = origPath; }
  const err = await new Promise((resolve) => cap.once('error', resolve));
  assert.match(err.message, /ffmpeg/);
});

// ─── output sizing / ffmpeg args ─────────────────────────────────────────────
test('computeOutputSize keeps aspect ratio when only one dimension is given', () => {
  const b = { x: 0, y: 0, w: 1668, h: 1024 };
  assert.deepEqual(computeOutputSize(b), { w: 1668, h: 1024 });
  assert.deepEqual(computeOutputSize(b, 834), { w: 834, h: 512 });
  assert.deepEqual(computeOutputSize(b, undefined, 512), { w: 834, h: 512 });
  assert.deepEqual(computeOutputSize(b, 800, 600), { w: 800, h: 600 });
});

test('buildFfmpegArgs targets the monitor rectangle and requested fps/quality/size', () => {
  const args = buildFfmpegArgs({ bounds: { x: -1920, y: 10, w: 1920, h: 1080 }, fps: 24, quality: 7, outW: 960, outH: 540 });
  const get = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(get('-offset_x'), '-1920');
  assert.equal(get('-offset_y'), '10');
  assert.equal(get('-video_size'), '1920x1080');
  assert.equal(get('-framerate'), '24');
  assert.equal(get('-q:v'), '7');
  assert.equal(get('-vf'), 'fps=24,scale=960:540');
  assert.equal(args.at(-1), 'pipe:1');
  assert.ok(args.every((a) => typeof a === 'string'), 'spawn args must all be strings');
});

// ─── MJPEG frame parser ──────────────────────────────────────────────────────
const jpeg = (...body) => Buffer.from([0xff, 0xd8, ...body, 0xff, 0xd9]);
function collect() {
  const frames = [];
  return { frames, push: createFrameParser((f) => frames.push(f)) };
}

test('frame parser emits each complete frame from one chunk', () => {
  const { frames, push } = collect();
  const a = jpeg(1, 2, 3), b = jpeg(9);
  push(Buffer.concat([a, b]));
  assert.deepEqual(frames, [a, b]);
});

test('frame parser reassembles frames split at every possible byte boundary', () => {
  const a = jpeg(0xff, 0x00, 5, 6), b = jpeg(7, 8);   // 0xff00 is JPEG byte-stuffing
  const stream = Buffer.concat([a, b]);
  for (let cut = 1; cut < stream.length; cut++) {
    const { frames, push } = collect();
    push(stream.subarray(0, cut));
    push(stream.subarray(cut));
    assert.deepEqual(frames, [a, b], `split at ${cut}`);
  }
});

test('frame parser works byte-by-byte and discards leading/inter-frame garbage', () => {
  const a = jpeg(1, 2, 3);
  const { frames, push } = collect();
  for (const byte of Buffer.concat([Buffer.from([0, 0xff, 7]), a, Buffer.from([0x55]), a])) push(Buffer.from([byte]));
  assert.deepEqual(frames, [a, a]);
});

test('frame parser does not emit a truncated frame', () => {
  const { frames, push } = collect();
  push(Buffer.from([0xff, 0xd8, 1, 2, 3]));
  assert.equal(frames.length, 0);
});

test('frame parser emits copies, not views into its internal buffer', () => {
  const { frames, push } = collect();
  push(Buffer.concat([jpeg(1, 2, 3), jpeg(4)]));
  frames[0].fill(0);
  push(jpeg(5));
  assert.deepEqual(frames[1], jpeg(4));
  assert.deepEqual(frames[2], jpeg(5));
});
