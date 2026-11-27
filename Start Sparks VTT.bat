@echo off
cd /d "%~dp0"
if exist "target\debug\sparks-vtt.exe" (
  start "" "http://127.0.0.1:4173/"
  "target\debug\sparks-vtt.exe"
) else (
  cargo run
)
