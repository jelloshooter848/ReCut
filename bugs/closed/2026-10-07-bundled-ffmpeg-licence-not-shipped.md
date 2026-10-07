# Windows releases ship a GPL FFmpeg build without its licence or source information, and ReCut has no LICENSE file

> Not legal advice. This report describes what the build ships and what the project's own docs say. Whoever works it
> should confirm the right remedy for the project.

| Field | Value |
|---|---|
| Status | fixed |
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

| Field | Value |
|---|---|
| Verified by / date | Claude (Claude Code session), 2026-10-07 |
| Verified on commit | a718aa9 (origin/main) |
| Verdict | confirmed |

Checked against a718aa9:

- `scripts/windows/get-ffmpeg.ps1` copied only `ffmpeg.exe` and `ffprobe.exe` out of the archive and deleted the rest
  in its `finally` block. Nothing else was written to `-Dest`, and the version reached only the console.
- `package.json` → `build.extraResources` had a single entry (`resources/ffmpeg`, `**/*`). The repository root had no
  `LICENSE`, `NOTICE` or third-party notices file, so nothing of ReCut's own licence was packaged either.
- `docs/INSTALL.md` said "GPL builds make the package GPL", while `package.json` says MIT. The two contradicted each
  other.
- Help › About showed only the version, the FFmpeg path and the cache folder. No licence was reachable from the app.

The suspected cause was right. Licence files were never part of the script's job, and the repository never had a
`LICENSE`. The installer itself was not unpacked, because the script and the packaging config are enough to show
what it contains.

---

## Resolution

| Field | Value |
|---|---|
| Closed by / date | Claude (Claude Code session), 2026-10-07 |
| Fix | branch `claude/licensing` (release 0.4.1) |
| Files changed | `LICENSE` (new), `THIRD_PARTY_NOTICES.md` (new), `scripts/third-party-notices.mjs` (new), `scripts/windows/get-ffmpeg.ps1`, `package.json` (`build.extraResources`), `electron/licences.ts` (new), `electron/ipc.ts`, `electron/preload.ts`, `electron/main.ts` (smoke line), `shared/ipc.ts`, `src/app/commands.ts` (About), `README.md`, `docs/INSTALL.md`, `docs/RELEASING.md`, `tests/unit/licences.test.ts` (new) |
| Regression test | `tests/unit/licences.test.ts` (7 tests) |

### Root cause

The bundling script was written only to get working binaries into the installer. It dropped the licence and readme
from the FFmpeg archive and recorded nothing about the build. The repository never received a `LICENSE` or a
notices file, so the packaging config had nothing to ship. The INSTALL note was written before the project settled
on MIT.

### Fix

Owner's decisions: ReCut stays MIT, the GPL FFmpeg builds stay (libx264 is needed for H.264 export), and the fix
applies to future releases. Published releases are left as they are and get release notes from the coordinator.

