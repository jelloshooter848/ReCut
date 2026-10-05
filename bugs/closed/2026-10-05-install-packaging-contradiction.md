# INSTALL.md says the nsis installer is "not built or tested" while its intro says CI builds and tests it

| Field | Value |
|---|---|
| Status | fixed |
| Severity | low (misleading documentation; no runtime effect) |
| Area | docs / packaging |
| Reported by / date | Claude (Claude Code session, working bugs/closed/2026-10-05-roadmap-revisions.md), 2026-10-05 |
| Found on commit | e89fc8b |
| Environment | n/a (documentation) |

## Report

### Summary

`docs/INSTALL.md` contradicts itself about the Windows installer. Readers cannot tell whether the nsis build is
verified.

### Steps to reproduce

1. Read `docs/INSTALL.md:3-5`: "Verified packaged builds: the **Windows installer and portable exe** (built, silently
   installed and smoke-tested on Windows by CI ...)".
2. Read `docs/INSTALL.md:90-92` under "Packaged builds": "**Not verified:** the `npm run dist` targets (AppImage, dmg,
   nsis). They are configured in `package.json` → `build` but have not been built or tested."

### Expected

One consistent statement. `.github/workflows/windows.yml` builds the installer and portable exe on `windows-latest`,
bundles FFmpeg, silently installs the installer and smoke-tests both, which matches the intro and
`docs/LIMITATIONS.md` ("Platform and packaging").

### Actual

The "Packaged builds" section still lists nsis as never built or tested. It may mean "`npm run dist` run locally on
Linux/macOS has not been verified for nsis", but it does not say so.

### Evidence

`docs/INSTALL.md:3-5`, `:19-20`, `:90-92`; `.github/workflows/windows.yml`.

### Suspected cause (hypothesis)

The Windows CI workflow and the intro were added later; the "Packaged builds" bullets were not updated.

### Scope

Only `docs/INSTALL.md`. `docs/LIMITATIONS.md` and `docs/ROADMAP.md` (as revised on 2026-10-05) already describe the
Windows builds as built, installed and smoke-tested in CI, unsigned.

---

## Verification
<!-- Filled in by whoever works the bug. -->

| Field | Value |
|---|---|
| Verified by / date | Claude (Claude Code session), 2026-10-05 |
| Verified on commit | db2ce17 (`origin/claude/roadmap-revisions`) |
| Verdict | confirmed, plus a second occurrence in `docs/DEVELOPMENT.md` |

- `docs/INSTALL.md:3-5` (intro) says the Windows installer and portable exe are built, silently installed and
  smoke-tested by CI. `:90-92` ("Packaged builds") says the `npm run dist` targets including nsis "have not been built
  or tested". The two contradict each other.
- `.github/workflows/windows.yml`, job `installer`: downloads FFmpeg into `resources/ffmpeg`
  (`scripts/windows/get-ffmpeg.ps1`), runs `npx electron-builder --win --x64` (the `package.json` → `build.win`
  targets: `nsis` and `portable`, x64), smoke-tests `release/win-unpacked/ReCut.exe` (requires `encode+probe ok`,
  `status=206` and the bundled `resources\ffmpeg`), silently installs `ReCut-Setup-*.exe` with `/S` and smoke-tests the
  installed `ReCut.exe`, then uploads and publishes both exes. Jobs `tests` and `e2e` run `npx vitest run` and the
  Playwright suite on `windows-latest`.
- Precision the intro lacked: the portable exe is built and published but never launched in CI; what is smoke-tested
  is the unpacked app it is made from and the installed app. `npm run dist` also builds a portable exe on Windows,
  which `:87` left out.
- CI evidence (`gh run list -R jelloshooter848/ReCut -w "Windows build"`): run 37358989047 (2026-10-05 18:50,
  `claude/build-recut`) succeeded on all four jobs, including "Installer + portable exe" and both test jobs. Run
  37355856757 (18:25, `main`) failed in "Silent-install the installer and smoke-test the installed app" while the
  unpacked smoke test passed; the next runs succeeded (see Follow-ups).
- The "By default a package does not include FFmpeg" sentence is right for a local `npm run package` / `npm run dist`
  (`extraResources` copies `resources/ffmpeg/` only when it exists) but did not say that the Windows CI builds do
  bundle it.
