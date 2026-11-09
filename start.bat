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
rem Upstream stream idle timeout in ms. 30000 default kills long reasoning; 180000 leaves headroom.
if not defined CC_STREAM_IDLE_MS set "CC_STREAM_IDLE_MS=180000"
echo Starting CommandCodeGo Manager on http://127.0.0.1:%PORT% ... (stream idle timeout %CC_STREAM_IDLE_MS%ms)
node server.mjs
pause
