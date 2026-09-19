@echo off
rem ============================================================
rem  Navi local preview launcher
rem  Double-click this file to start the navi server locally,
rem  then open http://localhost:8899 in your browser.
rem  Close this window (or press Ctrl+C) to stop the server.
rem ============================================================
setlocal
cd /d "%~dp0"

set "PORT=8899"
set "HOST=::"

echo.
echo   Navi local preview
echo   ------------------
echo   URL : http://localhost:8899
echo   Stop: press Ctrl+C or close this window
echo.

where node >nul 2>nul
if %errorlevel%==0 (
  node server.js
) else (
  set "BUNDLED_NODE=C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"
  if exist "%BUNDLED_NODE%" (
    "%BUNDLED_NODE%" server.js
  ) else (
    echo [ERROR] Node.js not found. Please install Node.js 18+ first.
  )
)

echo.
echo Server stopped.
pause
