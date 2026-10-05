# Windows installer crashes in NSIS System.dll (0xc0000005) before installing anything

| Field | Value |
|---|---|
| Status | in-progress |
| Severity | high |
| Area | packaging |
| Reported by / date | Claude (agent, from the lead's Windows CI evidence), 2026-10-05 |
| Found on commit | b3b9419 (main, release 0.2.0); also on every earlier commit with an NSIS installer |
| Environment | GitHub `windows-latest` (Windows Server 2025, build 26100, same base as Windows 11 24H2), packaged app built with electron-builder 25.1.8 (nsis-3.0.4.1 + nsis-resources-3.4.1). FFmpeg not involved. |

## Report

### Summary
`ReCut-Setup-<version>.exe` intermittently crashes with an access violation inside the NSIS System plugin right after
it starts, before it writes any file. Silent installs exit with -1073741819 and install nothing; an interactive user
would see the installer vanish without a window. Affects the published 0.2.0 installer and every earlier one.

### Steps to reproduce
1. Build on Windows: `npm ci`, `npm run build`, `npx electron-builder --win --x64 --publish never`.
2. On Windows Server 2025 / Windows 11 24H2 with no previous ReCut install for the user, run
   `release\ReCut-Setup-0.2.0.exe /S` and wait for it.
3. Repeat on fresh machines (or uninstall and repeat; see "Scope").

How often: in Windows CI on 2026-10-05, 6 of the 24 installer jobs that ran the install step crashed this way (runs
14, 18, 22, 25, 28, 34, about 1 in 4); 18 installed fine. Each job ran the installer once, on a fresh runner. (Run 5
also failed to install, but that early version of the step did not log the exit code.)

### Expected
The installer installs ReCut to `%LOCALAPPDATA%\Programs\ReCut` and exits with code 0.

### Actual
```
Installer exit code: -1073741819
...
---- event 1000 Application Error
Faulting application name: ReCut-Setup-0.2.0.exe, version: 0.2.0.0, time stamp: 0x5c157f86
Faulting module name: System.dll, version: 0.0.0.0, time stamp: 0x5c157efa
Exception code: 0xc0000005
Fault offset: 0x00001581
Faulting application path: D:\a\ReCut\ReCut\release\ReCut-Setup-0.2.0.exe
Faulting module path: C:\Users\RUNNER~1\AppData\Local\Temp\nsx9514.tmp\System.dll
NSIS temp: C:\Users\runneradmin\AppData\Local\Temp\nsx9514.tmp
  ...\nsx9514.tmp\System.dll  12288
  ...\nsx9514.tmp\UAC.dll     14848
```
Nothing is installed under `%LOCALAPPDATA%\Programs`, `Program Files` or `Program Files (x86)`.

### Evidence
Installer job of the Windows workflow (`.github/workflows/windows.yml`), runs on 2026-10-05:

| Run (number) | Job | Commit | Result | CPU (logged only by the later diagnostics) |
|---|---|---|---|---|
| 37321734748 (14) | 111802348304 | 365b5df | exit -1073741819, nothing installed | not logged |
| 37323351800 (18) | 111808138275 | 9e90cce | exit -1073741819, nothing installed | not logged |
| 37326784484 (22) | 111819469538 | 1ae16a4 | exit -1073741819, nothing installed (run later cancelled) | not logged |
| 37329915698 (25) | 111835562256 | 0639831 | exit -1073741819, nothing installed | not logged |
| 37355856757 (28) | 111917953092 | a72554f | exit -1073741819; event 1000 System.dll 0x1581 (ReCut-Setup-0.1.0.exe) | AMD EPYC 7763 64-Core (AuthenticAMD, 2 cores) |
| 37377961464 (34) | 111992022472 | b3b9419 | exit -1073741819; event 1000 System.dll 0x1581 (ReCut-Setup-0.2.0.exe) | AMD EPYC 7763 64-Core (AuthenticAMD, 2 cores) |

The passing runs did not log their CPU. The re-run of the same commit as a tag build (run 37378792153, v0.2.0)
installed fine, so the 0.2.0 release was published from a passing run of the same installer config.

Build logs show electron-builder 25.1.8 downloading
`electron-builder-binaries/releases/download/nsis-3.0.4.1/nsis-3.0.4.1.7z` and `nsis-resources-3.4.1.7z`.
System.dll time stamp 0x5c157efa = 2018-12-15, i.e. NSIS 3.04, the version pinned in
`app-builder-lib/out/targets/nsis/nsisUtil.js` (`getBinFromUrl("nsis", "3.0.4.1", ...)`).

### Suspected cause (hypothesis)
Two candidates:
1. The old NSIS 3.04 System plugin itself misbehaves on Windows Server 2025 / 24H2 or on some CPUs.
2. A script bug that calls the System plugin with bad arguments, so the plugin is only where the fault lands. Our
   config (`nsis.oneClick: false`, `nsis.perMachine: false`) runs electron-builder's per-user install-dir lookup in
   `templates/nsis/multiUser.nsh`, which copies the `SHGetKnownFolderPath` result with
   `System::Call '*$2(&w${NSIS_MAX_STRLEN} .s)'`, reading a fixed `NSIS_MAX_STRLEN` characters from a heap string about
   45 characters long.

### Scope
- Only the NSIS installer runs `multiUser.nsh`. The portable exe (`portable.nsi`) only calls
  `Kernel32::SetEnvironmentVariable` through the System plugin, so it is unlikely to be affected. CI built it but
  never launched it.
- Every fresh per-user install runs the lookup: a first install, or a reinstall after uninstalling (the uninstaller
  deletes the `InstallLocation` registry value). Updates over an existing install skip it.

---

## Verification

| Field | Value |
|---|---|
| Verified by / date | Claude (agent), 2026-10-05 |
| Verified on commit | b3b9419 |
| Verdict | confirmed; suspected cause 2 is right |

Cause 2 (the template) is confirmed by the code and by an identical upstream report:

- `node_modules/app-builder-lib/templates/nsis/multiUser.nsh` (25.1.8), `setInstallModePerUser`, runs when
  `HKCU\Software\<APP_GUID>\InstallLocation` is empty (a fresh per-user install):
  ```nsis
  System::Call 'SHELL32::SHGetKnownFolderPath(g "${FOLDERID_UserProgramFiles}", i ${KF_FLAG_CREATE}, p 0, *p .r2)i.r1'
  ${If} $1 == 0
    System::Call '*$2(&w${NSIS_MAX_STRLEN} .s)'
  ```
  `*$2(&w${NSIS_MAX_STRLEN} .s)` makes System.dll copy `NSIS_MAX_STRLEN` UTF-16 characters from the
  `CoTaskMemAlloc` block holding `C:\Users\<user>\AppData\Local\Programs`. The copy runs past the end of that block,
  and it faults only when the block sits close enough to the end of committed heap memory. The fault therefore depends
  on the heap layout, which explains why it is intermittent and why it appears on newer Windows heaps
  (24H2 / Server 2025).
- The upstream reports match ours exactly: same module, same 2018 System.dll, same offset `0x00001581`, same config:
  - electron-builder issue #8536, "NSIS Installer doesn't launch on Windows 11 when perUser is set by default"
    (`oneClick: false`, `perMachine: false`; System.dll 0xc0000005 at 0x1581; works with `oneClick: true` or
    per-machine): https://github.com/electron-userland/electron-builder/issues/8536
  - logseq/logseq#13524 (System.dll 0xc0000005 at 0x1581, time stamp 0x5c157efa, Windows 11 24H2/25H2) and its fix
    logseq/logseq#13525 (bump electron-builder):
    https://github.com/logseq/logseq/issues/13524, https://github.com/logseq/logseq/pull/13525
  - Upstream fixes: electron-builder#9564 (merged 2026-03-12) skipped the lookup on Windows 8+; electron-builder#9769,
    "fix(nsis): safely copy UserProgramFiles path" (merged 2026-05-27), replaced the fixed-width read with
    `KERNEL32::lstrcpynW(w .r0, p r2, i ${NSIS_MAX_STRLEN})`, which stops at the terminating NUL:
    https://github.com/electron-userland/electron-builder/pull/9564,
    https://github.com/electron-userland/electron-builder/pull/9769
  - Checked in the published packages: the `lstrcpynW` copy is absent from `app-builder-lib@26.11.1` and present
    from `app-builder-lib@26.12.0` (released 2026-05-29) on.
- Cause 1 does not hold: electron-builder 26.x still compiles with the same NSIS 3.0.4.1 by default
  (`toolsets.nsis` defaults to `"0.0.0"`, the legacy nsis-3.0.4.1 + nsis-resources-3.4.1). The fix is in the script
  template, not in a newer System.dll. Swapping the NSIS binary (`nsis.customNsisBinary`) would leave the over-read
  in place.
- The CPU link is a correlation, not a cause: both crashes that logged a CPU ran on AMD EPYC 7763 hosts, but the
  fault is a heap over-read whose outcome depends on memory layout, not on the instruction set.

A failing check on the old code: `tests/unit/packaging-nsis.test.ts` fails with app-builder-lib 25.1.8 (see
Resolution). The crash itself cannot be reproduced on demand (Linux dev container, intermittent on Windows). The
install check now runs several fresh install cycles per CI run to catch it (see Resolution).

---

## Resolution

| Field | Value |
|---|---|
| Closed by / date | |
| Fix | |
| Files changed | `package.json`, `package-lock.json`, `.github/workflows/windows.yml`, `scripts/windows/install-check.ps1` (new), `tests/unit/packaging-nsis.test.ts` (new) |
| Regression test | `tests/unit/packaging-nsis.test.ts` (template guard); `scripts/windows/install-check.ps1` in the Windows workflow (5 fresh install/uninstall cycles per run, plus 6 × 10 cycles in the manual `installer-stress` job) |

### Root cause

### Fix

### Before / after

### Regression test proof

### Tests run

### Changed existing assertions

### Compatibility risks

### Follow-ups
