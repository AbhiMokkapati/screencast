@echo off
title ScreenCast — USB Tunnel
color 0B
cd /d "%~dp0"

:: ── Self-elevate to Admin (required for kernel TUN driver) ──────────────────
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo  Requesting admin privileges for USB tunnel driver...
    powershell -Command "Start-Process cmd -ArgumentList '/c cd /d \"%CD%\" && \"%~f0\"' -Verb RunAs"
    exit /b
)

:: ── Reload PATH from registry ────────────────────────────────────────────────
for /f "tokens=2*" %%A in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul') do set "SYS_PATH=%%B"
for /f "tokens=2*" %%A in ('reg query "HKCU\Environment" /v Path 2^>nul') do set "USER_PATH=%%B"
if defined USER_PATH (set "PATH=%SYS_PATH%;%USER_PATH%") else (set "PATH=%SYS_PATH%")

set IOS_EXE=%~dp0driver\go-ios\ios.exe
set GET_IP_PS=%TEMP%\screencast-get-tunip.ps1

echo.
echo  =============================================
echo   ScreenCast  ^|  USB Tunnel Setup
echo  =============================================
echo.

:: ── Step 1: Check iPad is connected ─────────────────────────────────────────
echo  [1/4] Checking for connected iPad...
"%IOS_EXE%" list 2>nul | findstr /i "\"deviceList\":\[\]" >nul
if not errorlevel 1 (
    echo.
    echo  No iPad detected. Please:
    echo    1. Connect your iPad with a Lightning or USB-C cable
    echo    2. Unlock your iPad and tap "Trust This Computer"
    echo    3. Run this script again
    echo.
    pause
    exit /b 1
)
echo  iPad detected.
echo.

where node >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] node not found. Run install.ps1 as Administrator first.
    pause
    exit /b 1
)

:: Keep the access token stable across restarts, so the iPad's open page keeps working.
:: (A token set in screencast.config.json or SCREENCAST_TOKEN is left alone.)
if not defined SCREENCAST_TOKEN (
    findstr /i "\"token\"" screencast.config.json >nul 2>&1
    if errorlevel 1 for /f %%T in ('powershell -NoProfile -Command "[guid]::NewGuid().ToString('N')"') do set "SCREENCAST_TOKEN=%%T"
)

:: ── Supervisor loop ──────────────────────────────────────────────────────────
:: The iPad locking or sleeping drops the tunnel. When that happens, restart go-ios, wait for
:: the tunnel interface, and restart the server too (its HTTPS certificate covers the tunnel IP
:: as of server start, and the IP can change).
:supervise
echo  [2/4] Starting USB tunnel (admin mode)...
set "ENABLE_GO_IOS_AGENT=kernel"
taskkill /f /fi "WINDOWTITLE eq go-ios-tunnel" >nul 2>&1
taskkill /f /fi "WINDOWTITLE eq screencast-server" >nul 2>&1
start "go-ios-tunnel" /min "%IOS_EXE%" tunnel start

:: Use a temp .ps1 to avoid inline quoting issues when polling tun0
echo (Get-NetIPAddress -InterfaceAlias tun0 -AddressFamily IPv6 -ErrorAction SilentlyContinue ^| Where-Object { $_.IPAddress -notlike 'fe80*' } ^| Select-Object -ExpandProperty IPAddress -First 1) > "%GET_IP_PS%"

echo  Waiting for tunnel interface (up to 30s)...
set TUNNEL_IP=
set /a WAIT_COUNT=0

:waitloop
timeout /t 2 /nobreak >nul
set /a WAIT_COUNT+=1
if %WAIT_COUNT% gtr 15 (
    echo.
    echo  Tunnel did not start in 30s. Is the iPad unlocked and trusted? Retrying...
    taskkill /f /fi "WINDOWTITLE eq go-ios-tunnel" >nul 2>&1
    timeout /t 3 /nobreak >nul
    goto supervise
)
for /f "tokens=*" %%I in ('powershell -NoProfile -ExecutionPolicy Bypass -File "%GET_IP_PS%" 2^>nul') do set TUNNEL_IP=%%I
if "%TUNNEL_IP%"=="" goto waitloop

echo  Tunnel ready.
echo.

echo  [3/4] Server starting...
start "screencast-server" cmd /c "node server.js"

echo.
echo  ============================================================
echo   iPad Safari URL:
echo.
echo      https://[%TUNNEL_IP%]:9001/?t=TOKEN   (TOKEN is printed in the server window)
echo      First time only: trust the PC at http://[%TUNNEL_IP%]:9002/ (see the server window).
echo.
echo   Tip: Tap the URL bar in Safari, paste the address above.
echo   (Include the square brackets around the IPv6 address.)
echo  ============================================================
echo.
echo  [4/4] Watching the tunnel. Close this window to stop everything.
echo.

:: ── Watchdog: every 5s, check go-ios, the tunnel interface and the server ─────
:watch
timeout /t 5 /nobreak >nul
tasklist /fi "WINDOWTITLE eq go-ios-tunnel" 2>nul | findstr /i "ios.exe" >nul
if errorlevel 1 (
    echo  [%TIME%] go-ios exited - restarting tunnel and server...
    goto supervise
)
set CUR_IP=
for /f "tokens=*" %%I in ('powershell -NoProfile -ExecutionPolicy Bypass -File "%GET_IP_PS%" 2^>nul') do set CUR_IP=%%I
if "%CUR_IP%"=="" (
    echo  [%TIME%] tunnel interface is gone - restarting tunnel and server...
    goto supervise
)
if not "%CUR_IP%"=="%TUNNEL_IP%" (
    echo  [%TIME%] tunnel address changed to %CUR_IP% - restarting server...
    goto supervise
)
tasklist /fi "WINDOWTITLE eq screencast-server" 2>nul | findstr /i "cmd.exe node.exe" >nul
if errorlevel 1 (
    echo  [%TIME%] server window closed - stopping.
    goto cleanup
)
goto watch

:cleanup
echo.
echo  Stopping USB tunnel...
taskkill /f /fi "WINDOWTITLE eq go-ios-tunnel" >nul 2>&1
taskkill /f /fi "WINDOWTITLE eq screencast-server" >nul 2>&1
del "%GET_IP_PS%" >nul 2>&1
timeout /t 1 /nobreak >nul
echo  Done. Press any key to close.
pause >nul
