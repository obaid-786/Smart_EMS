@echo off
title Smart EMS and MIS - Bridge
cd /d "%~dp0"

echo =====================================================
echo   Smart EMS and MIS
echo   Starting bridge... do not close this window
echo =====================================================
echo.
echo   Classic HMI : http://localhost:5000/
echo   Pro UI      : http://localhost:5000/pro/
echo.
echo   Keep this window OPEN while you use the plant screens.
echo   Close this window to stop the server.
echo =====================================================
echo.

where python >nul 2>&1
if errorlevel 1 (
  echo ERROR: Python not found.
  echo Install Python 3.10+ and tick "Add Python to PATH".
  pause
  exit /b 1
)

REM Open Pro UI after a short delay (new window)
start "" cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:5000/pro/"

python bridge_server.py
echo.
echo Bridge stopped.
pause
