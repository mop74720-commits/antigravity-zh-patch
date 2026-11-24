@echo off
setlocal
chcp 65001 >nul

set "RUN_RC=0"
if /i "%AGY_ZH_FORCE_ELECTRON%"=="1" goto :find_electron

where node >nul 2>nul
if errorlevel 1 goto :find_electron
node -e "process.exit(parseInt(process.versions.node,10)>=18?0:1)" >nul 2>nul
if errorlevel 1 goto :find_electron

node "%~dp0cli.mjs" %*
set "RUN_RC=%errorlevel%"
goto :done

:find_electron
set "AGY_EXE="
if defined ANTIGRAVITY_INSTALL_DIR if exist "%ANTIGRAVITY_INSTALL_DIR%\Antigravity.exe" set "AGY_EXE=%ANTIGRAVITY_INSTALL_DIR%\Antigravity.exe"
if not defined AGY_EXE if exist "%LOCALAPPDATA%\Programs\antigravity\Antigravity.exe" set "AGY_EXE=%LOCALAPPDATA%\Programs\antigravity\Antigravity.exe"
if not defined AGY_EXE goto :missing_runtime

set "AGY_LOG_DIR=%TEMP%"
if not defined AGY_LOG_DIR set "AGY_LOG_DIR=%TMP%"
set "AGY_TMP_LOG=%AGY_LOG_DIR%\agy-zh-%RANDOM%-%RANDOM%.log"
set "ELECTRON_RUN_AS_NODE=1"
"%AGY_EXE%" "%~dp0cli.mjs" %* >"%AGY_TMP_LOG%" 2>&1
set "RUN_RC=%errorlevel%"
set "ELECTRON_RUN_AS_NODE="
if exist "%AGY_TMP_LOG%" type "%AGY_TMP_LOG%"
if exist "%AGY_TMP_LOG%" del /f /q "%AGY_TMP_LOG%" >nul 2>nul
goto :done

:missing_runtime
set "RUN_RC=1"
echo [错误] 未检测到 Node.js 18+，且未在默认路径找到 Antigravity.exe。
echo 请安装 Node.js 18+，或设置 ANTIGRAVITY_INSTALL_DIR 指向 Antigravity 安装目录后重试。

:done
if "%AGY_ZH_NO_PAUSE%"=="1" goto :finish
echo.
pause

:finish
endlocal & exit /b %RUN_RC%
