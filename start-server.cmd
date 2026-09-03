@echo off
rem Double-click to serve the app locally and open it in your browser.
rem localhost is a secure context, so the camera works. Close this window to stop.
title ASL Recognizer - local server
echo Starting local server on http://localhost:8000 ...
echo.
timeout /t 1 /nobreak >nul
start "" http://localhost:8000/index.html
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1"
echo.
echo Server stopped.
pause
