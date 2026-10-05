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

:: ── Step 2: Start iOS 17+ kernel tunnel ─────────────────────────────────────
echo  [2/4] Starting USB tunnel (admin mode)...
set "ENABLE_GO_IOS_AGENT=kernel"
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
    echo  [ERROR] Tunnel did not start in 30s.
    echo  Make sure iPad is unlocked, trusted, and try again.
    echo.
    taskkill /f /fi "WINDOWTITLE eq go-ios-tunnel" >nul 2>&1
    pause
    exit /b 1
)
for /f "tokens=*" %%I in ('powershell -NoProfile -ExecutionPolicy Bypass -File "%GET_IP_PS%" 2^>nul') do set TUNNEL_IP=%%I
if "%TUNNEL_IP%"=="" goto waitloop

echo  Tunnel ready.
echo.

:: ── Step 3: Start ScreenCast server ─────────────────────────────────────────
echo  [3/4] Verifying node and server...
where node >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] node not found. Run setup.ps1 as Administrator first.
    pause
    exit /b 1
)

echo  [4/4] Server starting...
echo.
echo  ============================================================
echo   iPad Safari URL:
echo.
echo      http://[%TUNNEL_IP%]:9001/?t=TOKEN   (TOKEN is printed by the server below)
echo.
echo   Tip: Tap the URL bar in Safari, paste the address above.
echo   (Include the square brackets around the IPv6 address.)
echo  ============================================================
echo.
echo  Press Ctrl+C to stop.
echo.

node server.js

:: ── Cleanup ──────────────────────────────────────────────────────────────────
echo.
echo  Stopping USB tunnel...
taskkill /f /fi "WINDOWTITLE eq go-ios-tunnel" >nul 2>&1
del "%GET_IP_PS%" >nul 2>&1
timeout /t 1 /nobreak >nul
echo  Done. Press any key to close.
pause >nul
