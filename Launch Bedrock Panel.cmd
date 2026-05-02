@echo off
setlocal

set "ROOT_DIR=%~dp0"
if "%ROOT_DIR:~-1%"=="\" set "ROOT_DIR=%ROOT_DIR:~0,-1%"

cd /d "%ROOT_DIR%"

if not exist "node_modules" (
  call npm install
  if errorlevel 1 exit /b 1
)

if not exist "apps\api\public\index.html" (
  call npm run build:production
  if errorlevel 1 exit /b 1
)

start "Bedrock Panel" /min cmd /c "cd /d ""%ROOT_DIR%"" && npm run start -w @bedrock-panel/desktop"

exit /b 0
