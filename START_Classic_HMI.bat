@echo off
title Smart EMS and MIS - Classic HMI
cd /d "%~dp0"

where python >nul 2>&1
if errorlevel 1 (
  echo ERROR: Python not found. Install Python and Add to PATH.
  pause
  exit /b 1
)

start "" cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:5000/"
python bridge_server.py
pause
