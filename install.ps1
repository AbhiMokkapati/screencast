#Requires -Version 5.1
<#
.SYNOPSIS
  One-time setup for ScreenCast. Run as Administrator.
  Installs Node.js, FFmpeg, npm packages, guides virtual display setup,
  detects monitors, saves config, and creates a desktop shortcut.
#>

Set-StrictMode -Off
$ErrorActionPreference = 'Stop'
$ProjectDir = $PSScriptRoot

# ── Helpers ──────────────────────────────────────────────────────────────────

function Write-Step  ($msg) { Write-Host "`n  ► $msg" -ForegroundColor Cyan }
function Write-Ok    ($msg) { Write-Host "  ✓ $msg"  -ForegroundColor Green }
function Write-Warn  ($msg) { Write-Host "  ⚠ $msg"  -ForegroundColor Yellow }
function Write-Fail  ($msg) { Write-Host "  ✗ $msg"  -ForegroundColor Red }

function Confirm-Step ($question) {
  $ans = Read-Host "`n  $question [Y/n]"
  return ($ans -eq '' -or $ans -match '^[Yy]')
}

function Reload-Path {
  $env:PATH = [System.Environment]::GetEnvironmentVariable('PATH','Machine') + ';' +
              [System.Environment]::GetEnvironmentVariable('PATH','User')
}

# ── Banner ───────────────────────────────────────────────────────────────────

Clear-Host
Write-Host @"

  ╔══════════════════════════════════════════╗
  ║        ScreenCast  —  Installer          ║
  ║   Stream Windows to iPad, 100% free      ║
  ╚══════════════════════════════════════════╝

"@ -ForegroundColor Cyan

# ── Admin check ───────────────────────────────────────────────────────────────

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
  Write-Fail "Please run this script as Administrator."
  Write-Host "  Right-click PowerShell → Run as Administrator, then run: .\install.ps1"
  exit 1
}

# ── 1. Node.js ────────────────────────────────────────────────────────────────

Write-Step "Checking Node.js..."

if (Get-Command node -ErrorAction SilentlyContinue) {
  Write-Ok "Node.js $(node --version) already installed"
} else {
  Write-Warn "Node.js not found — installing via winget..."
  winget install --id OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements
  Reload-Path
  if (Get-Command node -ErrorAction SilentlyContinue) {
    Write-Ok "Node.js $(node --version) installed"
  } else {
    Write-Fail "Node.js install failed. Install manually from https://nodejs.org then re-run this script."
    exit 1
  }
}

# ── 2. FFmpeg ─────────────────────────────────────────────────────────────────

Write-Step "Checking FFmpeg..."

if (Get-Command ffmpeg -ErrorAction SilentlyContinue) {
  $ver = (ffmpeg -version 2>&1 | Select-String 'ffmpeg version').Line.Split(' ')[2]
  Write-Ok "FFmpeg $ver already installed"
} else {
  Write-Warn "FFmpeg not found — installing via winget..."
  winget install --id Gyan.FFmpeg --silent --accept-source-agreements --accept-package-agreements
  Reload-Path
  if (Get-Command ffmpeg -ErrorAction SilentlyContinue) {
    Write-Ok "FFmpeg installed"
  } else {
    Write-Fail "FFmpeg install failed. Install manually: winget install Gyan.FFmpeg"
    exit 1
  }
}

# ── 3. npm packages ───────────────────────────────────────────────────────────

Write-Step "Installing npm packages..."
Push-Location $ProjectDir
npm install --silent
if ($LASTEXITCODE -ne 0) { Write-Fail "npm install failed"; exit 1 }
Write-Ok "npm packages installed"
Pop-Location

# ── 4. Virtual display driver ─────────────────────────────────────────────────

Write-Step "Checking virtual display driver..."

$vddCli = Get-Command 'virtual-display-driver-cli' -ErrorAction SilentlyContinue

if ($vddCli) {
  Write-Ok "virtual-display-rs already installed"
} else {
  Write-Warn "No virtual display driver detected."
  Write-Host @"

  A virtual display driver makes Windows think your iPad is a real second
  monitor — this is required for true "extend display" mode.

  Recommended (free, open source): virtual-display-rs
  Download: https://github.com/MolotovCherry/virtual-display-rs/releases

  Steps:
    1. Download the .msi installer from the releases page
    2. Run it (requires Admin — you already are)
    3. Open Windows Display Settings and configure the new monitor's
       resolution to match your iPad:
         iPad Pro 11"   → 1668 × 1024
         iPad Pro 12.9" → 2048 × 1366
         iPad Air       → 1640 × 1024
    4. Come back and re-run this script  (or just npm start)

"@

  if (Confirm-Step "Open the releases page in your browser now?") {
    Start-Process "https://github.com/MolotovCherry/virtual-display-rs/releases"
  }

  Write-Warn "Continuing without virtual display — you can re-run this script after installing."
}

