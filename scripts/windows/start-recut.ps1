<#
  ReCut launcher for a cloned repository on Windows.
  Double-click "Start ReCut.cmd" in the repo root (it runs this script). On first run it:
    1. checks for Node.js 20+ (offers to install Node.js LTS with winget if missing),
    2. installs npm dependencies,
    3. builds the app,
    4. downloads FFmpeg into resources\ffmpeg if FFmpeg is not already installed,
    5. compiles the speech-to-text engine (whisper.cpp) into resources\whisper with scripts/setup-dev.mjs, the same
       step npm run dev and npm start run, when cmake and Visual Studio with the C++ workload are installed; without
       them it prints what to install (and the first time waits for Enter, so it can be read) and ReCut starts without
       speech-to-text,
  then launches ReCut. Later runs skip the steps that are already done and just launch.

  Options:
    -Rebuild   force a fresh dependency install and build
    -Smoke     CI self-test: launch with RECUT_SMOKE=1, wait for exit, print the smoke report and check it with
               scripts/check-smoke.mjs against scripts/smoke-requirements.json (mode "launcher", the list the
               installer's smoke test shares). It requires the speech-to-text engine in resources\whisper and OCR,
               so a run that skipped or failed the engine fails (the CI runner has cmake and Visual Studio C++).
  The launcher only waits for Enter when someone can press it: never with -Smoke, in CI (CI is set) or when the
  console input is redirected.
#>
param([switch]$Rebuild, [switch]$Smoke)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # makes Invoke-WebRequest much faster on Windows PowerShell 5.1
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $Root

# Whether a prompt (Read-Host) can be answered. Not with -Smoke, not in CI (GitHub Actions sets CI=true), and not when
# there is no console to type into (input redirected, non-interactive session): a prompt there would hang the run.
$Interactive = (-not $Smoke) -and (-not $env:CI) -and [Environment]::UserInteractive
try { if ([Console]::IsInputRedirected) { $Interactive = $false } } catch { }

function Say([string]$msg) { Write-Host "[ReCut] $msg" }
function Fail([string]$msg) {
  Write-Host ""
  Write-Host "[ReCut] $msg" -ForegroundColor Red
  if ($Interactive) { Read-Host "Press Enter to close" | Out-Null }
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
    $answer = if (-not $Interactive) { 'n' } else { Read-Host "Install Node.js LTS now with winget? [Y/n]" }
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

# --- 5. Speech-to-text engine -------------------------------------------------
# scripts/setup-dev.mjs skips the engine when it is already there or RECUT_WHISPER_CLI is set, checks for the build
# tools first and never fails the launch: a missing tool or a failed build prints what to do (#170).
$whisperCli = Join-Path $Root 'resources\whisper\whisper-cli.exe'
# -Smoke checks the engine this launcher sets up in resources\whisper, so an engine found elsewhere must not stand in.
if ($Smoke) { Remove-Item Env:RECUT_WHISPER_CLI -ErrorAction SilentlyContinue }
if (-not $env:RECUT_WHISPER_CLI -and -not (Test-Path $whisperCli)) {
  Say "Setting up speech-to-text (Whisper)..."
  $env:RECUT_SETUP_RETRY = "double-click 'Start ReCut.cmd' again"
  & node (Join-Path $Root 'scripts\setup-dev.mjs')
  Remove-Item Env:RECUT_SETUP_RETRY -ErrorAction SilentlyContinue
}
$haveWhisper = [bool]$env:RECUT_WHISPER_CLI -or (Test-Path $whisperCli)
if (-not $haveWhisper) {
  # Say exactly what is missing, and (once) wait for Enter: this window closes when ReCut opens, which would hide it.
  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
  $haveVs = (Test-Path $vswhere) -and [bool](& $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null)
  $haveCmake = [bool](Get-Command cmake -ErrorAction SilentlyContinue)
  Write-Host ""
  Write-Host "[ReCut] Speech-to-text (Whisper) is not set up, so ReCut will start without it." -ForegroundColor Yellow
  if ($haveVs -and $haveCmake) {
    Write-Host "[ReCut] cmake and Visual Studio C++ are installed, but building the engine failed: see the errors above."
  } else {
    Write-Host "[ReCut] The engine is compiled once on this PC. Install what is missing:"
    if (-not $haveCmake) { Write-Host "[ReCut]   - CMake: winget install Kitware.CMake  (or https://cmake.org/download)" }
    if (-not $haveVs) { Write-Host "[ReCut]   - Visual Studio 2022 or newer (the free Community edition) with the workload 'Desktop development with C++': https://visualstudio.microsoft.com/downloads" }
    Write-Host "[ReCut] Then double-click 'Start ReCut.cmd' again; it builds the engine (a few minutes, once)."
  }
  $notice = Join-Path $Root 'node_modules\.recut-whisper-notice'
  if ($Interactive -and -not (Test-Path $notice)) {
    Read-Host "Press Enter to start ReCut without speech-to-text" | Out-Null
    New-Item -ItemType File -Force -Path $notice | Out-Null
  }
}
# -Smoke runs only in CI, whose runner has cmake and Visual Studio C++: there the engine is required, as the installer
# bundles it, and a run that skipped or failed it fails here (#170). A double-click start goes on without it.
if ($Smoke -and -not (Test-Path $whisperCli)) {
  Fail "Smoke test failed: the speech-to-text engine (resources\whisper\whisper-cli.exe) was not set up; see the output above. -Smoke requires it."
}

# --- 6. Launch ---------------------------------------------------------------
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
  # The required lines are shared with the installer's smoke test (.github/workflows/windows.yml):
  # scripts/smoke-requirements.json, mode "launcher" (media protocol, FFmpeg, OCR, the speech-to-text engine, the window).
  & node (Join-Path $Root 'scripts\check-smoke.mjs') --mode launcher $out
  if ($LASTEXITCODE -ne 0) { Fail "Smoke test failed." }
  Say "Smoke test passed."
  exit 0
}
Say "Starting ReCut..."
Start-Process -FilePath $electron -ArgumentList '.' -WorkingDirectory $Root | Out-Null
