@echo off
setlocal
cd /d "%~dp0"

rem PowerShell handles first-run setup, updates, and startup.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-web.ps1"
set "LAZY_EXIT=%ERRORLEVEL%"

if not "%LAZY_EXIT%"=="0" (
    echo.
    echo Lazy failed to start. See the message and log above.
    pause
)

exit /b %LAZY_EXIT%
