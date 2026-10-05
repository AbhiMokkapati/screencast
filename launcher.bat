@echo off
title ScreenCast — Second Screen
color 0B
cd /d "%~dp0"

:: Reload system + user PATH from registry so winget-installed tools (ffmpeg) are found
for /f "tokens=2*" %%A in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul') do set "SYS_PATH=%%B"
for /f "tokens=2*" %%A in ('reg query "HKCU\Environment" /v Path 2^>nul') do set "USER_PATH=%%B"
if defined USER_PATH (set "PATH=%SYS_PATH%;%USER_PATH%") else (set "PATH=%SYS_PATH%")

:: Verify ffmpeg is reachable before starting
where ffmpeg >nul 2>&1
if errorlevel 1 (
    echo.
    echo  [ERROR] ffmpeg not found on PATH.
    echo  Run setup.ps1 as Administrator to reinstall it.
    echo.
    pause
    exit /b 1
)

echo.
echo  =============================================
echo   ScreenCast  ^|  Starting...
echo  =============================================
echo.
echo  Open the URL below on your iPad Safari  (WiFi only).
echo  For USB connection: run usb-forward.bat instead.
echo  Press Ctrl+C to stop.
echo.
node server.js
echo.
echo  Server stopped. Press any key to close.
pause > nul
