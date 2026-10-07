# Windows releases ship a GPL FFmpeg build without its licence or source information, and ReCut has no LICENSE file

> Not legal advice. This report describes what the build ships and what the project's own docs say. Whoever works it
> should confirm the right remedy for the project.

| Field | Value |
|---|---|
| Status | open |
| Severity | medium (no runtime effect; a distribution-compliance gap in every published Windows release: v0.2.0, v0.2.1, v0.2.2, v0.3.0, and the `-dev` prereleases) |
| Area | packaging · licensing |
| Reported by / date | Claude (Claude Code session), from a 1.0-readiness review at the project owner's request, 2026-10-07 |
| Found on commit | 31c9fb9 |
| Environment | n/a (build scripts and repository contents; the Windows installer itself was not unpacked) |

## Report

### Summary

The Windows installer and portable exe bundle FFmpeg. `scripts/windows/get-ffmpeg.ps1` downloads a **GPL** build:
gyan.dev "release essentials", or a BtbN `win64-gpl` build as a fallback. It extracts the archive, copies only
`ffmpeg.exe` and `ffprobe.exe` into `resources/ffmpeg`, and deletes the rest of the archive. Everything in
`resources/ffmpeg` is packaged (`package.json` → `build.extraResources`, filter `**/*`). So the releases contain
FFmpeg binaries with:

- no FFmpeg licence text;
- no statement of which build and version were bundled (the script prints the version to the CI log only);
- no source offer or link to the corresponding source.

Separately, ReCut itself has no `LICENSE` file, although `package.json` declares `"license": "MIT"`. The repository
also gives two different answers on what the package's licence is. `package.json` says MIT, while
`docs/INSTALL.md:115-116` says "Check the licence (GPL builds make the package GPL)".

Redistributing GPL binaries normally requires shipping the licence text and making the corresponding source
available for the exact build distributed.

### Steps to reproduce

1. Read `scripts/windows/get-ffmpeg.ps1`. Lines 11–13 list the sources (all GPL). Lines 26–29 copy only the two
   executables. Lines 35–37 delete the downloaded archive and the extracted tree.
2. Read `package.json` → `build.extraResources` (from `resources/ffmpeg`, filter `**/*`).
3. Read `.github/workflows/windows.yml:201`: the release build runs `get-ffmpeg.ps1 -Dest resources/ffmpeg`.
4. `git ls-tree --name-only HEAD`: no `LICENSE`, `NOTICE` or third-party notices file.
5. Search `src`, `electron`, `docs` and `README.md` for an FFmpeg licence mention: none in the app or user docs. The
   only one is the `docs/INSTALL.md` note for people bundling FFmpeg themselves.

### Expected

Each release that bundles FFmpeg ships the following:

- FFmpeg's licence text, plus the third-party licences that come with the build (for example libx264's);
- which FFmpeg build and version are bundled, and where to get its corresponding source;
- ReCut's own `LICENSE`;
- a third-party notices file, ideally reachable from the app (for example Help › About / Licences).

The repository states one consistent licensing position for the distributed package.

### Actual

Only `ffmpeg.exe` and `ffprobe.exe` are shipped. There are no licence files, no build or version record, and no
source information. ReCut has no `LICENSE` file, and `package.json` and `docs/INSTALL.md` disagree about the
package's licence.

### Evidence

- `scripts/windows/get-ffmpeg.ps1:9-13` (sources, all GPL), `:26-29` (copies only the two exes), `:35-37` (deletes
  the rest).
- `package.json:8` (`"license": "MIT"`), `package.json:51-57` (`extraResources`).
- `docs/INSTALL.md:21` (releases bundle gyan.dev essentials, BtbN as fallback), `:115-116` ("GPL builds make the
  package GPL").
- Published release tags: `v0.2.0`, `v0.2.1`, `v0.2.2`, `v0.3.0`.

### Suspected cause (hypothesis)

The bundling script was written to get working binaries into the installer. Licence files were never part of its
contract, and the repository never received a `LICENSE` file.

### Scope

- Possible remedies, for whoever works this:
  - keep the archive's licence and readme files next to the binaries in `resources/ffmpeg`;
  - record the source URL, build name and version in a file written by `get-ffmpeg.ps1`;
  - add `LICENSE` and a `THIRD_PARTY_NOTICES` file;
  - decide and document whether to stay with GPL builds or switch to LGPL builds (which drop libx264, so H.264
    export would need another encoder);
  - reconcile `package.json` with `docs/INSTALL.md`.
- `Start ReCut.cmd` uses the same script, but there the user downloads FFmpeg for themselves rather than ReCut
  redistributing it.
- A future macOS or Linux bundle (ROADMAP §18, §19) needs the same treatment.
- Already-published releases stay as they are. The owner may want to decide whether to republish them or add the
  missing information to their release notes.

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
