@echo off
rem sidecar 启动脚本 — 契约见 docs/sidecar-api.md
rem 依赖:先跑一次 setup.bat(建 venv + 下载模型)。
rem 默认 CPU(避免与 Index-Translate LLM 抢显存);需 GPU 时设 SIDECAR_DEVICE=cuda
setlocal
cd /d "%~dp0"
if "%SIDECAR_PORT%"=="" set SIDECAR_PORT=8500
if "%SIDECAR_DEVICE%"=="" set SIDECAR_DEVICE=cpu

if not exist ".venv\Scripts\python.exe" (
    echo [FAIL] 尚未安装:请先运行 setup.bat
    pause
    exit /b 1
)
".venv\Scripts\python.exe" server.py
pause
