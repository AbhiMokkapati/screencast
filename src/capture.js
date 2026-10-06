const { spawn, execSync } = require('child_process');
const { EventEmitter } = require('events');

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

/**
 * Returns { x, y, w, h } for a monitor by index (0 = primary).
 * Writes a temp .ps1 file to avoid inline quoting issues with -Command.
 */
function getMonitorBounds(index) {
  // index is interpolated into a PowerShell script: reject NaN, fractions and negatives
  // (a negative index would silently select the *last* screen via $screens[-1]).
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`Invalid monitor index "${index}": must be a non-negative integer`);
  }
  const fs   = require('fs');
  const path = require('path');
  const tmp  = path.join(require('os').tmpdir(), `screencast-monitor-${index}.ps1`);

  fs.writeFileSync(tmp, [
    'Add-Type -Assembly System.Windows.Forms',
    `$screens = [System.Windows.Forms.Screen]::AllScreens`,
    `if (${index} -ge $screens.Count) { Write-Error "Monitor ${index} not found"; exit 1 }`,
    `$s = $screens[${index}]`,
    `Write-Output "$($s.Bounds.X),$($s.Bounds.Y),$($s.Bounds.Width),$($s.Bounds.Height)"`,
  ].join('\r\n'));

  try {
    const out = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmp}"`, {
      timeout: 8000,
    }).toString().trim();

    // Strip any ANSI/BOM/whitespace the PS runtime may prepend
    const clean = out.replace(/[^\d,\-]/g, '').replace(/^,+|,+$/g, '');
    const parts = clean.split(',').map(Number);
    if (parts.length !== 4 || parts.some(isNaN)) {
      throw new Error(`Unexpected output: "${out}"`);
    }
    const [x, y, w, h] = parts;
    return { x, y, w, h };
  } catch (err) {
    throw new Error(
      `Could not read bounds for monitor ${index}: ${err.message}\n` +
      `Run:  powershell "[System.Windows.Forms.Screen]::AllScreens | Format-Table"`
    );
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}


/**
 * Output frame size. If only one of scaleWidth/scaleHeight is given, the other is derived
 * from the monitor's aspect ratio (otherwise the picture is stretched).
 */
function computeOutputSize(bounds, scaleWidth, scaleHeight) {
  if (scaleWidth && scaleHeight) return { w: scaleWidth, h: scaleHeight };
  if (scaleWidth)  return { w: scaleWidth,  h: Math.max(1, Math.round(scaleWidth  * bounds.h / bounds.w)) };
  if (scaleHeight) return { w: Math.max(1, Math.round(scaleHeight * bounds.w / bounds.h)), h: scaleHeight };
  return { w: bounds.w, h: bounds.h };
}

function buildFfmpegArgs({ bounds, fps, quality, outW, outH }) {
  return [
    '-loglevel', 'warning',
    '-f', 'gdigrab',
    '-framerate', String(fps),
    '-offset_x', String(bounds.x),
    '-offset_y', String(bounds.y),
    '-video_size', `${bounds.w}x${bounds.h}`,
    '-draw_mouse', '1',
    '-i', 'desktop',
    '-vf', `fps=${fps},scale=${outW}:${outH}`,
    '-f', 'mjpeg',
    '-q:v', String(quality),
    'pipe:1',
  ];
}

const MAX_FRAME_BYTES = 32 * 1024 * 1024; // a "frame" with no EOI this long is garbage

/**
 * Splits a raw MJPEG byte stream into complete JPEG frames (SOI..EOI).
 * Returns push(chunk); onFrame(Buffer) is called once per complete frame.
 * Handles markers split across chunk boundaries and discards leading garbage.
 */
function createFrameParser(onFrame) {
  let buf = Buffer.alloc(0);
  let eoiFrom = 0;
  return function push(chunk) {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      const soi = buf.indexOf(SOI);
      if (soi === -1) {
        buf = buf.length > 1 ? buf.subarray(buf.length - 1) : buf; // keep a possible split 0xFF
        eoiFrom = 0;
        return;
      }
      if (soi > 0) { buf = buf.subarray(soi); eoiFrom = 0; }
      const eoi = buf.indexOf(EOI, Math.max(2, eoiFrom));
      if (eoi === -1) {
        if (buf.length > MAX_FRAME_BYTES) { buf = Buffer.alloc(0); eoiFrom = 0; }
        else eoiFrom = Math.max(0, buf.length - 1); // EOI may straddle the next chunk
        return;
      }
      onFrame(Buffer.from(buf.subarray(0, eoi + 2)));
      buf = buf.subarray(eoi + 2);
      eoiFrom = 0;
    }
  };
}

/**
 * Starts FFmpeg screen capture for a specific monitor.
 * Emits 'frame' (Buffer containing a complete JPEG) and 'error' (Error).
 *
 * Options:
 *   monitorIndex  — 0 = primary, 1 = secondary (virtual display), etc.
 *   fps           — frames per second (default 30)
 *   quality       — JPEG quality 2–31, lower = better (default 5)
 *   scaleWidth    — output width in px (default: native monitor width)
 *   scaleHeight   — output height in px (default: native monitor height)
 */
function startCapture({
  monitorIndex = 1,
  fps = 30,
  quality = 5,
  scaleWidth,
  scaleHeight,
} = {}) {
  const emitter = new EventEmitter();

  const bounds = getMonitorBounds(monitorIndex);
  const { w: outW, h: outH } = computeOutputSize(bounds, scaleWidth, scaleHeight);

  console.log(
    `[capture] Monitor ${monitorIndex}: ${bounds.w}x${bounds.h} at (${bounds.x},${bounds.y}) → output ${outW}x${outH} @ ${fps}fps`
  );

  // Expose the actual output dimensions so input.js can map touch coords correctly
  emitter.outputWidth = outW;
  emitter.outputHeight = outH;
  emitter.monitorBounds = bounds;

  const args = buildFfmpegArgs({ bounds, fps, quality, outW, outH });

  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

  proc.stderr.on('data', (d) => {
    const s = d.toString().trim();
    if (s) console.error('[ffmpeg]', s);
  });

  // Spawn failure (e.g. ffmpeg not on PATH) is async; without a listener it crashes the process.
  let spawnFailed = false;
  proc.on('error', (err) => {
    spawnFailed = true;
    emitter.emit('error', new Error(`could not run ffmpeg: ${err.message}`));
  });

  proc.on('close', (code) => {
    // A failed spawn also fires 'close'; reporting it again would throw if the first
    // error was handled by a one-shot listener.
    if (!spawnFailed && code !== 0 && code !== null) {
      emitter.emit('error', new Error(`ffmpeg exited with code ${code}`));
    }
  });

  proc.stdout.on('data', createFrameParser((frame) => emitter.emit('frame', frame)));

  emitter.stop = () => proc.kill('SIGTERM');
  return emitter;
}

module.exports = { startCapture, getMonitorBounds, computeOutputSize, buildFfmpegArgs, createFrameParser };
