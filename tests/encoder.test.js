const { test } = require('node:test');
const assert = require('node:assert/strict');
const { encoderArgs, pickEncoder, pixFmt, CANDIDATES } = require('../src/encoder');
const { buildH264Args, evenSize } = require('../src/capture');

test('every candidate encoder yields low-latency args with the requested bitrate and GOP', () => {
  for (const name of CANDIDATES) {
    const a = encoderArgs(name, { bitrateMbps: 12, gop: 45 });
    assert.equal(a[a.indexOf('-c:v') + 1], name);
    assert.equal(a[a.indexOf('-b:v') + 1], '12M');
    assert.equal(a[a.indexOf('-g') + 1], '45');
    assert.equal(a[a.indexOf('-bf') + 1], '0', 'B-frames add latency');
  }
  assert.throws(() => encoderArgs('h264_bogus'), /Unknown encoder/);
});

test('pickEncoder prefers hardware, honours a preference, and falls through failures', () => {
  assert.equal(pickEncoder('auto', () => true), 'h264_qsv');
  assert.equal(pickEncoder('auto', (n) => n === 'libx264'), 'libx264');
  assert.equal(pickEncoder('h264_nvenc', () => true), 'h264_nvenc');
  assert.equal(pickEncoder('h264_nvenc', (n) => n !== 'h264_nvenc'), 'h264_qsv', 'preferred encoder failed to init');
  assert.equal(pickEncoder('auto', () => false), null);
  assert.equal(pickEncoder('not-an-encoder', (n) => n === 'h264_amf'), 'h264_amf', 'unknown preference is ignored');
});

test('hardware encoders take nv12, software x264 takes yuv420p', () => {
  assert.equal(pixFmt('h264_qsv'), 'nv12');
  assert.equal(pixFmt('libx264'), 'yuv420p');
});

test('buildH264Args: gdigrab input, scaled, raw h264 to stdout', () => {
  const a = buildH264Args({ bounds: { x: 3840, y: 0, w: 1668, h: 1024 }, fps: 30, outW: 1668, outH: 1024, encoder: 'h264_qsv', bitrateMbps: 8, gop: 30 });
  const s = a.join(' ');
  assert.ok(s.includes('-offset_x 3840'));
  assert.ok(s.includes('-video_size 1668x1024'));
  assert.equal(a[a.indexOf('-vf') + 1], 'fps=30,scale=1668:1024,format=nv12');
  assert.equal(a.at(-1), 'pipe:1');
  assert.equal(a[a.length - 2], 'h264');
  assert.equal(a[a.length - 3], '-f');
});

test('evenSize rounds odd dimensions down', () => {
  assert.deepEqual(evenSize({ w: 1667, h: 1023 }), { w: 1666, h: 1022 });
  assert.deepEqual(evenSize({ w: 1668, h: 1024 }), { w: 1668, h: 1024 });
});
