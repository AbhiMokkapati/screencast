const { execSync, exec } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

function runPS(scriptLines) {
  const tmp = path.join(os.tmpdir(), `screencast-ps-${process.pid}-${Date.now()}.ps1`);
  fs.writeFileSync(tmp, scriptLines.join('\r\n'), 'utf8');
  try {
    return execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmp}"`, {
      timeout: 8000,
    }).toString().trim();
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

/**
 * Returns an array of monitor descriptors:
 * [{ index, primary, x, y, w, h, name }]
 */
function listMonitors() {
  const raw = runPS([
    'Add-Type -Assembly System.Windows.Forms',
    '$screens = [System.Windows.Forms.Screen]::AllScreens',
    '$out = @()',
    'for ($i = 0; $i -lt $screens.Count; $i++) {',
    '  $s = $screens[$i]',
    '  $out += [PSCustomObject]@{',
    '    index   = $i',
    '    primary = [int]$s.Primary',
    '    x       = $s.Bounds.X',
    '    y       = $s.Bounds.Y',
    '    w       = $s.Bounds.Width',
    '    h       = $s.Bounds.Height',
    '    name    = $s.DeviceName',
    '  }',
    '}',
    '$out | ConvertTo-Json -Compress',
  ]);

  // Strip BOM/whitespace PowerShell may prepend
  const clean = raw.replace(/^﻿/, '').trim();
  const parsed = JSON.parse(clean);
  // Single monitor: PowerShell returns an object, not an array
  return Array.isArray(parsed) ? parsed : [parsed];
}

/**
 * Checks whether virtual-display-rs CLI is on PATH.
 * Returns the version string or null.
 */
function checkVirtualDisplayDriver() {
  try {
    const out = execSync('virtual-display-driver-cli --version 2>&1', {
      timeout: 3000,
    }).toString().trim();
    return out;
  } catch {
    return null;
  }
}

/**
 * Adds a virtual monitor via virtual-display-rs.
 * Returns { ok, message }.
 */
function addVirtualMonitor({ width = 1920, height = 1080, refreshRate = 60 } = {}) {
  return new Promise((resolve) => {
    const cmd = `virtual-display-driver-cli add --width ${width} --height ${height} --refresh-rate ${refreshRate}`;
    exec(cmd, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, message: stderr || err.message });
      } else {
        resolve({ ok: true, message: stdout.trim() || 'Virtual monitor added' });
      }
    });
  });
}

/**
 * Returns a human-readable setup guide for installing a virtual display driver.
 */
function getSetupGuide() {
  return {
    recommended: 'virtual-display-rs',
    steps: [
      'Download the latest release from https://github.com/MolotovCherry/virtual-display-rs/releases',
      'Run the installer (requires Admin). A new monitor will appear in Windows Display Settings.',
      'In Display Settings, set the virtual monitor resolution to match your iPad:',
      '  • iPad Pro 11"   → 1668 × 1024 (landscape)',
      '  • iPad Pro 12.9" → 2048 × 1366 (landscape)',
      '  • iPad Air / mini → 1640 × 1024 (landscape)',
      'Run: npm start (the server auto-detects which monitor index is the new one)',
    ],
    alternative: 'Parsec Virtual Display (parsec.app) also works — free, no account needed for the driver alone.',
  };
}

module.exports = { listMonitors, checkVirtualDisplayDriver, addVirtualMonitor, getSetupGuide };
