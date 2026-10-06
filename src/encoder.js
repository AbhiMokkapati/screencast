const { spawnSync } = require('child_process');

// Hardware encoders first (they leave the CPU free and add almost no latency); libx264 always works.
const CANDIDATES = ['h264_qsv', 'h264_nvenc', 'h264_amf', 'libx264'];

function pixFmt(name) { return name === 'libx264' ? 'yuv420p' : 'nv12'; }

/** Encoder-specific ffmpeg args tuned for low latency: CBR-ish, no B-frames, no lookahead. */
function encoderArgs(name, { bitrateMbps = 8, gop = 30 } = {}) {
  const b = `${bitrateMbps}M`;
  // ~125 ms of video. Without a small rate-control buffer the encoder spends seconds of bitrate on each
  // key frame (500+ KB on an idle screen), and that burst shows up as a stall every GOP.
  const buf = `${Math.round(bitrateMbps * 125)}k`;
  const common = ['-g', String(gop), '-bf', '0', '-bufsize', buf];
  switch (name) {
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-b:v', b, '-maxrate', b, '-look_ahead', '0', '-async_depth', '1', ...common];
    case 'h264_nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', 'p1', '-tune', 'll', '-rc', 'cbr', '-b:v', b, '-zerolatency', '1', ...common];
    case 'h264_amf':
      return ['-c:v', 'h264_amf', '-usage', 'ultralowlatency', '-rc', 'cbr', '-b:v', b, ...common];
    case 'libx264':
      return ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-b:v', b, '-maxrate', b, ...common];
    default:
      throw new Error(`Unknown encoder "${name}"`);
  }
}

/** True if a short test encode with this encoder succeeds on this machine. */
function probe(name) {
  try {
    const r = spawnSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=10',
      '-frames:v', '8', '-vf', `format=${pixFmt(name)}`,
      ...encoderArgs(name), '-f', 'null', '-',
    ], { timeout: 20000 });
    return r.status === 0;
  } catch { return false; }
}

/**
 * Picks the encoder to use. `preferred` ('auto' or an encoder name) is tried first;
 * if it fails to initialise we fall through to the others. Returns null if none work.
 */
function pickEncoder(preferred = 'auto', probeFn = probe) {
  const order = preferred && preferred !== 'auto' && CANDIDATES.includes(preferred)
    ? [preferred, ...CANDIDATES.filter((c) => c !== preferred)]
    : CANDIDATES;
  for (const name of order) if (probeFn(name)) return name;
  return null;
}

module.exports = { CANDIDATES, encoderArgs, pickEncoder, pixFmt, probe };
