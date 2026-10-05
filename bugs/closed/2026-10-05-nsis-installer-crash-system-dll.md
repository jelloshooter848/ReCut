# Windows installer crashes in NSIS System.dll (0xc0000005) before installing anything

| Field | Value |
|---|---|
| Status | fixed |
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
  fault is a heap over-read whose outcome depends on memory layout, not on the instruction set. The baseline run
  in "Before / after" crashed on Intel hosts too.

`tests/unit/packaging-nsis.test.ts` fails on the old code (app-builder-lib 25.1.8; see Resolution). The crash
also reproduces on demand in Windows CI: the published v0.2.0 installer crashed in 23 of 60 fresh silent installs
with the same event (run 37384794611, see Resolution › Before / after), on Intel Xeon Platinum 8573C hosts as well
as AMD EPYC 7763.

---

## Resolution

| Field | Value |
|---|---|
| Closed by / date | Claude (agent), 2026-10-05 |
| Fix | branch `claude/nsis-crash`: ef35035 (fix), 7af307b and 497a149 (install-check script fixes) |
| Files changed | `package.json`, `package-lock.json`, `.github/workflows/windows.yml`, `scripts/windows/install-check.ps1` (new), `tests/unit/packaging-nsis.test.ts` (new) |
| Regression test | `tests/unit/packaging-nsis.test.ts` › "NSIS installer template (electron-builder)" (2 tests); `scripts/windows/install-check.ps1`, run by the Windows workflow's installer job (5 fresh install / uninstall cycles + portable launch on every build) and by the manual `installer-stress` job (6 runners × 10 cycles) |

### Root cause
electron-builder's NSIS template `multiUser.nsh` (in app-builder-lib up to 26.11.x) looks up the per-user install
root with `SHGetKnownFolderPath(FOLDERID_UserProgramFiles)`. It then copies the result with
`System::Call '*$2(&w${NSIS_MAX_STRLEN} .s)'`, a fixed-width read of `NSIS_MAX_STRLEN` UTF-16 characters from a heap
string about 45 characters long. The NSIS System plugin performs that copy, so the access violation lands in
System.dll at offset 0x1581 whenever the string's heap block sits near the end of committed memory. The code runs
on every fresh per-user install, which is our configuration (`oneClick: false`, `perMachine: false`). NSIS 3.04 and
the CPU are not the cause: the fault reproduced on Intel hosts too (see "Before / after").

### Fix
- `devDependencies.electron-builder`: `^25.1.8` → `^26.15.3` (npm `latest` tag; app-builder-lib 26.15.3). The
  lockfile was regenerated with `npm install -D electron-builder@26.15.3`. Only electron-builder's own dependency tree
  changed (app-builder-lib, builder-util, dmg-builder, electron-publish, @electron/rebuild 4, node-gyp 12, tar 7, …).
  No other top-level package changed version, and package.json `version` is still 0.2.0. app-builder-lib ≥ 26.12.0
  contains electron-builder#9769, which copies the path with `KERNEL32::lstrcpynW` (bounded, stops at NUL).
- No change to the `build` config was needed. The 26.0 breaking changes cover signing options moving to
  `win.signtoolOptions`, notarization options, and the Linux `.desktop` format, none of which we use. Locally
  `npm run build` passes, and `electron-builder --win --x64` reads the config and builds win-unpacked; the NSIS step
  then needs wine, which this Linux container lacks. CI builds both targets on Windows.
- The NSIS binary stays at nsis-3.0.4.1, still electron-builder's default. Opting into the beta NSIS 3.12 toolset
  (`toolsets.nsis: "1.2.1"`) or `nsis.customNsisBinary` would not have fixed this bug and adds risk, so I left them
  out (see Follow-ups).
- This is the smallest correct fix. The bug lives in electron-builder's template. Patching the template locally
  (custom `include` scripts cannot replace `setInstallModePerUser`) or switching to `oneClick` / per-machine installs
  would change user-visible installer behaviour.

### Before / after
The install check (`scripts/windows/install-check.ps1`) performs fresh silent per-user installs. The uninstall after
each attempt removes `HKCU\Software\<guid>\InstallLocation`, so every attempt runs the faulty lookup again. CPU per
runner comes from `Win32_Processor`. All runners are `windows-latest`, Windows Server 2025 build 26100.

Before: the published v0.2.0 installer (electron-builder 25.1.8), same check, run 37384794611 on branch
`claude/nsis-crash-baseline` (experiment only, not for merge): **23 crashes in 60 attempts (38 %)**. Every crash
exited -1073741819 with event 1000 `System.dll` 0xc0000005 at offset `0x00001581`. Every runner crashed at least
once:

| Runner (job) | CPU | Crashes / attempts |
|---|---|---|
| 1 (112015307660) | Intel Xeon Platinum 8573C | 2 / 10 |
| 2 (112015307511) | AMD EPYC 7763 | 3 / 10 |
| 3 (112015307606) | AMD EPYC 7763 | 5 / 10 |
| 4 (112015307562) | AMD EPYC 7763 | 8 / 10 |
| 5 (112015307265) | Intel Xeon Platinum 8573C | 3 / 10 |
| 6 (112015307553) | AMD EPYC 7763 | 2 / 10 |

