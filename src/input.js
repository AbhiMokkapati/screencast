/**
 * Input injection via a persistent PowerShell daemon.
 *
 * Spawns one PowerShell process at startup that stays alive.
 * Commands are written as JSON lines to its stdin — no per-event process spawn,
 * no native npm packages, no Visual Studio Build Tools required.
 *
 * The PS script compiles a tiny C# shim at first run (~300ms), then is instant.
 */

const { spawn } = require('child_process');

// PowerShell script: compiles a C# user32 wrapper, then loops reading JSON from stdin.
const PS_SCRIPT = String.raw`
$code = @"
using System;
using System.Runtime.InteropServices;
public class W32 {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, int data, IntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte sc, uint flags, IntPtr extra);
  public const uint LDown=0x0002, LUp=0x0004, RDown=0x0008, RUp=0x0010, Wheel=0x0800;
  public const uint KeyUp=0x0002;
}
"@
Add-Type -TypeDefinition $code -Language CSharp
Add-Type -Assembly System.Windows.Forms

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line.Length -eq 0) { continue }
  try {
    $c = $line | ConvertFrom-Json
    switch ($c.t) {
      'mv'   { [W32]::SetCursorPos($c.x, $c.y) | Out-Null }
      'ld'   { [W32]::mouse_event([W32]::LDown,  0,0,0,[IntPtr]::Zero) }
      'lu'   { [W32]::mouse_event([W32]::LUp,    0,0,0,[IntPtr]::Zero) }
      'rd'   { [W32]::mouse_event([W32]::RDown,  0,0,0,[IntPtr]::Zero) }
      'ru'   { [W32]::mouse_event([W32]::RUp,    0,0,0,[IntPtr]::Zero) }
      'wh'   { [W32]::mouse_event([W32]::Wheel,  0,0,$c.d,[IntPtr]::Zero) }
      'vk'   {
        [W32]::keybd_event($c.k, 0, 0, [IntPtr]::Zero)
        [W32]::keybd_event($c.k, 0, [W32]::KeyUp, [IntPtr]::Zero)
      }
      'txt'  {
        [System.Windows.Forms.SendKeys]::SendWait($c.s)
      }
    }
  } catch { }
}
`;

// Windows virtual-key codes for special keys
const VK = {
  Backspace: 0x08, Tab:     0x09, Enter:   0x0D, Return: 0x0D,
  Escape:    0x1B, Space:   0x20, Delete:  0x2E,
  ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28,
  Meta:      0x5B, // Windows key (LWIN)
  Control:   0xA2, Alt:     0xA4, Shift:   0xA0,
  F1:  0x70, F2:  0x71, F3:  0x72, F4:  0x73,
  F5:  0x74, F6:  0x75, F7:  0x76, F8:  0x77,
  F9:  0x78, F10: 0x79, F11: 0x7A, F12: 0x7B,
};

// SendKeys treats these as modifiers/grouping; each must be wrapped in braces to type literally.
// Done in one pass: escaping { and } separately would re-escape the braces added for other chars.
function escapeSendKeys(str) {
  return str.replace(/[+^%~(){}[\]]/g, '{$&}');
}

let proc = null;
let ready = false;

function startDaemon() {
  proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Don't let the daemon alone keep Node alive (lets tests exit; server stays up via HTTP).
  proc.unref();
  for (const st of [proc.stdin, proc.stdout, proc.stderr]) if (st.unref) st.unref();

  // First output from PS means the C# compiled and the loop is running
  proc.stdout.once('data', () => {
    ready = true;
    console.log('[input] PowerShell input daemon ready');
  });

  // Treat first stderr output as ready too (compilation messages go there)
  proc.stderr.once('data', () => {
    if (!ready) {
      ready = true;
      console.log('[input] PowerShell input daemon ready');
    }
  });

  proc.on('close', (code) => {
    ready = false;
    if (code !== 0) {
      console.warn(`[input] PS daemon exited (${code}), restarting in 2s…`);
      setTimeout(startDaemon, 2000);
    }
  });

  // Signal ready after a timeout even if we get no output (PS compiled silently)
  setTimeout(() => { ready = true; }, 3000);

  console.log('[input] Starting PowerShell input daemon…');
}

function send(obj) {
  if (!proc || !ready) return;
  try {
    proc.stdin.write(JSON.stringify(obj) + '\n');
  } catch { /* pipe closed, daemon restarting */ }
}

let monitorBounds = { x: 0, y: 0, w: 1920, h: 1080 };

function setMonitorContext(bounds) {
  monitorBounds = bounds;
}

function toScreen(nx, ny) {
  nx = Math.min(1, Math.max(0, Number(nx) || 0));
  ny = Math.min(1, Math.max(0, Number(ny) || 0));
  return {
    x: Math.round(monitorBounds.x + nx * monitorBounds.w),
    y: Math.round(monitorBounds.y + ny * monitorBounds.h),
  };
}

/**
 * Handle an input event from the iPad client.
 * Coords (x, y) are normalized 0–1 relative to the streamed frame.
 */
function handleInput(event) {
  if (!event || typeof event !== 'object') return;
  const { type } = event;

  switch (type) {
    case 'mousemove': {
      const { x, y } = toScreen(event.x, event.y);
      send({ t: 'mv', x, y });
      break;
    }
    case 'mousedown': {
      const { x, y } = toScreen(event.x, event.y);
      send({ t: 'mv', x, y });
      send({ t: event.button === 2 ? 'rd' : 'ld' });
      break;
    }
    case 'mouseup':
      send({ t: event.button === 2 ? 'ru' : 'lu' });
      break;

    case 'scroll': {
      const { x, y } = toScreen(event.x, event.y);
      send({ t: 'mv', x, y });
      // Windows: positive delta = scroll UP, so negate our "dy>0 = down" convention
      const delta = Math.round(-Math.max(-50, Math.min(50, Number(event.dy) || 0)) * 360);
      if (delta !== 0) send({ t: 'wh', d: delta });
      break;
    }
    case 'keydown': {
      const vk = VK[event.key];
      if (vk !== undefined) send({ t: 'vk', k: vk });
      break;
    }
    case 'keychar':
      if (typeof event.char === 'string' && event.char.length > 0 && event.char.length <= 8) send({ t: 'txt', s: escapeSendKeys(event.char) });
      break;
  }
}

function stopDaemon() {
  if (proc) {
    try { proc.stdin.end(); } catch { /* ignore */ }
    proc.kill();
  }
}

// Start the daemon immediately on module load
startDaemon();

module.exports = { handleInput, setMonitorContext, stopDaemon, escapeSendKeys };
