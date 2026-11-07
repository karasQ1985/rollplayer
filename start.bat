@echo off
setlocal
title Rollplayer 服务管理
cd /d "%~dp0"

set "PS1=%~dp0tools\service-ctl.ps1"
set "NODE_CMD=node"
if exist "%~dp0node\node.exe" set "NODE_CMD=%~dp0node\node.exe"

:menu
chcp 936 >nul
cls
echo ==========================================================
echo    Rollplayer 播放器  ·  服务管理
echo ==========================================================
echo     1   启动（本机）      只有这台电脑能访问
echo     2   启动（局域网）    iPad / 手机 同网可用
echo     3   停止服务
echo     4   查看运行状态
echo     0   退出
echo ==========================================================
set "CHOICE="
set /p "CHOICE=请输入编号后回车（直接回车 = 1）: "
set "CHOICE=%CHOICE: =%"
if "%CHOICE%"=="" set "CHOICE=1"
if "%CHOICE%"=="0" goto done
if "%CHOICE%"=="1" goto mode_local
if "%CHOICE%"=="2" goto mode_lan
if "%CHOICE%"=="3" goto act_stop
if "%CHOICE%"=="4" goto act_status
echo.
echo   [错误] 没有 "%CHOICE%" 这个编号，请输入 0 到 4。
pause
goto menu

:mode_local
set "MP_HOST="
set "MODEARG=local"
set "MODEDESC=本机（127.0.0.1）"
goto launch

:mode_lan
set "MP_HOST=0.0.0.0"
set "MODEARG=lan"
set "MODEDESC=局域网（同网设备可访问）"
goto launch

:launch
echo.
echo [1/3] 检查是否已有实例在运行 ...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -Action precheck -Mode %MODEARG%
if errorlevel 1 goto launch_abort

echo.
echo [2/3] 检查 Node.js 环境 ...
"%NODE_CMD%" -v >nul 2>nul
if errorlevel 1 (
  echo   [错误] 未检测到 Node.js。
  echo   请任选其一：
  echo     1. 到 https://nodejs.org/ 安装 Node.js（推荐，一次即可）
  echo     2. 下载 node.exe 放到本项目的 "node\" 文件夹内（绿色免安装）
  echo.
  pause
  goto menu
)
echo   Node.js 已就绪。

echo.
echo [3/3] 启动服务，模式：%MODEDESC%
echo   ------------------------------------------------------
echo   本窗口就是服务本体，请保持它运行。
echo   要停止：本窗口按 Ctrl+C，或再次双击本文件选 3。
echo   关闭本窗口 = 停止服务。
echo   ------------------------------------------------------
echo.
chcp 65001 >nul
"%NODE_CMD%" server.mjs
chcp 936 >nul
echo.
echo 服务已退出。
pause
goto menu

:act_stop
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -Action stop
echo.
pause
goto menu

:act_status
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -Action status
echo.
pause
goto menu

:launch_abort
echo.
pause
goto menu

:done
echo.
echo 退出前自检：清理本工具自己的运行记录（不会动其他程序）...
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -Action cleanup
timeout /t 2 >nul 2>&1
endlocal
exit /b 0