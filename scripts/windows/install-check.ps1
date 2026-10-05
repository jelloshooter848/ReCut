<#
  Install check for the Windows packages in -Release (default: release\). Used by .github/workflows/windows.yml.

  1. Silently installs ReCut-Setup-*.exe, smoke-tests the installed app (first -SmokeAttempts attempts), silently
     uninstalls it, and repeats -Attempts times. Each uninstall removes the per-user registry keys, so every attempt
     is a fresh per-user install: the path that crashed in bugs/closed/2026-10-05-nsis-installer-crash-system-dll.md
     (System.dll 0xc0000005 at offset 0x1581). That crash was intermittent, so a single install proves little.
  2. Launches ReCut-Portable-*.exe once with RECUT_SMOKE=1 and checks the smoke output (unless -SkipPortable).

  Prints the CPU and OS build first, writes one line per attempt and a summary (also as a ::notice annotation and to
  the job summary), and exits non-zero if any attempt or the portable check failed. On a failed install it prints
  the diagnostics: Application error events (faulting module), NSIS temp dirs, the Programs folder.
#>
param(
  [string]$Release = 'release',
  [int]$Attempts = 5,
  [int]$SmokeAttempts = 1,
  [switch]$SkipPortable
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$work = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }

$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$os = Get-CimInstance Win32_OperatingSystem
$hostInfo = "$($cpu.Name.Trim()) [$($cpu.Manufacturer), $($cpu.NumberOfCores) cores], $($os.Caption) build $($os.BuildNumber)"
Write-Host "Host: $hostInfo"

$setup = Get-ChildItem $Release -Filter 'ReCut-Setup-*.exe' | Select-Object -First 1
if (-not $setup) { throw "no ReCut-Setup-*.exe in $Release" }
Write-Host "Installer: $($setup.FullName) ($($setup.Length) bytes)"

$roots = @("$env:LOCALAPPDATA\Programs", "$env:ProgramFiles", "${env:ProgramFiles(x86)}") | Where-Object { $_ -and (Test-Path $_) }

function Find-InstalledExe {
  Get-ChildItem $roots -Recurse -Depth 3 -Filter ReCut.exe -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notlike '*\Uninstall*' } | Select-Object -First 1
}

function Find-UninstallEntry {
  Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -like 'ReCut*' } | Select-Object -First 1
}

function Show-InstallDiagnostics([datetime]$since) {
  Get-ChildItem "$env:LOCALAPPDATA\Programs" -ErrorAction SilentlyContinue | Format-Table -AutoSize | Out-String | Write-Host
  Get-WinEvent -FilterHashtable @{ LogName = 'Application'; StartTime = $since.AddSeconds(-5) } -ErrorAction SilentlyContinue |
    Where-Object { $_.Id -in 1000, 1001, 1026 } | Select-Object -First 6 |
    ForEach-Object { Write-Host "---- event $($_.Id) $($_.ProviderName)"; Write-Host $_.Message }
  Get-ChildItem $env:TEMP -Filter 'ns*.tmp' -Directory -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 3 |
    ForEach-Object { Write-Host "NSIS temp: $($_.FullName)"; Get-ChildItem $_.FullName -Recurse | Select-Object FullName, Length | Format-Table -AutoSize | Out-String | Write-Host }
}

# Launches $exe with RECUT_SMOKE=1 and returns $null on success or a failure reason.
function Invoke-Smoke([string]$exe, [string]$name, [int]$timeoutMs, [string[]]$mustMatch) {
  $out = Join-Path $work "smoke-$name.txt"
  Remove-Item $out -ErrorAction SilentlyContinue
  $env:RECUT_SMOKE = '1'; $env:RECUT_SMOKE_OUT = $out; $env:RECUT_USER_DATA = Join-Path $work "ud-$name"
  try {
    $p = Start-Process -FilePath $exe -PassThru
    if (-not $p.WaitForExit($timeoutMs)) { $p.Kill(); return 'smoke test timed out' }
  } finally {
    Remove-Item Env:RECUT_SMOKE, Env:RECUT_SMOKE_OUT, Env:RECUT_USER_DATA -ErrorAction SilentlyContinue
  }
  if (-not (Test-Path $out)) { return "no smoke output (exit code $($p.ExitCode))" }
  Get-Content $out | ForEach-Object { Write-Host "  $_" }
  $r = Get-Content $out -Raw
  if ($r -cmatch 'FAILED|layout=MISSING') { return 'smoke output reports a failure' }
  foreach ($m in $mustMatch) { if ($r -notmatch $m) { return "smoke output lacks /$m/" } }
  return $null
}

