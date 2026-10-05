# INSTALL.md says the nsis installer is "not built or tested" while its intro says CI builds and tests it

| Field | Value |
|---|---|
| Status | open |
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
| Verified by / date | |
| Verified on commit | |
| Verdict | |

---

## Resolution
<!-- Required before moving the file to bugs/closed/. -->

| Field | Value |
|---|---|
| Closed by / date | |
| Fix | |
| Files changed | |
| Regression test | |

### Root cause

### Fix

### Before / after

### Regression test proof

### Tests run

### Changed existing assertions

### Compatibility risks

### Follow-ups
