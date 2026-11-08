@echo off
setlocal enabledelayedexpansion
rem Usage: stop.bat [port]  (port defaults to env PORT, else 3050)
if not "%~1"=="" (set "PORT=%~1") else if not defined PORT set "PORT=3050"
set "FOUND=0"
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /c:":%PORT% " ^| findstr /c:"LISTENING"') do (
  echo Terminating PID: %%a ...
  taskkill /F /PID %%a /T >nul 2>nul
  set "FOUND=1"
)
if "!FOUND!"=="0" (echo Not running on port %PORT%.) else (echo Stopped.)
pause
