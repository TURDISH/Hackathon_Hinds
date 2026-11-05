@echo off
setlocal
cd /d "%~dp0"

where nvm >nul 2>&1
if %ERRORLEVEL%==0 (
  call nvm use 22.14.0 >nul 2>&1
)

if not exist "node_modules\" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 exit /b 1
)

echo Starting Fleet SOP Digitizer at http://localhost:3847
call npm start
