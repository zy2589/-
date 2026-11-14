@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" py -3 -m venv .venv
if errorlevel 1 goto :failed
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 goto :failed
echo 依赖已就绪。双击“运行剪辑助手.bat”打开小样。
pause
exit /b 0
:failed
echo 安装失败，请确认本机已安装 Python 3 并能访问 Python 包源。
pause
exit /b 1
endlocal
