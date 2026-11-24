@echo off
setlocal
chcp 65001 >nul

set "AGY_EXE="
if defined ANTIGRAVITY_INSTALL_DIR if exist "%ANTIGRAVITY_INSTALL_DIR%\Antigravity.exe" set "AGY_EXE=%ANTIGRAVITY_INSTALL_DIR%\Antigravity.exe"
if not defined AGY_EXE if exist "%LOCALAPPDATA%\Programs\antigravity\Antigravity.exe" set "AGY_EXE=%LOCALAPPDATA%\Programs\antigravity\Antigravity.exe"
if not defined AGY_EXE goto :missing_exe

where node >nul 2>nul
if errorlevel 1 goto :use_electron
node -e "process.exit(parseInt(process.versions.node,10)>=18?0:1)" >nul 2>nul
if errorlevel 1 goto :use_electron

:use_node
node "%~dp0cli.mjs" check-update --or-unpatched >nul 2>nul
if errorlevel 3 goto :launch_gui
if errorlevel 2 node "%~dp0cli.mjs" patch >nul 2>nul
goto :launch_gui

:use_electron
set "ELECTRON_RUN_AS_NODE=1"
"%AGY_EXE%" "%~dp0cli.mjs" check-update --or-unpatched >nul 2>nul
if errorlevel 3 goto :launch_gui
if errorlevel 2 "%AGY_EXE%" "%~dp0cli.mjs" patch >nul 2>nul

:launch_gui
set "ELECTRON_RUN_AS_NODE="
start "" "%AGY_EXE%" %*
endlocal
exit /b 0

:missing_exe
echo [错误] 未在默认路径找到 Antigravity.exe，请先安装 Antigravity 2.0 或设置 ANTIGRAVITY_INSTALL_DIR。
pause
endlocal
exit /b 1
