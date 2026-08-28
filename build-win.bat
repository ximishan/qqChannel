@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

title QQ Channel - One Click Build

echo ========================================
echo 腾讯频道批量发布工具 - 一键打包
echo ========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js。
  echo 请先安装 Node.js LTS，然后重新运行本脚本。
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 npm。
  echo 请重新安装 Node.js LTS。
  pause
  exit /b 1
)

echo [1/4] Node.js 版本：
node -v
if errorlevel 1 goto :failed

echo.
echo [2/4] 安装/校准项目依赖...
call npm install
if errorlevel 1 (
  echo.
  echo [提示] 第一次安装依赖失败，正在清理 npm 缓存后重试...
  call npm cache verify
  call npm install
  if errorlevel 1 goto :failed
)

echo.
echo [3/4] 清理旧打包目录...
if exist "dist" (
  rmdir /s /q "dist"
  if exist "dist" (
    echo [错误] dist 目录无法删除，可能有旧版 EXE 正在运行。
    echo 请关闭正在运行的程序后重试。
    goto :failed
  )
)

echo.
echo [4/4] 开始生成 Windows 便携版 EXE...
call npm run build:win
if errorlevel 1 goto :failed

echo.
echo ========================================
echo 打包成功！
echo ========================================
echo 输出目录：%CD%\dist

echo.
if exist "dist" (
  dir /b "dist\*.exe" 2>nul
)

echo.
echo 按任意键打开 dist 文件夹...
pause >nul
start "" "%CD%\dist"
exit /b 0

:failed
echo.
echo ========================================
echo 打包失败

echo 请把本窗口最后的报错内容发给开发者。
echo ========================================
pause
exit /b 1
