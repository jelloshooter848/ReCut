<#
  Downloads a Windows FFmpeg build and copies ffmpeg.exe + ffprobe.exe into -Dest (default: resources\ffmpeg).
  Tries several sources with stable URLs, in order. Used by "Start ReCut.cmd" and the Windows CI build.
#>
param([string]$Dest = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path 'resources\ffmpeg'))

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$sources = @(
  'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',                         # current stable release (GPL, includes libx264)
  'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip'  # fallback
)
$zip = Join-Path ([IO.Path]::GetTempPath()) "recut-ffmpeg-$PID.zip"
$tmp = Join-Path ([IO.Path]::GetTempPath()) "recut-ffmpeg-$PID"
$errors = @()
foreach ($url in $sources) {
  try {
    Write-Host "[ReCut] Downloading FFmpeg from $url"
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
    if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    New-Item -ItemType Directory -Force -Path $Dest | Out-Null
    foreach ($exe in 'ffmpeg.exe', 'ffprobe.exe') {
      $src = Get-ChildItem -Path $tmp -Recurse -Filter $exe | Select-Object -First 1
      if (-not $src) { throw "$exe not found in the download" }
      Copy-Item $src.FullName (Join-Path $Dest $exe) -Force
    }
    $ver = (& (Join-Path $Dest 'ffmpeg.exe') -hide_banner -version | Select-Object -First 1)
    Write-Host "[ReCut] Installed $ver into $Dest"
    exit 0
  } catch {
    $errors += "$url : $($_.Exception.Message)"
  } finally {
    Remove-Item -Force $zip -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }
}
Write-Host "[ReCut] Could not download FFmpeg:`n  $($errors -join "`n  ")"
exit 1
