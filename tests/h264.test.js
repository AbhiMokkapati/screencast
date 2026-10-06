const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createH264Parser, createNalSplitter, buildAvcC, codecString, MSG_CONFIG, MSG_KEY, MSG_DELTA,
} = require('../src/h264');

const SC4 = Buffer.from([0, 0, 0, 1]);
const SC3 = Buffer.from([0, 0, 1]);
const nal = (type, ...body) => Buffer.from([type, ...body]);   // nal_ref_idc is irrelevant to the parser
const SPS = nal(0x67, 0x64, 0x00, 0x28, 0xac);
const PPS = nal(0x68, 0xee, 0x3c, 0x80);
const SEI = nal(0x06, 0x05, 0x01, 0x02);
const IDR = nal(0x65, 0x88, 0x84, 0x01);          // first_mb_in_slice = 0 (top bit of 2nd byte set)
const P   = (n) => nal(0x41, 0x9a, n, n);          // first_mb_in_slice = 0
const annexB = (...nals) => Buffer.concat(nals.flatMap((n, i) => [i % 2 ? SC3 : SC4, n]));
const lenPrefix = (n) => { const l = Buffer.alloc(4); l.writeUInt32BE(n.length); return Buffer.concat([l, n]); };

function run(stream, chunk = stream.length) {
  const out = { configs: [], frames: [] };
  const push = createH264Parser({ onConfig: (m) => out.configs.push(m), onFrame: (m, k) => out.frames.push({ m, k }) });
  for (let i = 0; i < stream.length; i += chunk) push(stream.subarray(i, i + chunk));
  return out;
}

test('NAL splitter handles 3- and 4-byte start codes and strips trailing zeros', () => {
  const got = [];
  const push = createNalSplitter((n) => got.push([...n]));
  push(Buffer.concat([SC4, nal(0x67, 1, 2), Buffer.from([0]), SC3, nal(0x68, 3), SC4, nal(0x65, 9)]));
  assert.deepEqual(got, [[0x67, 1, 2], [0x68, 3]], 'last NAL is held until the next start code proves it ended');
});

test('NAL splitter works when start codes straddle chunk boundaries (1-byte chunks)', () => {
  const stream = annexB(SPS, PPS, IDR, P(1), P(2));
  const a = run(stream);
  const b = run(stream, 1);
  assert.equal(b.frames.length, a.frames.length);
  assert.deepEqual(b.frames.map((f) => f.m.toString('hex')), a.frames.map((f) => f.m.toString('hex')));
});

test('emits an avcC config once, with SPS/PPS, and the right codec string', () => {
  const { configs } = run(annexB(SPS, PPS, IDR, SPS, PPS, IDR, P(1)));
  assert.equal(configs.length, 1, 'repeated identical SPS/PPS must not re-emit the config');
  assert.equal(configs[0][0], MSG_CONFIG);
  const avcc = configs[0].subarray(1);
  assert.deepEqual([...avcc.subarray(0, 4)], [1, 0x64, 0x00, 0x28]);
  assert.equal(avcc[4], 0xff);
  assert.equal(avcc[5], 0xe1);
  assert.equal(avcc.readUInt16BE(6), SPS.length);
  assert.deepEqual(avcc, buildAvcC(SPS, PPS));
  assert.equal(codecString(SPS), 'avc1.640028');
});

test('splits pictures: key frame vs delta, SPS/PPS excluded, NALs length-prefixed', () => {
  const { frames } = run(annexB(SPS, PPS, SEI, IDR, SEI, P(1), SEI, P(2), SEI, P(3)));
  // the last picture is still pending (no following NAL), so 3 complete pictures
  assert.equal(frames.length, 3);
  assert.deepEqual(frames.map((f) => f.k), [true, false, false]);
  assert.equal(frames[0].m[0], MSG_KEY);
  assert.equal(frames[1].m[0], MSG_DELTA);
  assert.deepEqual(frames[0].m.subarray(1), Buffer.concat([lenPrefix(SEI), lenPrefix(IDR)]),
    'parameter sets are not part of the sample; SEI + slice are');
});

test('pictures without SEI/AUD are split on first_mb_in_slice == 0', () => {
  const { frames } = run(annexB(SPS, PPS, IDR, P(1), P(2), P(3)));
  assert.equal(frames.length, 3);
});

test('multi-slice pictures stay together (second slice has first_mb != 0)', () => {
  const slice2 = nal(0x41, 0x4a, 7, 7); // top bit clear => first_mb_in_slice > 0
  const { frames } = run(annexB(SPS, PPS, IDR, P(1), slice2, P(2), P(3)));
  assert.equal(frames.length, 3);
  assert.equal(frames[1].m.subarray(1).length, lenPrefix(P(1)).length + lenPrefix(slice2).length,
    'both slices belong to one picture');
});

test('garbage before the first start code is discarded', () => {
  const { frames } = run(Buffer.concat([Buffer.from([1, 2, 3, 4, 5]), annexB(SPS, PPS, IDR, P(1), P(2))]));
  assert.equal(frames.length, 2);
  assert.equal(frames[0].k, true);
});
