@echo off
setlocal
rem Usage: status.bat [port]  (port defaults to env PORT, else 3050)
if not "%~1"=="" (set "PORT=%~1") else if not defined PORT set "PORT=3050"
echo Checking CommandCodeGo Manager status on port %PORT% ...
netstat -ano | findstr /c:":%PORT% " | findstr /c:"LISTENING"
if errorlevel 1 echo Not running on port %PORT%.
pause
