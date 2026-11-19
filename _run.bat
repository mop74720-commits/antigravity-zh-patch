@echo off
setlocal
chcp 65001 >nul

where node >nul 2>nul
if %errorlevel%==0 (
  node -e "process.exit(parseInt(process.versions.node,10)>=18?0:1)" >nul 2>nul
  if %errorlevel%==0 (
    node "%~dp0cli.mjs" %*
    goto :done
  )
)

set "AGY_EXE="
if defined ANTIGRAVITY_INSTALL_DIR (
  if exist "%ANTIGRAVITY_INSTALL_DIR%\Antigravity.exe" set "AGY_EXE=%ANTIGRAVITY_INSTALL_DIR%\Antigravity.exe"
)
if not defined AGY_EXE (
  if exist "%LOCALAPPDATA%\Programs\antigravity\Antigravity.exe" set "AGY_EXE=%LOCALAPPDATA%\Programs\antigravity\Antigravity.exe"
)

if defined AGY_EXE (
  set "ELECTRON_RUN_AS_NODE=1"
  "%AGY_EXE%" "%~dp0cli.mjs" %*
  goto :done
)

echo [错误] 未检测到 Node.js 18+，且未在默认路径找到 Antigravity.exe。
echo 请安装 Node.js 18+，或设置 ANTIGRAVITY_INSTALL_DIR 指向 Antigravity 安装目录后重试。

:done
echo.
pause
endlocal