# ── 5. Detect monitors ────────────────────────────────────────────────────────

Write-Step "Detecting monitors..."

Add-Type -Assembly System.Windows.Forms
$screens = [System.Windows.Forms.Screen]::AllScreens

Write-Host ""
for ($i = 0; $i -lt $screens.Count; $i++) {
  $s = $screens[$i]
  $label = if ($s.Primary) { " ← PRIMARY (your main screen)" } else { "" }
  Write-Host "    [$i]  $($s.Bounds.Width) × $($s.Bounds.Height)  at ($($s.Bounds.X), $($s.Bounds.Y))$label"
}

$defaultMonitor = if ($screens.Count -gt 1) { 1 } else { 0 }

Write-Host ""
$monInput = Read-Host "  Which monitor should stream to the iPad? [default: $defaultMonitor]"
$monitorIndex = if ($monInput -match '^\d+$') { [int]$monInput } else { $defaultMonitor }

if ($monitorIndex -ge $screens.Count) {
  Write-Warn "Monitor $monitorIndex not found — defaulting to 0"
  $monitorIndex = 0
}

$chosen = $screens[$monitorIndex]
Write-Ok "Will stream monitor $monitorIndex ($($chosen.Bounds.Width)×$($chosen.Bounds.Height))"

# ── 6. FPS / quality ──────────────────────────────────────────────────────────

Write-Host ""
Write-Host "  Performance settings (press Enter to accept defaults):" -ForegroundColor Cyan

$fpsInput = Read-Host "  FPS [30] (higher = smoother, needs faster WiFi)"
$fps = if ($fpsInput -match '^\d+$') { [int]$fpsInput } else { 30 }

$qualInput = Read-Host "  Quality 2-31 [5] (lower number = better quality, more bandwidth)"
$quality = if ($qualInput -match '^\d+$') { [int]$qualInput } else { 5 }

Write-Ok "FPS: $fps   Quality: $quality"

# ── 7. Write config ───────────────────────────────────────────────────────────

Write-Step "Saving configuration..."

$config = [PSCustomObject]@{
  monitor = $monitorIndex
  fps     = $fps
  quality = $quality
  port    = 9001
} | ConvertTo-Json

[System.IO.File]::WriteAllText((Join-Path $ProjectDir 'screencast.config.json'), $config, (New-Object System.Text.UTF8Encoding $false))
Write-Ok "Config saved to screencast.config.json"

# ── 8. Launcher ───────────────────────────────────────────────────────────────
# launcher.bat ships with the repo (it reloads PATH and checks for ffmpeg) and reads its
# settings from screencast.config.json, so it must not be regenerated here.

Write-Step "Checking launcher..."

$batPath = Join-Path $ProjectDir 'launcher.bat'
if (-not (Test-Path $batPath)) { Write-Fail "launcher.bat is missing from $ProjectDir"; exit 1 }
Write-Ok "launcher.bat found"

# ── 9. Desktop shortcut ───────────────────────────────────────────────────────

Write-Step "Creating desktop shortcut..."

$desktopPath = [System.Environment]::GetFolderPath('Desktop')
$lnkPath     = Join-Path $desktopPath 'ScreenCast.lnk'

$shell    = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($lnkPath)
$shortcut.TargetPath       = $batPath
$shortcut.WorkingDirectory = $ProjectDir
$shortcut.WindowStyle      = 1   # Normal window
$shortcut.Description      = "Stream Windows second screen to iPad"
# Use the built-in monitor icon from Windows
$shortcut.IconLocation     = "$env:SystemRoot\System32\imageres.dll,109"
$shortcut.Save()

Write-Ok "Desktop shortcut created: ScreenCast.lnk"

# ── Done ──────────────────────────────────────────────────────────────────────

Write-Host @"

  ╔══════════════════════════════════════════╗
  ║           Setup complete!                ║
  ╚══════════════════════════════════════════╝

  → Double-click  ScreenCast  on your desktop to start.
  → Open the printed URL in iPad Safari (same WiFi network).
  → Touch the screen to control your PC.

  To change settings, re-run this script or edit:
    $ProjectDir\screencast.config.json

"@ -ForegroundColor Green

Read-Host "  Press Enter to exit"
