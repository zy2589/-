@echo off
setlocal
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0安装剪辑助手.ps1"
if errorlevel 1 pause
endlocal
