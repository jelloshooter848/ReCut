<#
  Downloads a Windows FFmpeg build and copies ffmpeg.exe + ffprobe.exe into -Dest (default: resources\ffmpeg).
  Tries several sources with stable URLs, in order. Used by "Start ReCut.cmd" and the Windows CI build.

  Next to the executables it also writes what a redistributed GPL FFmpeg build must come with:
    FFMPEG-LICENSE.txt  the licence file shipped in the downloaded archive (GPL for these builds)
    FFMPEG-README.txt   the archive's readme, when it has one (gyan.dev lists the bundled libraries and versions)
    FFMPEG-BUILD.txt    source URL, build name, `ffmpeg -version` output, date, and where to get the corresponding source
  A download whose archive has no licence file is rejected and the next source is tried.
#>
param([string]$Dest = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path 'resources\ffmpeg'))

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Release builds only: FFmpeg development ("master") builds have shipped encoder bugs that hang exports.
$sources = @(
  'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',                                   # current stable release (GPL, includes libx264)
  'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n9.0-latest-win64-gpl-9.0.zip',  # fallback: 9.0 release branch
  'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-win64-gpl-8.1.zip'   # fallback: 8.1 release branch
)
# Files this script writes next to the executables (removed first, so a previous build's files never linger).
$extraFiles = @('FFMPEG-LICENSE.txt', 'FFMPEG-README.txt', 'FFMPEG-BUILD.txt')

# The licence or readme file at the top of the extracted build (the folder above bin\), else the first file anywhere in
# the archive with one of these exact names. $names are tried in order.
function Find-BuildFile([string]$root, [string]$buildDir, [string[]]$names) {
  foreach ($n in $names) {
    $p = Join-Path $buildDir $n
    if (Test-Path -LiteralPath $p -PathType Leaf) { return (Get-Item -LiteralPath $p) }
  }
  foreach ($n in $names) {
    $f = Get-ChildItem -LiteralPath $root -Recurse -File | Where-Object { $_.Name -ieq $n } | Select-Object -First 1
    if ($f) { return $f }
  }
  return $null
}

# Where to get the source corresponding to this build, from the download URL and `ffmpeg -version`.
function Get-SourceInfo([string]$url, [string]$versionString) {
  $lines = @()
  if ($url -match 'gyan\.dev') {
    $rel = if ($versionString -match '^n?(\d+(?:\.\d+)*)') { $Matches[1] } else { $null }
    $lines += 'Build provider: gyan.dev (Gyan Doshi), "release essentials" build.'
    $lines += 'Build page (build scripts, configuration and library list): https://www.gyan.dev/ffmpeg/builds/'
    if ($rel) {
      $lines += "FFmpeg $rel release source: https://ffmpeg.org/releases/ffmpeg-$rel.tar.xz"
    } else {
      $lines += 'FFmpeg release sources: https://ffmpeg.org/releases/'
    }
    $lines += 'The external libraries compiled into this build (libx264 and others) and their versions are listed in'
    $lines += 'FFMPEG-README.txt and in the "configuration:" line below; each library''s source is available from its project.'
  } elseif ($url -match 'BtbN/FFmpeg-Builds') {
    $lines += 'Build provider: BtbN/FFmpeg-Builds (GitHub), win64 GPL build.'
    $lines += 'Downloaded from the rolling "latest" release: https://github.com/BtbN/FFmpeg-Builds/releases/tag/latest'
    $lines += 'Dated releases (the date at the end of the version string is the build date): https://github.com/BtbN/FFmpeg-Builds/releases'
    $lines += 'Build scripts (they pin every library''s source revision): https://github.com/BtbN/FFmpeg-Builds'
    if ($versionString -match '-g([0-9a-f]{7,40})(?:-|$)') {
      $c = $Matches[1]
      $lines += "FFmpeg source commit: https://github.com/FFmpeg/FFmpeg/commit/$c"
      $lines += "FFmpeg source archive: https://github.com/FFmpeg/FFmpeg/archive/$c.tar.gz"
    } elseif ($versionString -match '^(n\d+(?:\.\d+)*)(?:-\d{8})?$') {
      $t = $Matches[1]
      $lines += "FFmpeg source tag: https://github.com/FFmpeg/FFmpeg/releases/tag/$t"
      $lines += "FFmpeg source archive: https://github.com/FFmpeg/FFmpeg/archive/refs/tags/$t.tar.gz"
    } else {
      $lines += 'FFmpeg source: https://github.com/FFmpeg/FFmpeg (match the version string below)'
    }
    $lines += 'The external libraries compiled into this build (libx264 and others) are listed in the "configuration:" line below.'
  } else {
    $lines += 'FFmpeg source: https://ffmpeg.org/download.html#get-sources (match the version string below)'
  }
  return $lines
}

