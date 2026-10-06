const fs   = require('fs');
const path = require('path');

/**
 * Reads screencast.config.json from `dir`. Returns {} if missing or invalid.
 * Windows PowerShell 5.1 writes UTF-8 files with a BOM, which JSON.parse rejects,
 * so strip it before parsing.
 */
function loadConfig(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, 'screencast.config.json'), 'utf8');
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// First candidate that parses to an integer within [min, max]; otherwise the fallback.
// An env var of "" or "abc", or a config value of null, must never reach ffmpeg/listen as NaN.
function pickInt(candidates, min, max, fallback) {
  for (const c of candidates) {
    if (c === undefined || c === null || c === '') continue;
    const n = typeof c === 'number' ? c : (/^\s*-?\d+\s*$/.test(String(c)) ? parseInt(c, 10) : NaN);
    if (Number.isInteger(n) && n >= min && n <= max) return n;
  }
  return fallback;
}

function pickChoice(candidates, allowed, fallback) {
  for (const c of candidates) {
    const v = typeof c === 'string' ? c.trim().toLowerCase() : c;
    if (allowed.includes(v)) return v;
  }
  return fallback;
}

function pickBool(candidates, fallback) {
  for (const c of candidates) {
    if (c === true || c === false) return c;
    if (typeof c === 'string') {
      const v = c.trim().toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(v)) return true;
      if (['0', 'false', 'no', 'off'].includes(v)) return false;
    }
  }
  return fallback;
}

/**
 * Merge env vars (highest priority), the config file, and defaults into runtime settings.
 * Out-of-range or non-numeric values are ignored rather than passed along.
 */
function resolveSettings(env = process.env, file = {}) {
  return {
    port:    pickInt([env.PORT, file.port], 1, 65535, 9001),
    monitor: pickInt([env.MONITOR, file.monitor], 0, 64, 1),
    fps:     pickInt([env.FPS, file.fps], 1, 120, 30),
    quality: pickInt([env.QUALITY, file.quality], 2, 31, 5),
    scaleW:  pickInt([env.SCALE_W, file.scaleW], 16, 16384, undefined),
    scaleH:  pickInt([env.SCALE_H, file.scaleH], 16, 16384, undefined),
    // 'h264' (needs HTTPS: Safari only exposes WebCodecs on secure pages) or 'mjpeg' (works on plain HTTP)
    codec:   pickChoice([env.CODEC, file.codec], ['h264', 'mjpeg'], 'h264'),
    codecExplicit: pickChoice([env.CODEC, file.codec], ['h264', 'mjpeg'], null) !== null,
    // 'auto' tries QSV, NVENC, AMF, then software x264
    encoder: pickChoice([env.ENCODER, file.encoder], ['auto', 'h264_qsv', 'h264_nvenc', 'h264_amf', 'libx264'], 'auto'),
    bitrate: pickInt([env.BITRATE, file.bitrate], 1, 100, 8),
    https:   pickBool([env.SCREENCAST_HTTPS, file.https], true),
    caPort:  pickInt([env.CA_PORT, file.caPort], 1, 65535, undefined),
    token:   [env.SCREENCAST_TOKEN, file.token].map((t) => (typeof t === 'string' ? t : (typeof t === 'number' ? String(t) : ''))).find(Boolean) || '',
  };
}

module.exports = { loadConfig, resolveSettings };
