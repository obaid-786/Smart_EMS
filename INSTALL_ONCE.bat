@echo off
title Smart EMS and MIS - Install packages (once)
cd /d "%~dp0"
echo Installing Python packages from requirements.txt ...
where python >nul 2>&1
if errorlevel 1 (
  echo ERROR: Python not found. Install Python 3.10+ and Add to PATH.
  pause
  exit /b 1
)
python -m pip install -r requirements.txt
echo.
echo Done. Now double-click START_Smart_EMS.bat
pause