- Same stale claim elsewhere (`grep -n -i "not verified\|nsis\|AppImage\|portable\|untested" README.md docs/*.md`):
  `docs/DEVELOPMENT.md:60`, ``| `npm run dist` | ... (AppImage / dmg / nsis). Not verified. |``. `README.md:75-86`,
  `docs/LIMITATIONS.md:88-93` and `docs/ROADMAP.md:172-173` are already consistent with CI.

---

## Resolution
<!-- Required before moving the file to bugs/closed/. -->

| Field | Value |
|---|---|
| Closed by / date | Claude (Claude Code session), 2026-10-05 |
| Fix | branch `claude/quick-fixes`, the commit that moves this file to `bugs/closed/` |
| Files changed | `docs/INSTALL.md`, `docs/DEVELOPMENT.md` |
| Regression test | none (documentation only; see Regression test proof) |

### Root cause

The Windows CI workflow and the INSTALL.md intro were added after the "Packaged builds" bullets, which were not
updated; `docs/DEVELOPMENT.md`'s command table had the same stale "Not verified".

### Fix

`docs/INSTALL.md`:
- Intro: says exactly what CI does (builds the installer and portable exe with FFmpeg bundled, smoke-tests the
  unpacked app, silently installs the installer and smoke-tests the installed app, runs the unit and e2e suites on
  Windows), that the Linux unpacked build is verified locally, that dmg and AppImage are untested, and that nothing is
  code-signed.
- "Packaged builds": `npm run dist` comment lists the portable exe; bullets now read **Verified on Windows, in CI**
  (nsis installer + portable exe, unsigned, with the portable exe noted as not launched in CI), **Verified on Linux,
  locally** (`npm run package`), **Not verified** (macOS dmg, Linux AppImage; no signing or notarisation).
- FFmpeg sentence: a package you build yourself has no FFmpeg unless `resources/ffmpeg/` exists when you build it
  (`Start ReCut.cmd` may have put it there on Windows); the Windows CI builds are the only published builds that
  bundle it.

`docs/DEVELOPMENT.md:60`: the `npm run dist` row now says the Windows nsis installer and portable exe are built in CI
by `.github/workflows/windows.yml`, which smoke-tests the unpacked app and a silent install (unsigned, FFmpeg
bundled), and that dmg and AppImage are untested.

### Before / after

Before: INSTALL.md said both "verified ... smoke-tested on Windows by CI" and "nsis ... not been built or tested";
DEVELOPMENT.md said `npm run dist` is "Not verified". After: both files say Windows nsis + portable are verified in CI
(unsigned), Linux unpacked is verified locally, macOS dmg and Linux AppImage are configured but untested, and FFmpeg is
bundled only in the Windows CI builds. This matches `docs/LIMITATIONS.md` ("Platform and packaging") and
`docs/ROADMAP.md`.

### Regression test proof

No regression test: documentation only, with no runtime effect. Evidence instead: the workflow steps and CI runs
listed under Verification, and after the edit
`grep -n -i "not verified\|not been built" README.md docs/*.md` (excluding `docs/attack/`) returns only
`docs/INSTALL.md`'s "**Not verified:** the macOS dmg and the Linux AppImage", which is accurate.

### Tests run

Run with the fix for `bugs/closed/2026-10-05-export-perf-inputcount-stale.md` on the same branch: `npm run typecheck`
clean; `npm test` 957/958 (the one failure, `tests/unit/media-move-cache.test.ts:77`, is unrelated to these docs; see
that report's Tests run).

### Changed existing assertions

None.

### Compatibility risks

None (documentation). `.github/workflows/windows.yml` ignores `docs/**` and `**/*.md`, so this change does not
trigger a Windows build.

### Follow-ups

- Run 37355856757 (`main`, 2026-10-05 18:25) failed at the silent install / installed-app smoke test while the
  unpacked smoke test passed; runs before and after succeeded. The workflow already logs the faulting module for this
  case ("CI: log the faulting module and CPU when the silent install fails"). Not investigated here; worth a report if
  it recurs.
- The portable exe is never launched in CI. A smoke step for `ReCut-Portable-*.exe` would close the gap between "built"
  and "tested" for it.
