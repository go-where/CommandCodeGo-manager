@echo off
setlocal
title CommandCodeGo Manager
cd /d "%~dp0"
if not defined PORT set "PORT=3050"
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found in PATH. Install Node.js 20+ first.
  pause
  exit /b 1
)
echo Starting CommandCodeGo Manager on http://127.0.0.1:%PORT% ...
node server.mjs
pause
