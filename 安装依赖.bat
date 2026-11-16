@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
set "TOOLCHAIN_PYTHON=%LOCALAPPDATA%\ClipAssistant\toolchains\python31410\python.exe"
set "PROJECT_VENV_PYTHON=%~dp0.venv\Scripts\python.exe"
if not exist "%PROJECT_VENV_PYTHON%" (
    if exist "%TOOLCHAIN_PYTHON%" (
        "%TOOLCHAIN_PYTHON%" -m venv .venv
    ) else (
        py -3.14 -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 14, 10) else 1)"
        if errorlevel 1 goto :missing_python
        py -3.14 -m venv .venv
    )
    if errorlevel 1 goto :failed
)
"%PROJECT_VENV_PYTHON%" -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 14, 10) else 1)"
if errorlevel 1 goto :wrong_python
"%PROJECT_VENV_PYTHON%" -m pip install -r requirements.txt
if errorlevel 1 goto :failed
echo 依赖已就绪。项目虚拟环境位于 .venv。双击“运行剪辑助手.bat”打开小样。
pause
exit /b 0
:missing_python
echo 需要 Python 3.14.10 或更新版本。安装此版本，或先运行一次已迁出的用户级工具链。
pause
exit /b 1
:wrong_python
echo .venv 使用的 Python 版本低于 3.14.10。请检查项目 .venv 和用户级工具链路径。
pause
exit /b 1
:failed
echo 依赖安装失败。请确认 Python 3.14.10 或更新版本可用，并能访问 Python 包源。
pause
exit /b 1
endlocal