$results = @()
for ($n = 1; $n -le $Attempts; $n++) {
  $t0 = Get-Date
  $row = [ordered]@{ Attempt = $n; ExitCode = $null; Installed = $false; Smoke = '-'; Uninstalled = $false; Seconds = 0; Error = '' }
  try {
    if (Find-InstalledExe) { throw 'ReCut.exe is already installed before the attempt (previous uninstall incomplete)' }
    $inst = Start-Process -FilePath $setup.FullName -ArgumentList '/S' -Wait -PassThru
    $row.ExitCode = $inst.ExitCode
    # The NSIS installer can hand off to a child process, so poll for the installed app. A crashed installer
    # (non-zero exit) installs nothing, so do not wait long for it.
    $polls = if ($inst.ExitCode -eq 0) { 60 } else { 5 }
    $exe = $null
    for ($i = 0; $i -lt $polls -and -not $exe; $i++) { $exe = Find-InstalledExe; if (-not $exe) { Start-Sleep -Seconds 2 } }
    $row.Installed = [bool]$exe
    if ($inst.ExitCode -ne 0 -or -not $exe) {
      $row.Error = "installer exit code $($inst.ExitCode) ($('0x{0:x8}' -f $inst.ExitCode)), installed exe $(if ($exe) { 'found' } else { 'not found' })"
      Show-InstallDiagnostics $t0
    }
    if ($exe -and $inst.ExitCode -eq 0 -and $n -le $SmokeAttempts) {
      Write-Host "Attempt ${n}: installed at $($exe.FullName); smoke-testing it"
      $fail = Invoke-Smoke $exe.FullName "installed-$n" 180000 @('encode\+probe ok')
      $row.Smoke = if ($fail) { 'FAILED' } else { 'ok' }
      if ($fail) { $row.Error = "installed-app smoke test: $fail" }
    }
    if ($exe) {
      $entry = Find-UninstallEntry
      if (-not $entry -or -not $entry.QuietUninstallString) { throw 'no uninstall registry entry with QuietUninstallString' }
      if (-not ($entry.QuietUninstallString -match '^"([^"]+)"\s*(.*)$')) { throw "cannot parse QuietUninstallString: $($entry.QuietUninstallString)" }
      $unArgs = @{ FilePath = $Matches[1]; Wait = $true; PassThru = $true }
      if ($Matches[2]) { $unArgs.ArgumentList = $Matches[2] }
      $un = Start-Process @unArgs
      # The NSIS uninstaller re-launches itself from %TEMP% and returns at once: poll until the app is gone.
      for ($i = 0; $i -lt 60 -and ((Find-InstalledExe) -or (Find-UninstallEntry)); $i++) { Start-Sleep -Seconds 2 }
      $row.Uninstalled = -not (Find-InstalledExe) -and -not (Find-UninstallEntry)
      if (-not $row.Uninstalled) {
        $row.Error = ($row.Error, "uninstall (exit code $($un.ExitCode)) left ReCut installed" | Where-Object { $_ }) -join '; '
      }
    }
  } catch {
    $row.Error = ($row.Error, "$_" | Where-Object { $_ }) -join '; '
  }
  $row.Seconds = [int]((Get-Date) - $t0).TotalSeconds
  $ok = -not $row.Error
  Write-Host ("Attempt {0}/{1}: {2} exit={3} installed={4} smoke={5} uninstalled={6} {7}s {8}" -f $n, $Attempts, $(if ($ok) { 'PASS' } else { 'FAIL' }), $row.ExitCode, $row.Installed, $row.Smoke, $row.Uninstalled, $row.Seconds, $row.Error)
  $results += [pscustomobject]$row
  # Without a clean uninstall the next attempt would not be a fresh install: stop here.
  if ($row.Installed -and -not $row.Uninstalled) { break }
}

$portable = 'skipped'
if (-not $SkipPortable) {
  $exe = Get-ChildItem $Release -Filter 'ReCut-Portable-*.exe' | Select-Object -First 1
  if (-not $exe) { $portable = 'FAILED: no ReCut-Portable-*.exe' }
  else {
    Write-Host "Portable: $($exe.FullName); smoke-testing it (extracts to %TEMP% first)"
    $fail = Invoke-Smoke $exe.FullName 'portable' 300000 @('encode\+probe ok', 'status=206', 'resources\\ffmpeg')
    $portable = if ($fail) { "FAILED: $fail" } else { 'ok' }
  }
}

$results | Format-Table -AutoSize | Out-String -Width 300 | Write-Host
$passed = @($results | Where-Object { -not $_.Error }).Count
$summary = "host=$hostInfo; install attempts $passed/$Attempts passed (exit codes: $(($results | ForEach-Object { $_.ExitCode }) -join ',')); portable=$portable"
Write-Host "::notice title=install-check::$summary"
if ($env:GITHUB_STEP_SUMMARY) { Add-Content -Path $env:GITHUB_STEP_SUMMARY -Value "**install-check**: $summary" }
if ($passed -ne $Attempts -or $portable -notin 'ok', 'skipped') { throw "install check failed: $summary" }