- **`LICENSE`**: MIT, "Copyright (c) 2026 ReCut contributors", matching `package.json` `license` and `author`.
- **`get-ffmpeg.ps1`** writes these files next to the executables in `-Dest`:
  - `FFMPEG-LICENSE.txt`: the archive's licence file, unchanged. The script looks first next to `bin\` (`LICENSE`
    for gyan.dev, `LICENSE.txt` for BtbN), then anywhere in the archive under those exact names.
  - `FFMPEG-README.txt`: the archive's `README.txt`, when it has one. gyan.dev's lists the libraries and their versions.
  - `FFMPEG-BUILD.txt`: the URL the build came from, the build name (the archive's top folder), the version, the
    licence (taken from `--enable-gpl` / `--enable-version3` in the configuration), the UTC date, where to get the
    corresponding source, and the full `ffmpeg -version` output.
  - Source links for gyan.dev builds: `https://ffmpeg.org/releases/ffmpeg-<version>.tar.xz` and the gyan.dev build page.
  - Source links for BtbN builds: the FFmpeg commit from the `-g<hash>` in the version string, as a commit link and
    a source archive, plus the BtbN release and build scripts, which pin every library's source revision.
  - A download without a licence file is rejected, and the script tries the next source.
  - The script removes stale `FFMPEG-*.txt` files before it writes new ones.
  - It still exits 0 or 1 as before, so `Start ReCut.cmd` / `start-recut.ps1` and the CI steps that call it are
    unchanged.
- **`THIRD_PARTY_NOTICES.md`** covers:
  - FFmpeg: GPL-3.0-or-later for these builds, with libx264 named. It says ReCut runs FFmpeg as a separate process,
    points to `FFMPEG-BUILD.txt` / `FFMPEG-LICENSE.txt` for the exact build and its source, and offers the source on
    request through the issue tracker as a fallback.
  - Electron and Chromium: `LICENSE.electron.txt` and `LICENSES.chromium.html`, which electron-builder already
    ships. It notes that Chromium's own LGPL `ffmpeg.dll` is separate from the GPL FFmpeg.
  - The npm runtime closure: the `dependencies` plus their dependencies and Electron, with version, licence, source
    and the full licence text. `node scripts/third-party-notices.mjs` generates this section from `node_modules`, and
    `--check` fails when the section is stale. No new npm dependencies.
- **Packaging**: `build.extraResources` copies `LICENSE` and `THIRD_PARTY_NOTICES.md` to `resources/`. The existing
  `resources/ffmpeg` entry (`**/*`) already carries the new `FFMPEG-*.txt` files.
- **App**: Help › About shows "ReCut is free software under the MIT License …" and a **Licences…** button. That
  opens a list of the licence files this build ships: ReCut licence, third-party notices, FFmpeg build and source,
  FFmpeg licence, FFmpeg readme, Electron licence and Chromium licences.
  - The renderer sends only an id (`app:licenceFiles`, `app:openLicenceFile`). Main maps it to a fixed file name in
    fixed folders (`electron/licences.ts`). Packaged builds look only in `process.resourcesPath` (and its `ffmpeg`
    folder) and in the executable's folder. Development builds also look in the repository root.
  - Main opens the file with `shell.openPath`. If no app is registered for the file type, it reveals the file in
    its folder instead.
  - The smoke test logs `smoke: licences shipped=… absent=…`.
- **Docs**:
  - README has a License section.
  - `docs/INSTALL.md` "Bundling FFmpeg" replaces "GPL builds make the package GPL". It now says that ReCut is MIT,
    that a bundled FFmpeg is GPL and distributed alongside ReCut, and what someone who bundles FFmpeg must include.
  - `docs/RELEASING.md` has a new section, "Licence files every release ships".

### Before / after

- Before: `resources/ffmpeg/` held `ffmpeg.exe` and `ffprobe.exe`. `resources/` held no licence of ReCut's. About
  showed no licence.
- After: `resources/LICENSE`, `resources/THIRD_PARTY_NOTICES.md`, and `resources/ffmpeg/` with `ffmpeg.exe`,
  `ffprobe.exe`, `FFMPEG-LICENSE.txt`, `FFMPEG-BUILD.txt` and, for gyan.dev builds, `FFMPEG-README.txt`.
  electron-builder still adds `LICENSE.electron.txt` and `LICENSES.chromium.html` next to the executable. About ›
  Licences opens each file.
- Linux check (`npm run package`, with dummy `FFMPEG-*.txt` files in the git-ignored `resources/ffmpeg/`): `release/linux-unpacked/resources/` contains `LICENSE`, `THIRD_PARTY_NOTICES.md` (byte-identical to the repository's), `app.asar`, `app-update.yml` and `ffmpeg/` with all three `FFMPEG-*.txt` files, so the existing `**/*` filter carries them; `LICENSE.electron.txt` and `LICENSES.chromium.html` are next to the executable.

### Regression test proof

`tests/unit/licences.test.ts` run against a718aa9 (the test copied into an export of that commit):

```
FAIL  tests/unit/licences.test.ts
Error: Failed to load url ../../electron/licences ... Does the file exist?
```

With only `electron/licences.ts` and `shared/ipc.ts` copied over as well, the repository checks still fail on the old
tree:

```
× LICENSE is MIT, as package.json says                       ENOENT ... /LICENSE
× electron-builder ships LICENSE, THIRD_PARTY_NOTICES.md and everything in resources/ffmpeg
    → expected [ { from: 'resources/ffmpeg', …(2) } ] to deeply equal ArrayContaining{…}
× get-ffmpeg.ps1 writes the licence, readme and build files ...  → expected '<#…' to contain '\'FFMPEG-LICENSE.txt\''
× THIRD_PARTY_NOTICES.md lists the current runtime npm packages  Cannot find module .../scripts/third-party-notices.mjs
Tests  4 failed | 3 passed (7)
```

On the fix, all 7 pass. The tests check:

- known ids resolve to their fixed files in a packaged layout;
- paths, file names, `__proto__`, non-strings and similar input resolve to nothing;
- a packaged build never reads the working directory;
- the packaging config, `LICENSE`, the script's file names and the generated notices section are present and current.

### Tests run

- `npm run typecheck`: clean.
- `npm test`: 63 files, 1188/1188 passed (includes the 7 new tests).
- `node scripts/third-party-notices.mjs --check`: up to date.
- `npm run package` (Linux, `electron-builder --dir`): succeeded; contents as listed under Before / after.
- Packaged smoke test (`RECUT_SMOKE=1 xvfb-run -a release/linux-unpacked/recut`): all checks passed, and it logged
  `smoke: licences shipped=LICENSE,THIRD_PARTY_NOTICES.md,FFMPEG-BUILD.txt,FFMPEG-LICENSE.txt,FFMPEG-README.txt,LICENSE.electron.txt,LICENSES.chromium.html absent=none`.
- Not run: the Windows CI (`get-ffmpeg.ps1` against the real archives, the Windows packaging and the installer). No PowerShell is available on this host, so the script was reviewed by hand for Windows PowerShell 5.1 and PowerShell 7 compatibility.

### Changed existing assertions

None.

### Compatibility risks

- `get-ffmpeg.ps1` now rejects an archive that has no licence file. If gyan.dev changed its layout, the script would
  fall back to BtbN, and it fails only if every source lacks a licence. It was parse-reviewed but not executed here
  (no PowerShell on the Linux host). The Windows CI run on this branch is the real check: the release build, the
  launcher and the Windows test jobs all call it.
- `THIRD_PARTY_NOTICES.md` must be regenerated when a runtime dependency changes. The unit test fails until it is.
- No effect on projects, exports or file formats.

### Follow-ups

- The published releases v0.2.0 to v0.4.0 and the `-dev` prereleases stay as they are. The coordinator adds the
  licence and source information to their release notes.
- Conservative option for the owner: attach the FFmpeg source tarball named in `FFMPEG-BUILD.txt` to each GitHub
  release, so the source does not depend on third-party links. This would be a change to
  `.github/workflows/windows.yml`, which is not part of this fix.
- CI could assert the smoke line (`smoke: licences shipped=` must include `LICENSE`, `THIRD_PARTY_NOTICES.md`,
  `FFMPEG-LICENSE.txt` and `FFMPEG-BUILD.txt`) in the installer job. That is also a `windows.yml` change.
- A future macOS or Linux bundle (ROADMAP §18, §19) needs the same `FFMPEG-*.txt` files next to its binaries
  (`docs/INSTALL.md`, "Bundling FFmpeg").
- macOS: the app menu's native "About" (`role: 'about'`) does not show the Licences button. macOS is not a verified
  target.
