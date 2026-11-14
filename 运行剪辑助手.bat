@echo off
setlocal
chcp 65001 >nul
set "APP_ROOT=%~dp0"
if exist "%APP_ROOT%.venv\Scripts\pythonw.exe" (
    start "" "%APP_ROOT%.venv\Scripts\pythonw.exe" "%APP_ROOT%剪辑助手.pyw"
    exit /b 0
)
echo 请先运行 安装依赖.bat
pause
endlocal
