# Installs the Electron runtime Lumen runs on. Run once:
#   powershell -ExecutionPolicy Bypass -File setup.ps1
#
# The runtime goes to %LOCALAPPDATA%\Lumen\runtime, not next to the source, so a
# few hundred MB of runtime files are not synced by OneDrive.

$ErrorActionPreference = "Stop"
$runtime = Join-Path $env:LOCALAPPDATA "Lumen\runtime"
New-Item -ItemType Directory -Force $runtime | Out-Null

if (-not (Test-Path (Join-Path $runtime "package.json"))) {
  Set-Content -Path (Join-Path $runtime "package.json") -Encoding utf8 -Value '{ "name": "lumen-runtime", "private": true }'
}

Push-Location $runtime
try {
  npm install electron@latest --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
  # recent Electron versions fetch the actual program in a separate step
  if (-not (Test-Path "node_modules\electron\dist\electron.exe")) {
    node node_modules\electron\install.js
    if ($LASTEXITCODE -ne 0) { throw "Electron download failed" }
  }
} finally {
  Pop-Location
}

$exe = Join-Path $runtime "node_modules\electron\dist\electron.exe"
if (-not (Test-Path $exe)) { throw "electron.exe was not installed at $exe" }
Write-Host "Runtime ready: $exe"