After: installers built from 497a149 (electron-builder 26.15.3), runs 37384086002 (#39) and 37384754413 (#40)
(workflow_dispatch with `installer_stress: true`): **0 crashes in 130 attempts**. Every attempt exited 0, installed
`ReCut.exe`, and uninstalled cleanly. The first attempt on each runner also passed the installed-app smoke test, and
the portable exe passed its smoke test on all 14 runners.

| Run | Job | CPU | Passed / attempts |
|---|---|---|---|
| #39 | installer | AMD EPYC 9V45 | 5 / 5 |
| #39 | stress 1 | AMD EPYC 9V45 | 10 / 10 |
| #39 | stress 2 | AMD EPYC 7763 | 10 / 10 |
| #39 | stress 3 | Intel Xeon Platinum 8573C | 10 / 10 |
| #39 | stress 4 | AMD EPYC 9V74 | 10 / 10 |
| #39 | stress 5 | AMD EPYC 7763 | 10 / 10 |
| #39 | stress 6 | AMD EPYC 7763 | 10 / 10 |
| #40 | installer | AMD EPYC 7763 | 5 / 5 |
| #40 | stress 1 | AMD EPYC 7763 | 10 / 10 |
| #40 | stress 2 | AMD EPYC 9V74 | 10 / 10 |
| #40 | stress 3 | AMD EPYC 9V45 | 10 / 10 |
| #40 | stress 4 | AMD EPYC 7763 | 10 / 10 |
| #40 | stress 5 | AMD EPYC 9V74 | 10 / 10 |
| #40 | stress 6 | AMD EPYC 7763 | 10 / 10 |

By CPU after the fix: AMD EPYC 7763 65/65, AMD EPYC 9V74 30/30, AMD EPYC 9V45 25/25, Intel Xeon Platinum 8573C
10/10. At the baseline crash rate (38 % per attempt), 130 clean attempts in a row would happen by chance with
probability 0.62^130 ≈ 10^-27. Earlier runs #37 (AMD EPYC 7763) and #38 (Intel Xeon 6973P-C) also exited 0 on their
first fresh install. Those runs failed only because the first version of the check searched for the installed exe
with a recursive `Get-ChildItem -Filter`, which came back empty although #38's diagnostics listed `ReCut.exe` in the
install folder. 497a149 checks the recorded `InstallLocation` with `Test-Path` instead.

### Regression test proof
`tests/unit/packaging-nsis.test.ts` with app-builder-lib 25.1.8 installed (the old lockfile's node_modules):
```
 × NSIS installer template (electron-builder) > per-user install dir lookup does not read a fixed NSIS_MAX_STRLEN string from the SHGetKnownFolderPath buffer
   → app-builder-lib 25.1.8 multiUser.nsh: expected [ Array(1) ] to deeply equal []
+   "        System::Call '*$2(&w${NSIS_MAX_STRLEN} .s)'",
 × NSIS installer template (electron-builder) > no NSIS template reads a fixed NSIS_MAX_STRLEN string from a raw pointer
+   "multiUser.nsh: System::Call '*$2(&w${NSIS_MAX_STRLEN} .s)'",
 Tests  2 failed (2)
```
With app-builder-lib 26.15.3: `✓ tests/unit/packaging-nsis.test.ts (2 tests)`. The on-Windows proof is the
before/after table above: the same install check fails on the old installer and passes on the new one.

### Tests run
- `npm run typecheck`: clean.
- `npm test`: 44 files, 978/978 passed (976 before, plus the 2 new tests).
- Windows CI on 497a149, runs #39 and #40: installer job (build, unpacked smoke, install check), unit tests on
  Windows, e2e on Windows and the `Start ReCut.cmd` launcher all passed, and `installer-stress` 12/12 jobs passed.
- Not run locally: the Windows NSIS build (needs wine on Linux) and the e2e suite (covered by Windows CI).

### Changed existing assertions
None. The workflow's install step became `scripts/windows/install-check.ps1`, which keeps every old check
(installer exit, installed exe, installed-app smoke test, CPU and event-1000 / NSIS-temp diagnostics on failure) and
adds the repeat cycles, uninstall verification and a portable-exe smoke test. The `ReCut-windows` artifact is now
uploaded before the install check, so a failed install can still be downloaded. The Release is still published only
after the check passes.

### Compatibility risks
- Installer behaviour changes that come with electron-builder 26 templates: the "app running" check uses PowerShell
  (`Get-CimInstance`) with a tasklist fallback; file-association uninstall removes our `OpenWithProgids` entry
  instead of restoring a backed-up default; the `/D=` install-dir switch is parsed differently (supports spaces).
  The install path (`%LOCALAPPDATA%\Programs\ReCut`), registry keys (same GUID `71b5ac76-…`, derived from the appId with the same namespace in both versions), shortcuts and artifact
  names are unchanged, so 0.2.0 installs upgrade in place.
- Projects, exports, frame rates and subtitles: not affected (build tooling only).
- Dependency change (CLAUDE.md): electron-builder devDependency ^25.1.8 → ^26.15.3 and its transitive tree in
  package-lock.json. No runtime dependency changed.

### Follow-ups
- The installers still embed NSIS 3.04 (2018). NSIS < 3.11 has CVE-2025-43715, a local privilege escalation through
  the `$PLUGINSDIR` temp dir when an installer runs as SYSTEM. Our per-user installer does not normally run as
  SYSTEM. electron-builder's opt-in NSIS 3.12 toolset (`toolsets.nsis: "1.2.1"`) is marked beta in 26.15.3, so moving
  to it should be its own change with its own install-check runs. Not filed as a separate report yet: the lead should
  decide whether it warrants one.
- The installer exe is not code-signed (unchanged, already noted in the release text).
