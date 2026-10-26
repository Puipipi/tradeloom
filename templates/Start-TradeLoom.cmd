@echo off
setlocal
chcp 65001 >nul
set "ROOT=%~dp0"
set "NODE_OPTIONS="
set "NODE_PATH="
set "ELECTRON_RUN_AS_NODE="
if not exist "%ROOT%runtime\primary-runtime\dependencies\node\bin\node.exe" (
  echo TradeLoom runtime is incomplete. Extract the entire ZIP before starting.
  pause
  exit /b 2
)
"%ROOT%runtime\primary-runtime\dependencies\node\bin\node.exe" "%ROOT%launcher\bootstrap.mjs" %*
set "RESULT=%ERRORLEVEL%"
if not "%RESULT%"=="0" pause
exit /b %RESULT%
