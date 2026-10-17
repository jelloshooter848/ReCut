<#
  Install check for the Windows packages in -Release (default: release\). Used by .github/workflows/windows.yml.

  1. Silently installs <product>-Setup-*.exe, smoke-tests the installed app (first -SmokeAttempts attempts), silently
     uninstalls it, and repeats -Attempts times. Each uninstall removes the per-user registry keys, so every attempt
     is a fresh per-user install: the path that crashed in bugs/closed/2026-10-05-nsis-installer-crash-system-dll.md
     (System.dll 0xc0000005 at offset 0x1581). That crash was intermittent, so a single install proves little.
  2. With -UpgradeFrom <an earlier release's setup exe>: installs that release, installs this build over it and checks
     that it was upgraded in place (one uninstall entry, under the pinned NSIS GUID package.json build.nsis.guid, the
     same install folder, the new app files), smoke-tests the upgraded app and uninstalls it.
  3. Launches <product>-Portable-*.exe once with RECUT_SMOKE=1 and checks the smoke output (unless -SkipPortable).

  The product, shortcut and GUID come from package.json (build.productName, build.nsis), which
  tests/unit/product-identity-sync.test.ts keeps equal to shared/productIdentity.ts.

  Prints the CPU and OS build first, writes one line per attempt and a summary (also as a ::notice annotation and to
  the job summary), and exits non-zero if any attempt or the portable check failed. On a failed install it prints
  the diagnostics: Application error events (faulting module), NSIS temp dirs, the Programs folder.
#>
param(
  [string]$Release = 'release',
  [int]$Attempts = 5,
  [int]$SmokeAttempts = 1,
  [switch]$SkipPortable,
  [string]$UpgradeFrom = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$work = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }

$pkg = Get-Content (Join-Path $PSScriptRoot '..\..\package.json') -Raw | ConvertFrom-Json
$product = $pkg.build.productName
$shortcut = $pkg.build.nsis.shortcutName
$guid = $pkg.build.nsis.guid
$exeName = "$product.exe"

$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$os = Get-CimInstance Win32_OperatingSystem
$hostInfo = "$($cpu.Name.Trim()) [$($cpu.Manufacturer), $($cpu.NumberOfCores) cores], $($os.Caption) build $($os.BuildNumber)"
Write-Host "Host: $hostInfo"

$setup = Get-ChildItem $Release -Filter "$product-Setup-*.exe" | Select-Object -First 1
if (-not $setup) { throw "no $product-Setup-*.exe in $Release" }
Write-Host "Installer: $($setup.FullName) ($($setup.Length) bytes)"

# The installed <product>.exe: in the InstallLocation the installer recorded, or in the default per-user / per-machine
# folder. (Test-Path on known paths: a recursive Get-ChildItem -Filter search came back empty here even with the exe
# present.)
function Find-InstalledExe {
  $dirs = @(Get-ItemProperty 'HKCU:\Software\*', 'HKLM:\Software\*' -ErrorAction SilentlyContinue |
      Where-Object { $_.ShortcutName -eq $shortcut -and $_.InstallLocation } | ForEach-Object { $_.InstallLocation })
  $dirs += "$env:LOCALAPPDATA\Programs\$product", "$env:ProgramFiles\$product", "${env:ProgramFiles(x86)}\$product"
  foreach ($d in $dirs) {
    $p = Join-Path $d $exeName
    if (Test-Path -LiteralPath $p -PathType Leaf) { return Get-Item -LiteralPath $p }
  }
}

function Find-UninstallEntries {
  Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -like "$product*" }
}

function Find-UninstallEntry { Find-UninstallEntries | Select-Object -First 1 }

