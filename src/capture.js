const { spawn, execSync } = require('child_process');
const { EventEmitter } = require('events');

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

/**
 * Returns { x, y, w, h } for a monitor by index (0 = primary).
 * Writes a temp .ps1 file to avoid inline quoting issues with -Command.
 */
function getMonitorBounds(index) {
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
  const outW = scaleWidth || bounds.w;
  const outH = scaleHeight || bounds.h;

  console.log(
    `[capture] Monitor ${monitorIndex}: ${bounds.w}x${bounds.h} at (${bounds.x},${bounds.y}) → output ${outW}x${outH} @ ${fps}fps`
  );

  // Expose the actual output dimensions so input.js can map touch coords correctly
  emitter.outputWidth = outW;
  emitter.outputHeight = outH;
  emitter.monitorBounds = bounds;

  const args = [
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

  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

  proc.stderr.on('data', (d) => {
    const s = d.toString().trim();
    if (s) console.error('[ffmpeg]', s);
  });

  proc.on('close', (code) => {
    if (code !== 0 && code !== null) {
      emitter.emit('error', new Error(`ffmpeg exited with code ${code}`));
    }
  });

  // Parse raw MJPEG byte stream into discrete JPEG frames
  let buf = Buffer.alloc(0);
  let searchFrom = 0;

  proc.stdout.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);

    while (true) {
      const soiIdx = buf.indexOf(SOI, searchFrom);
      if (soiIdx === -1) {
        buf = buf.length > 1 ? buf.slice(buf.length - 1) : buf;
        searchFrom = 0;
        break;
      }

      const eoiIdx = buf.indexOf(EOI, soiIdx + 2);
      if (eoiIdx === -1) {
        searchFrom = soiIdx;
        break;
      }

      emitter.emit('frame', buf.slice(soiIdx, eoiIdx + 2));
      buf = buf.slice(eoiIdx + 2);
      searchFrom = 0;
    }
  });

  emitter.stop = () => proc.kill('SIGTERM');
  return emitter;
}

module.exports = { startCapture, getMonitorBounds };
