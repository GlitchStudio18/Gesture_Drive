@echo off
cd /d "%~dp0"
echo Open Road is starting on http://localhost:8000
echo Close this window (or press Ctrl+C) to stop the server.
start "" /min cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:8000"
python server.py 8000
if errorlevel 1 py server.py 8000
pause
