@echo off
title 媒体库轮播播放器
cd /d "%~dp0"

rem 优先使用项目自带的 node（绿色免安装版），否则用系统 PATH 中的 node
set "NODE_CMD=node"
if exist "%~dp0node\node.exe" set "NODE_CMD=%~dp0node\node.exe"

"%NODE_CMD%" -v >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js。
  echo 请任选其一：
  echo   1. 到 https://nodejs.org/ 安装 Node.js（推荐，一次即可）
  echo   2. 下载 node.exe 放到本项目的 "node\" 文件夹内（绿色免安装）
  echo.
  pause
  exit /b 1
)

echo 正在启动媒体库轮播播放器...
echo 启动后会自动打开浏览器（地址 http://127.0.0.1:9898）。
echo 本窗口即播放器服务，请保持其运行；关闭本窗口即停止。
echo.
chcp 65001 >nul
"%NODE_CMD%" server.mjs

pause