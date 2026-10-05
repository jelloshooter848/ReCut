@echo off
rem Double-click to install (first run) and launch ReCut from this folder.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\start-recut.ps1" %*