function Show-InstallDiagnostics([datetime]$since) {
  Get-ChildItem "$env:LOCALAPPDATA\Programs" -ErrorAction SilentlyContinue | Format-Table -AutoSize | Out-String | Write-Host
  Get-ChildItem "$env:LOCALAPPDATA\Programs\$product" -Recurse -Depth 1 -ErrorAction SilentlyContinue | Select-Object -First 40 FullName, Length, LastWriteTime |
    Format-Table -AutoSize | Out-String -Width 300 | Write-Host
  Write-Host 'Install registry entries:'
  Get-ItemProperty 'HKCU:\Software\*' -ErrorAction SilentlyContinue | Where-Object { $_.InstallLocation -or $_.ShortcutName -like "$shortcut*" } |
    Select-Object PSChildName, InstallLocation, ShortcutName | Format-List | Out-String | Write-Host
  Find-UninstallEntry | Select-Object PSChildName, DisplayName, InstallLocation, QuietUninstallString | Format-List | Out-String | Write-Host
  Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -match "$([regex]::Escape($product))|Setup|^Un_|^Au_" } | Select-Object Id, Name, Path | Format-Table -AutoSize | Out-String -Width 300 | Write-Host
  Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-Windows Defender/Operational'; StartTime = $since.AddSeconds(-5) } -ErrorAction SilentlyContinue |
    Where-Object { $_.Id -in 1006, 1007, 1008, 1015, 1116, 1117, 1118, 1119 } | Select-Object -First 4 |
    ForEach-Object { Write-Host "---- Defender event $($_.Id)"; Write-Host $_.Message }
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
    if (Find-InstalledExe) { throw "$exeName is already installed before the attempt (previous uninstall incomplete)" }
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
      $fail = Invoke-Smoke $exe.FullName "installed-$n" 180000 @('encode\+probe ok', 'ocr core=(relaxedsimd-lstm|lstm) ok', 'whisper engine=[0-9.]+ ok path=.*\\resources\\whisper\\whisper-cli\.exe')
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
        $row.Error = ($row.Error, "uninstall (exit code $($un.ExitCode)) left $product installed" | Where-Object { $_ }) -join '; '
      }
    }
  } catch {
    $row.Error = ($row.Error, "$_" | Where-Object { $_ }) -join '; '
  }
  $row.Seconds = [int]((Get-Date) - $t0).TotalSeconds
  $ok = -not $row.Error
  Write-Host ("Attempt {0}/{1}: {2} exit={3} installed={4} smoke={5} uninstalled={6} {7}s {8}" -f $n, $Attempts, $(if ($ok) { 'PASS' } else { 'FAIL' }), $row.ExitCode, $row.Installed, $row.Smoke, $row.Uninstalled, $row.Seconds, $row.Error)
  $results += [pscustomobject]$row
  # Without a clean uninstall the next attempt would not be a fresh install: stop here. Keep going after a crash
  # (non-zero exit, nothing installed) so the run counts how often it happens; stop on any other failure.
  if ($row.Installed -and -not $row.Uninstalled) { break }
  if ($row.Error -and $row.ExitCode -eq 0) { break }
}

# Runs the quiet uninstaller of the installed app and waits until it is gone; throws when it stays.
function Invoke-Uninstall {
  $entry = Find-UninstallEntry
  if (-not $entry -or -not $entry.QuietUninstallString) { throw 'no uninstall registry entry with QuietUninstallString' }
  if (-not ($entry.QuietUninstallString -match '^"([^"]+)"\s*(.*)$')) { throw "cannot parse QuietUninstallString: $($entry.QuietUninstallString)" }
  $unArgs = @{ FilePath = $Matches[1]; Wait = $true; PassThru = $true }
  if ($Matches[2]) { $unArgs.ArgumentList = $Matches[2] }
  $un = Start-Process @unArgs
  for ($i = 0; $i -lt 60 -and ((Find-InstalledExe) -or (Find-UninstallEntry)); $i++) { Start-Sleep -Seconds 2 }
  if ((Find-InstalledExe) -or (Find-UninstallEntry)) { throw "uninstall (exit code $($un.ExitCode)) left $product installed" }
}

function Get-AsarHash([System.IO.FileInfo]$exe) {
  $asar = Join-Path $exe.DirectoryName 'resources\app.asar'
  if (Test-Path -LiteralPath $asar) { (Get-FileHash -LiteralPath $asar -Algorithm SHA256).Hash } else { '' }
}

