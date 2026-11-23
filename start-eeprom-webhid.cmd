@echo off
cd /d "%~dp0"
node webhid/serve.mjs
if errorlevel 1 pause
