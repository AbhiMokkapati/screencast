# Run once in PowerShell (as Administrator) to set up dependencies.
# Right-click PowerShell → "Run as Administrator", then: .\setup.ps1

Set-StrictMode -Off
$ErrorActionPreference = 'Stop'

Write-Host "`n=== ScreenCast Windows Setup ===" -ForegroundColor Cyan

# 1. Check Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "`n[ERROR] Node.js not found. Install from https://nodejs.org (LTS)" -ForegroundColor Red
    exit 1
}
Write-Host "[OK] Node.js $(node --version)"

# 2. Check FFmpeg
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Write-Host "`nInstalling FFmpeg via winget..."
    winget install --id Gyan.FFmpeg --silent --accept-source-agreements --accept-package-agreements
    # Reload PATH
    $env:PATH = [System.Environment]::GetEnvironmentVariable('PATH', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('PATH', 'User')
} else {
    Write-Host "[OK] FFmpeg $(ffmpeg -version 2>&1 | Select-String 'ffmpeg version' | ForEach-Object { $_.Line.Split(' ')[2] })"
}

# 3. npm install
Write-Host "`nInstalling npm packages..."
npm install
Write-Host "[OK] npm packages installed"

# 4. Show connected monitors
Write-Host "`n=== Your monitors ===" -ForegroundColor Cyan
Add-Type -Assembly System.Windows.Forms
$i = 0
[System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
    $primary = if ($_.Primary) { " (PRIMARY)" } else { "" }
    Write-Host "  Monitor $i : $($_.Bounds.Width)x$($_.Bounds.Height) at ($($_.Bounds.X),$($_.Bounds.Y))$primary"
    $i++
}

Write-Host "`n=== Virtual Display (for true second screen) ===" -ForegroundColor Cyan
Write-Host "  If you don't have a physical second monitor, install a virtual display driver:"
Write-Host "  Option A (recommended): https://github.com/nefarius/ViGEm/... "
Write-Host "    -> Actually use: https://github.com/MolotovCherry/virtual-display-rs/releases"
Write-Host "    -> Download & run the installer, then a new monitor appears in Display Settings"
Write-Host "  Option B: Use 'Parsec Virtual Display' from parsec.app (also free)"
Write-Host ""
Write-Host "  After installing, run this script again to see the new monitor listed above."

Write-Host "`n=== Ready to run ===" -ForegroundColor Green
Write-Host "  npm start                     # stream monitor 1 (default)"
Write-Host "  `$env:MONITOR=0; npm start    # stream primary monitor instead"
Write-Host "  `$env:FPS=60; npm start       # higher framerate (needs good WiFi)"
Write-Host ""
Write-Host "  Open on iPad: the server prints the URL when it starts."
