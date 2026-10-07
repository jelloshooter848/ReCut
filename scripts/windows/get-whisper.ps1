<#
  Builds the speech-to-text engine (whisper.cpp's whisper-cli.exe, CPU only) from the pinned, verified source and puts
  it into -Dest (default: resources\whisper), which electron-builder bundles (package.json -> build.extraResources).
  The Windows counterpart of scripts/linux/get-whisper.sh, used by the Windows CI jobs (.github/workflows/windows.yml).

    scripts\windows\get-whisper.ps1                       -> resources\whisper
    scripts\windows\get-whisper.ps1 -Dest <folder> -Jobs 4

  Source: scripts/whisper-source.mjs fetches the pinned release tag (tarball, or a git clone of the tag) and checks its
  source-tree SHA-256 before anything is compiled. Built from source rather than taken from the project's prebuilt
  Windows zip so the three platforms share one pinned, hash-checked source and the same CPU dispatch (the prebuilt
  zips are built for a fixed CPU level, and their contents and flags are not pinned by a checksum ReCut controls).

  Build: Visual Studio 2022 (MSVC, x64), shared ggml with the CPU kernels as loadable backends (GGML_BACKEND_DL +
  GGML_CPU_ALL_VARIANTS, GGML_NATIVE=OFF): ggml loads the best variant the CPU supports at start. The same five
  variants as on Linux ship: x64, sse42, sandybridge (AVX), haswell (AVX2) and skylakex (AVX-512). No OpenMP. The
  Visual C++ runtime DLLs (vcruntime140*.dll, msvcp140.dll) are copied next to the engine (app-local deployment, allowed
  by the Visual Studio redistribution terms), so no "VC++ Redistributable" install is needed.

  Writes into -Dest: whisper-cli.exe, whisper.dll, ggml.dll, ggml-base.dll, ggml-cpu-*.dll, the VC++ runtime DLLs,
  WHISPER-LICENSE.txt (MIT) and WHISPER-BUILD.txt (tag, commit, source hash, flags, files, `whisper-cli --version`).
  Needs Visual Studio 2022 with the C++ workload, cmake, node, tar and git (fallback).
#>
param(
  [string]$Dest = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path 'resources\whisper'),
  [int]$Jobs = 2,
  # Keep the source and the build here between runs (incremental rebuilds); default a temp folder.
  [string]$WorkDir = ''
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false   # exit codes are checked by hand
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
# CPU kernel variants to ship (see above); ggml picks the best one this CPU supports at start.
$variants = @('x64', 'sse42', 'sandybridge', 'haswell', 'skylakex')

foreach ($tool in @('cmake', 'node', 'tar')) {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "[ReCut] $tool is required (install it and run again)." }
}

