@echo off
rem sidecar 一键安装:建独立 venv + 装 Python 依赖 + 按需下载模型(约 700MB,一次性)。
rem 已装过再跑会跳过已有部分。模型/依赖均不入安装包。
setlocal
cd /d "%~dp0"

where python >nul 2>nul
if %errorlevel%==0 (
    set PY=python
) else (
    where py >nul 2>nul
    if %errorlevel%==0 (
        set PY=py -3
    ) else (
        echo [FAIL] 未找到 Python 3,请先安装 Python 3.10+ 并加入 PATH
        pause
        exit /b 1
    )
)

if not exist ".venv\Scripts\python.exe" (
    echo [1/3] 创建虚拟环境 .venv ...
    %PY% -m venv .venv || (echo [FAIL] venv 创建失败 & pause & exit /b 1)
) else (
    echo [1/3] .venv 已存在,跳过
)

echo [2/3] 安装 Python 依赖(torch CPU 等,首次约 300MB)...
".venv\Scripts\python.exe" -m pip install -r requirements.txt || (echo [FAIL] 依赖安装失败 & pause & exit /b 1)

echo [3/3] 下载模型(约 700MB)...
".venv\Scripts\python.exe" download_models.py || (echo [FAIL] 模型下载失败 & pause & exit /b 1)

echo.
echo [OK] sidecar 就绪。运行 launch.bat 启动服务。
pause
