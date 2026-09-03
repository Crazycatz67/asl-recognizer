@echo off
rem Double-click to serve the app over HTTPS on your local network so a phone
rem (same Wi-Fi) can open it with a working camera. Close this window to stop.
title ASL Recognizer - phone server (HTTPS)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve-https.ps1"
echo.
echo Server stopped.
pause