$temp = $WorkDir -eq ''
$work = if ($temp) { Join-Path ([IO.Path]::GetTempPath()) ("recut-whisper-" + [guid]::NewGuid().ToString('N').Substring(0, 8)) } else { $WorkDir }
New-Item -ItemType Directory -Force -Path $work | Out-Null
try {
  $pin = node (Join-Path $root 'scripts\whisper-source.mjs') --pin | ConvertFrom-Json
  $src = Join-Path $work 'src'
  $reuse = $false
  if (Test-Path (Join-Path $src '.recut-source.txt')) {
    $h = node (Join-Path $root 'scripts\whisper-source.mjs') --hash $src
    $reuse = ($h -eq $pin.treeSha256)
  }
  if ($reuse) { Write-Host "[ReCut] Reusing the verified source in $src" }
  else {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $src, (Join-Path $work 'build')
    node (Join-Path $root 'scripts\whisper-source.mjs') --dest $src
    if ($LASTEXITCODE -ne 0) { throw '[ReCut] could not fetch the whisper.cpp source' }
  }

  $build = Join-Path $work 'build'
  $flags = @(
    '-DBUILD_SHARED_LIBS=ON', '-DGGML_BACKEND_DL=ON', '-DGGML_CPU_ALL_VARIANTS=ON', '-DGGML_NATIVE=OFF', '-DGGML_OPENMP=OFF',
    '-DGGML_CCACHE=OFF', '-DWHISPER_BUILD_IS_DEV=OFF', '-DWHISPER_BUILD_TESTS=OFF', '-DWHISPER_BUILD_SERVER=OFF',
    '-DWHISPER_BUILD_EXAMPLES=ON', '-DWHISPER_SDL2=OFF', '-DWHISPER_CURL=OFF', '-DWHISPER_ALL_WARNINGS=OFF'
  )
  Write-Host "[ReCut] Configuring whisper.cpp $($pin.tag) (Visual Studio 2022, x64)"
  cmake -S $src -B $build -G 'Visual Studio 17 2022' -A x64 @flags | Out-File (Join-Path $work 'configure.log')
  if ($LASTEXITCODE -ne 0) { Get-Content (Join-Path $work 'configure.log') -Tail 40; throw '[ReCut] cmake configure failed' }
  $targets = @('whisper-cli') + ($variants | ForEach-Object { "ggml-cpu-$_" })
  Write-Host "[ReCut] Building $($targets -join ', ') with $Jobs jobs"
  cmake --build $build --config Release --parallel $Jobs --target @targets | Out-File (Join-Path $work 'build.log')
  if ($LASTEXITCODE -ne 0) { Get-Content (Join-Path $work 'build.log') -Tail 60; throw '[ReCut] build failed' }

  $bin = Join-Path $build 'bin\Release'
  if (-not (Test-Path (Join-Path $bin 'whisper-cli.exe'))) { throw "[ReCut] build produced no $bin\whisper-cli.exe" }
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $Dest
  New-Item -ItemType Directory -Force -Path $Dest | Out-Null
  Copy-Item (Join-Path $bin 'whisper-cli.exe') $Dest
  foreach ($dll in @('whisper.dll', 'ggml.dll', 'ggml-base.dll')) {
    $f = Get-ChildItem -Recurse -File -Path $build -Filter $dll | Select-Object -First 1
    if (-not $f) { throw "[ReCut] build produced no $dll" }
    Copy-Item $f.FullName $Dest
  }
  foreach ($v in $variants) {
    $f = Get-ChildItem -Recurse -File -Path $build -Filter "ggml-cpu-$v.dll" | Select-Object -First 1
    if (-not $f) { throw "[ReCut] build produced no ggml-cpu-$v.dll" }
    Copy-Item $f.FullName $Dest
  }

  # Visual C++ runtime, app-local (the newest MSVC redist folder of the newest Visual Studio).
  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
  $vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  $crt = Get-ChildItem -Directory -Path (Join-Path $vs 'VC\Redist\MSVC') | Sort-Object Name -Descending |
    ForEach-Object { Get-ChildItem -Directory -Path (Join-Path $_.FullName 'x64') -Filter 'Microsoft.VC*.CRT' -ErrorAction SilentlyContinue } |
    Select-Object -First 1
  if (-not $crt) { throw '[ReCut] Visual C++ runtime (VC\Redist\MSVC\*\x64\Microsoft.VC*.CRT) not found' }
  $runtime = @('vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll')
  foreach ($dll in $runtime) { Copy-Item (Join-Path $crt.FullName $dll) $Dest }

  # Run it: --version, and --help must list the options ReCut passes.
  $exe = Join-Path $Dest 'whisper-cli.exe'
  $version = (& $exe --version 2>&1 | Out-String).Trim()
  if ($version -notmatch 'whisper\.cpp version:') { throw "[ReCut] whisper-cli --version printed: $version" }
  $help = (& $exe --help 2>&1 | Out-String)
  foreach ($opt in @('--output-json', '--print-progress', '--language', '--translate', '--threads', '--output-file')) {
    if ($help -notmatch [regex]::Escape($opt)) { throw "[ReCut] whisper-cli --help does not list $opt" }
  }

  Copy-Item (Join-Path $src 'LICENSE') (Join-Path $Dest 'WHISPER-LICENSE.txt')
  $fetched = (Get-Content (Join-Path $src '.recut-source.txt') | Select-Object -First 1)
  $files = Get-ChildItem -File $Dest | Where-Object { $_.Name -notlike 'WHISPER-*' } | ForEach-Object { '  {0,10}  {1}' -f $_.Length, $_.Name }
  $cl = (Get-ChildItem -Recurse -File -Path (Join-Path $vs 'VC\Tools\MSVC') -Filter 'cl.exe' | Where-Object { $_.FullName -match 'Hostx64\\x64' } | Select-Object -First 1).FullName
  @(
    'whisper.cpp speech-to-text engine bundled with ReCut',
    '',
    'Project:     https://github.com/ggml-org/whisper.cpp (MIT licence, see WHISPER-LICENSE.txt; includes ggml, MIT)',
    "Version:     $($pin.tag) (commit $($pin.commit))",
    "Source:      $($pin.tarball)",
    "             (the same files as the tag in git; source-tree SHA-256 $($pin.treeSha256), see scripts/whisper-source.mjs)",
    "Fetched:     $fetched",
    "Built:       $((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')) on Windows x64, Visual Studio 2022 ($cl), $((cmake --version | Select-Object -First 1))",
    'Script:      scripts/windows/get-whisper.ps1',
    "CMake flags: -G `"Visual Studio 17 2022`" -A x64 --config Release $($flags -join ' ')",
    "CPU variants: $($variants -join ' ')",
    "VC++ runtime: $($runtime -join ', ') from $($crt.FullName) (app-local)",
    "Engine:      $version",
    '',
    'Files:'
  ) + $files | Set-Content -Encoding utf8 (Join-Path $Dest 'WHISPER-BUILD.txt')

  $bytes = (Get-ChildItem -File $Dest | Measure-Object -Sum Length).Sum
  Write-Host "[ReCut] whisper.cpp $($pin.tag) -> $Dest ($bytes bytes): $version"
}
finally {
  if ($temp) { Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $work }
}
