@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

REM 画布服务启动脚本（Windows）
REM 可选环境变量：CANVAS_PORT（默认 17800）、DSH_PYTHON、DREAMINA_BIN、DEEPSEEK_API_KEY

if "%CANVAS_PORT%"=="" set CANVAS_PORT=17800

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] 未找到 node，请先安装 Node.js 18+ 并加入 PATH
  pause
  exit /b 1
)

echo ============================================
echo  Web 画布启动中...
echo  地址: http://127.0.0.1:%CANVAS_PORT%/
echo  目录: %cd%
echo  关闭窗口即停止服务
echo ============================================
echo.

node _canvas\server.mjs
pause
