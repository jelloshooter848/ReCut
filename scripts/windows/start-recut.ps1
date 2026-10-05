<#
  ReCut launcher for a cloned repository on Windows.
  Double-click "Start ReCut.cmd" in the repo root (it runs this script). On first run it:
    1. checks for Node.js 20+ (offers to install Node.js LTS with winget if missing),
    2. installs npm dependencies,
    3. builds the app,
    4. downloads FFmpeg into resources\ffmpeg if FFmpeg is not already installed,
  then launches ReCut. Later runs skip the steps that are already done and just launch.

  Options:
    -Rebuild   force a fresh dependency install and build
    -Smoke     CI self-test: launch with RECUT_SMOKE=1, wait for exit, print the smoke report
#>
param([switch]$Rebuild, [switch]$Smoke)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # makes Invoke-WebRequest much faster on Windows PowerShell 5.1
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $Root

function Say([string]$msg) { Write-Host "[ReCut] $msg" }
function Fail([string]$msg) {
  Write-Host ""
  Write-Host "[ReCut] $msg" -ForegroundColor Red
  if (-not $Smoke) { Read-Host "Press Enter to close" | Out-Null }
  exit 1
}

# --- 1. Node.js ------------------------------------------------------------
function Get-NodeMajor {
  try { $v = (& node --version) 2>$null } catch { return 0 }
  if ($v -match '^v(\d+)\.') { return [int]$Matches[1] } else { return 0 }
}
$nodeMajor = Get-NodeMajor
if ($nodeMajor -lt 20) {
  if ($nodeMajor -gt 0) { Say "Node.js $nodeMajor found, but ReCut needs Node.js 20 or newer." } else { Say "Node.js was not found." }
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    $answer = if ($Smoke) { 'n' } else { Read-Host "Install Node.js LTS now with winget? [Y/n]" }
    if ($answer -eq '' -or $answer -match '^[Yy]') {
      winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
      Fail "Node.js was installed. Close this window and double-click 'Start ReCut.cmd' again so Windows picks up the new PATH."
    }
  }
  Fail "Install Node.js 20 or newer from https://nodejs.org (LTS), then run 'Start ReCut.cmd' again."
}

# --- 2. Dependencies ---------------------------------------------------------
$stamp = Join-Path $Root 'node_modules\.recut-installed'
$lock = Join-Path $Root 'package-lock.json'
$needInstall = $Rebuild -or -not (Test-Path $stamp) -or ((Get-Item $lock).LastWriteTimeUtc -gt (Get-Item $stamp -ErrorAction SilentlyContinue).LastWriteTimeUtc)
if ($needInstall) {
  Say "Installing dependencies (first run takes a few minutes)..."
  & npm ci --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { Fail "npm ci failed (exit $LASTEXITCODE). Check your internet connection and try again." }
  New-Item -ItemType File -Force -Path $stamp | Out-Null
}

# --- 3. Build ----------------------------------------------------------------
$builtMarker = Join-Path $Root 'dist\.recut-built'
$rev = ''
if (Get-Command git -ErrorAction SilentlyContinue) {
  try { $rev = (& git -C $Root rev-parse HEAD 2>$null) } catch { $rev = '' }
}
$builtRev = if (Test-Path $builtMarker) { (Get-Content $builtMarker -Raw).Trim() } else { $null }
$needBuild = $Rebuild -or -not (Test-Path (Join-Path $Root 'dist\electron\main.js')) -or -not (Test-Path (Join-Path $Root 'dist\renderer\index.html')) -or ($rev -and $rev -ne $builtRev)
if ($needBuild) {
  Say "Building ReCut..."
  & npm run build
  if ($LASTEXITCODE -ne 0) { Fail "Build failed (exit $LASTEXITCODE)." }
  Set-Content -Path $builtMarker -Value $rev
}

# --- 4. FFmpeg ---------------------------------------------------------------
$ffDir = Join-Path $Root 'resources\ffmpeg'
$haveBundled = (Test-Path (Join-Path $ffDir 'ffmpeg.exe')) -and (Test-Path (Join-Path $ffDir 'ffprobe.exe'))
$haveSystem = (Get-Command ffmpeg -ErrorAction SilentlyContinue) -and (Get-Command ffprobe -ErrorAction SilentlyContinue)
if (-not $haveBundled -and -not $haveSystem) {
  Say "Downloading FFmpeg (one time only)..."
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'get-ffmpeg.ps1') -Dest $ffDir
  if ($LASTEXITCODE -ne 0) {
    Fail "Could not download FFmpeg. Install it yourself (winget install Gyan.FFmpeg) or put ffmpeg.exe and ffprobe.exe in $ffDir."
  }
}

# --- 5. Launch ---------------------------------------------------------------
$electron = Join-Path $Root 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electron)) { Fail "Electron is missing. Run 'Start ReCut.cmd -Rebuild'." }
if ($Smoke) {
  $out = Join-Path $env:TEMP 'recut-smoke.txt'
  Remove-Item -Force $out -ErrorAction SilentlyContinue
  $env:RECUT_SMOKE = '1'; $env:RECUT_SMOKE_OUT = $out
  $env:RECUT_USER_DATA = Join-Path $env:TEMP 'recut-smoke-userdata'
  $p = Start-Process -FilePath $electron -ArgumentList '.' -WorkingDirectory $Root -PassThru
  if (-not $p.WaitForExit(120000)) { $p.Kill(); Fail "Smoke test timed out." }
  if (-not (Test-Path $out)) { Fail "Smoke test produced no report." }
  Get-Content $out
  $report = Get-Content $out -Raw
  if ($report -cmatch 'FAILED|layout=MISSING' -or $report -notmatch 'encode\+probe ok' -or $report -notmatch 'status=206') { Fail "Smoke test failed." }
  Say "Smoke test passed."
  exit 0
}
Say "Starting ReCut..."
Start-Process -FilePath $electron -ArgumentList '.' -WorkingDirectory $Root | Out-Null