$zip = Join-Path ([IO.Path]::GetTempPath()) "recut-ffmpeg-$PID.zip"
$tmp = Join-Path ([IO.Path]::GetTempPath()) "recut-ffmpeg-$PID"
$errors = @()
foreach ($url in $sources) {
  try {
    Write-Host "[ReCut] Downloading FFmpeg from $url"
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
    if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
    Expand-Archive -Path $zip -DestinationPath $tmp -Force

    # Check the whole download before touching -Dest.
    $exeFiles = @{}
    foreach ($exe in 'ffmpeg.exe', 'ffprobe.exe') {
      $src = Get-ChildItem -Path $tmp -Recurse -Filter $exe | Select-Object -First 1
      if (-not $src) { throw "$exe not found in the download" }
      $exeFiles[$exe] = $src
    }
    # Archive layout: <build name>\bin\ffmpeg.exe, with LICENSE (gyan.dev) or LICENSE.txt (BtbN) next to bin\.
    $binDir = $exeFiles['ffmpeg.exe'].Directory
    $buildDir = if ($binDir.Name -ieq 'bin' -and $binDir.Parent) { $binDir.Parent } else { $binDir }
    $sep = [char[]]@('\', '/')
    $buildName = if ($buildDir.FullName.TrimEnd($sep) -ieq (Get-Item -LiteralPath $tmp).FullName.TrimEnd($sep)) {
      [IO.Path]::GetFileNameWithoutExtension(([Uri]$url).AbsolutePath)
    } else { $buildDir.Name }
    $licence = Find-BuildFile $tmp $buildDir.FullName @('LICENSE', 'LICENSE.txt', 'LICENSE.md', 'COPYING.GPLv3', 'COPYING.txt', 'COPYING')
    if (-not $licence) { throw 'no LICENSE file found in the download (a GPL build must ship with its licence)' }
    $readme = Find-BuildFile $tmp $buildDir.FullName @('README.txt', 'README', 'README.md')

    New-Item -ItemType Directory -Force -Path $Dest | Out-Null
    $Dest = (Resolve-Path -LiteralPath $Dest).Path   # absolute: [IO.File] below does not follow the PowerShell location
    foreach ($f in $extraFiles) { Remove-Item -LiteralPath (Join-Path $Dest $f) -Force -ErrorAction SilentlyContinue }
    foreach ($exe in 'ffmpeg.exe', 'ffprobe.exe') {
      Copy-Item -LiteralPath $exeFiles[$exe].FullName -Destination (Join-Path $Dest $exe) -Force
    }
    Copy-Item -LiteralPath $licence.FullName -Destination (Join-Path $Dest 'FFMPEG-LICENSE.txt') -Force
    if ($readme) { Copy-Item -LiteralPath $readme.FullName -Destination (Join-Path $Dest 'FFMPEG-README.txt') -Force }

    $versionOut = @(& (Join-Path $Dest 'ffmpeg.exe') -hide_banner -version)
    if ($LASTEXITCODE -ne 0 -or $versionOut.Count -eq 0) { throw "ffmpeg.exe -version failed (exit $LASTEXITCODE)" }
    $ver = [string]$versionOut[0]
    $versionString = if ($ver -match '^ffmpeg version (\S+)') { $Matches[1] } else { '' }
    $readmeNote = if ($readme) { 'FFMPEG-README.txt (copied from ' + $readme.Name + ' in the archive)' } else { '(none in the archive)' }
    $versionText = $versionOut -join "`n"
    $licenceName = if ($versionText -match '--enable-gpl') {
      if ($versionText -match '--enable-version3') { 'GNU General Public License version 3 or later (GPL-3.0-or-later)' } else { 'GNU General Public License version 2 or later (GPL-2.0-or-later)' }
    } else {
      if ($versionText -match '--enable-version3') { 'GNU Lesser General Public License version 3 or later (LGPL-3.0-or-later)' } else { 'GNU Lesser General Public License version 2.1 or later (LGPL-2.1-or-later)' }
    }
    $written = if ($readme) { 'FFMPEG-LICENSE.txt, FFMPEG-README.txt and FFMPEG-BUILD.txt' } else { 'FFMPEG-LICENSE.txt and FFMPEG-BUILD.txt' }

    $build = @(
      'FFmpeg build bundled with ReCut',
      '================================',
      '',
      'ReCut runs these ffmpeg.exe and ffprobe.exe binaries as separate programs. They are not part of ReCut and are',
      'not covered by ReCut''s MIT licence. Going by the configuration line below, they are distributed under the',
      "$licenceName.",
      'The licence text that came with the build is in FFMPEG-LICENSE.txt.',
      '',
      "Downloaded from: $url",
      "Build name:      $buildName",
      "FFmpeg version:  $versionString",
      "Licence file:    FFMPEG-LICENSE.txt (copied from $($licence.Name) in the archive)",
      "Readme file:     $readmeNote",
      "Downloaded on:   $((Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ss')) UTC",
      '',
      'Corresponding source',
      '--------------------'
    )
    $build += @(Get-SourceInfo $url $versionString)
    $build += @('', 'ffmpeg -version', '---------------')
    $build += @($versionOut | ForEach-Object { [string]$_ })
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText((Join-Path $Dest 'FFMPEG-BUILD.txt'), (($build -join "`r`n") + "`r`n"), $utf8NoBom)

    Write-Host "[ReCut] Installed $ver into $Dest"
    Write-Host "[ReCut] Wrote $written ($buildName)"
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