# Installs the earlier release $UpgradeFrom, then this build over it: an in-place upgrade keeps one uninstall entry
# (the NSIS GUID), the install folder, and replaces the app. Returns 'ok' or throws.
function Invoke-UpgradeCheck {
  if (Find-InstalledExe) { throw "$exeName is already installed before the upgrade check" }
  $name = [IO.Path]::GetFileName($UpgradeFrom)
  $old = Start-Process -FilePath $UpgradeFrom -ArgumentList '/S' -Wait -PassThru
  $oldExe = $null
  for ($i = 0; $i -lt 60 -and -not $oldExe; $i++) { $oldExe = Find-InstalledExe; if (-not $oldExe) { Start-Sleep -Seconds 2 } }
  if (-not $oldExe) { throw "$name installed nothing (exit code $($old.ExitCode))" }
  $before = @(Find-UninstallEntries)
  if ($before.Count -ne 1) { throw "$($before.Count) uninstall entries after installing $name" }
  $oldKey = $before[0].PSChildName
  $oldAsar = Get-AsarHash $oldExe
  Write-Host "Upgrade: $name installed at $($oldExe.FullName) (uninstall key $oldKey, version $($before[0].DisplayVersion)); installing $($setup.Name) over it"
  $new = Start-Process -FilePath $setup.FullName -ArgumentList '/S' -Wait -PassThru
  if ($new.ExitCode -ne 0) { throw "the upgrade installer exited with $($new.ExitCode)" }
  # The installer runs the old uninstaller (keeping app data), then extracts the new app: poll for the new files.
  $newExe = $null
  for ($i = 0; $i -lt 90; $i++) {
    $newExe = Find-InstalledExe
    if ($newExe -and (Get-AsarHash $newExe) -and (Get-AsarHash $newExe) -ne $oldAsar) { break }
    Start-Sleep -Seconds 2
  }
  if (-not $newExe) { throw 'no installed app after the upgrade' }
  if ((Get-AsarHash $newExe) -eq $oldAsar) { throw 'the app files were not replaced by the upgrade' }
  $after = @(Find-UninstallEntries)
  if ($after.Count -ne 1) { throw "$($after.Count) uninstall entries after the upgrade (an in-place upgrade leaves one): $(($after | ForEach-Object { $_.PSChildName }) -join ', ')" }
  if ($after[0].PSChildName -ne $oldKey) { throw "the uninstall key changed from $oldKey to $($after[0].PSChildName)" }
  if ($guid -and $after[0].PSChildName -ne $guid) { throw "the uninstall key $($after[0].PSChildName) is not build.nsis.guid $guid" }
  if ($after[0].DisplayVersion -ne $pkg.version) { throw "the uninstall entry says version $($after[0].DisplayVersion), expected $($pkg.version)" }
  if ($newExe.DirectoryName -ne $oldExe.DirectoryName) { throw "installed into $($newExe.DirectoryName) instead of $($oldExe.DirectoryName)" }
  Write-Host "Upgrade: upgraded in place at $($newExe.FullName) (uninstall key $oldKey); smoke-testing it"
  $fail = Invoke-Smoke $newExe.FullName 'upgraded' 180000 @('encode\+probe ok')
  if ($fail) { throw "upgraded-app smoke test: $fail" }
  Invoke-Uninstall
  return 'ok'
}

$upgrade = 'skipped'
if ($UpgradeFrom) {
  try { $upgrade = Invoke-UpgradeCheck } catch {
    $upgrade = "FAILED: $_"
    Show-InstallDiagnostics (Get-Date).AddMinutes(-5)
    try { if (Find-InstalledExe) { Invoke-Uninstall } } catch { Write-Host "cleanup after the upgrade check: $_" }
  }
  Write-Host "Upgrade check: $upgrade"
}

$portable = 'skipped'
if (-not $SkipPortable) {
  $exe = Get-ChildItem $Release -Filter "$product-Portable-*.exe" | Select-Object -First 1
  if (-not $exe) { $portable = "FAILED: no $product-Portable-*.exe" }
  else {
    Write-Host "Portable: $($exe.FullName); smoke-testing it (extracts to %TEMP% first)"
    $fail = Invoke-Smoke $exe.FullName 'portable' 300000 @('encode\+probe ok', 'status=206', 'resources\\ffmpeg', 'ocr core=(relaxedsimd-lstm|lstm) ok', 'whisper engine=[0-9.]+ ok path=.*\\resources\\whisper\\whisper-cli\.exe')
    $portable = if ($fail) { "FAILED: $fail" } else { 'ok' }
  }
}

$results | Format-Table -AutoSize | Out-String -Width 300 | Write-Host
$passed = @($results | Where-Object { -not $_.Error }).Count
$summary = "host=$hostInfo; install attempts $passed/$Attempts passed (exit codes: $(($results | ForEach-Object { $_.ExitCode }) -join ',')); upgrade=$upgrade; portable=$portable"
Write-Host "::notice title=install-check::$summary"
if ($env:GITHUB_STEP_SUMMARY) { Add-Content -Path $env:GITHUB_STEP_SUMMARY -Value "**install-check**: $summary" }
if ($passed -ne $Attempts -or $portable -notin 'ok', 'skipped' -or $upgrade -notin 'ok', 'skipped') { throw "install check failed: $summary" }
