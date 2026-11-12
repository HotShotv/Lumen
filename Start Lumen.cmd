@echo off
rem Starts Lumen. Run setup.ps1 once first.
set "ELECTRON=%LOCALAPPDATA%\Lumen\runtime\node_modules\electron\dist\electron.exe"
if not exist "%ELECTRON%" (
  echo Lumen's runtime is not installed yet. Run setup.ps1 first.
  pause
  exit /b 1
)
start "" "%ELECTRON%" "%~dp0."
