# Versioning and releases

## Version numbers

ReCut uses [semantic versioning](https://semver.org/). Before 1.0 the version is `0.MINOR.PATCH`:

| Part | Bump when a release contains |
|---|---|
| MINOR (`0.2.0` → `0.3.0`) | A roadmap milestone, a user-visible feature, or a behaviour change users will notice. Reset PATCH to 0. |
| PATCH (`0.2.0` → `0.2.1`) | Bug fixes only. |
| `1.0.0` | The owner's call, when every item under **Ready for 1.0** in [ROADMAP → Road to 1.0](ROADMAP.md#road-to-10) holds. Release candidates (`1.0.0-rc.1`, `rc.2`, …) come first, published as GitHub pre-releases: see [Release candidates](#release-candidates). |

The version lives in `package.json` (and `package-lock.json`). The app reads it from there through Electron's
`app.getVersion()` (Preferences › Version and Help › About), the release file names use it
(`ReCut-Setup-<version>.exe`, `ReCut-<version>-linux-x86_64.AppImage`, `ReCut-<version>-macos-arm64.dmg`), and CI names releases after it. Do not write the version anywhere else.

**The project file format is versioned separately.** `formatVersion` in `.recut` files (`PROJECT_FORMAT_VERSION` in
`shared/model.ts`, read and migrated in `shared/project.ts`) changes only when the file format changes, never because
the app version changed. A format change is a MINOR bump at least, and the changelog says so.

### Exceptions

- **0.8.1** (owner's decision, 9 October 2026): shipped as a PATCH although it includes the nested-sequence size
  limit of PR #94 (a **Changed** item), because 0.8.0 had been out for one day and the Whisper download fix (#102)
  had to ship.

## Who changes the version

Only a **release-prep PR** into `rc` (for a [pre-release](#pre-releases-from-rc) or the
[final release](#final-release-rc--main)) or a [hotfix](#hotfixes) changes the version. Feature and bug PRs, and the
promotion PRs that bring them to `rc`, never touch `package.json` `version`, `package-lock.json` versions or
`CHANGELOG.md` release headings. A release-prep PR contains only:

1. The version bump: `npm version <x.y.z>-rc.<N> --no-git-tag-version` for a candidate, `npm version <x.y.z>
   --no-git-tag-version` for the final release (updates `package.json` and `package-lock.json`).
2. A new dated section at the top of `CHANGELOG.md`, `## [x.y.z-rc.N] - YYYY-MM-DD` or `## [x.y.z] - YYYY-MM-DD`,
   written from the changelog draft in [NEXT-RELEASE.md](NEXT-RELEASE.md), and the entries it used removed from that
   file (on `rc` that leaves its [empty template](#the-empty-next-releasemd)).
3. Doc lines that name the current version, if any (prefer wording that does not name a version).
4. The saved-project fixture of the new version, `tests/fixtures/projects/recut-<x.y.z>.recut`, made with
   `node scripts/make-project-fixture.mjs` after the bump (see [the fixtures' README](../tests/fixtures/projects/README.md)).
   A release candidate has none ([Release candidates](#release-candidates)).
5. [LIMITATIONS](LIMITATIONS.md) brought up to date for what the release ships, if it changed.

## Branches and roles

Code moves `dev` → `rc` → `main` (owner's decision, 12–13 October 2026):

| Branch | What it holds | PRs into it come from | Who merges | What a push to it publishes |
|---|---|---|---|---|
| `dev` | The integration branch: everything finished and reviewed. | Contributors, James and agents (task branches, `devDavid`, `devJames`). | James (write access) or the owner. | Nothing: always a [test build](#test-builds). |
| `rc` | The next release: the changes promoted from `dev`, and its release-prep PRs. It was created from `main` at 0.8.2. | [Promotion PRs](#promoting-dev-to-rc-cut--pick), release-prep PRs, `main` merged back. | The owner only. | A **pre-release** when `package.json` has a release-candidate version `X.Y.Z-rc.N` (N from 1) with its changelog section and no tag yet. With a stable version (the normal state just before `rc` → `main`) a test build. |
| `main` | Released code only. | The `rc` → `main` PR of a final release, and [hotfix](#hotfixes) PRs. | The owner only. | The **stable release** when `package.json` has a stable version `X.Y.Z` with its changelog section and no tag yet. With a pre-release version a test build, with a warning. |
| `devDavid`, `devJames`, task branches | Work in progress ([CONTRIBUTING › Branches and pull requests](../CONTRIBUTING.md#branches-and-pull-requests)). | Task branches. | Their owner. | Nothing (their pushes do not run CI; their PRs make test builds). |

Nobody pushes to `rc` or `main` directly: every change reaches them through a pull request the owner merges. Agents
never push to `rc` or `main`, and open PRs into `rc` only when the coordinator asks, as `-x` cherry-picks or a merge
of `dev` ([Promoting dev to rc](#promoting-dev-to-rc-cut--pick)). Pull requests into `main`, `rc`, `dev`, `devDavid`
and `devJames` run CI as test builds; only a push to `main` or `rc` (or the
[tag-push fallback](#fallback-pushing-the-tag-yourself)) can publish.

## How to cut a release

Releases are published automatically by CI. Nobody pushes a tag or creates a release by hand: agents cannot push tags
(their git proxy drops tag pushes), and the owner works in the GitHub web UI. A release goes `dev` → `rc` → `main`:

1. **Promote** what the release ships from `dev` to `rc`, in one or more promotion PRs into `rc`
   ([Promoting dev to rc](#promoting-dev-to-rc-cut--pick)). On request, the coordinator first writes a
   [review of dev for rc](#review-dev-for-rc-report-format) that ends with a promotion plan.
2. **Pre-release** candidates `X.Y.Z-rc.1`, `rc.2`, … from `rc` ([Pre-releases from rc](#pre-releases-from-rc)). Fixes
   go into `dev` first and are picked into `rc`, then the next candidate.
3. **Final release:** a release-prep PR into `rc` sets `X.Y.Z`, then the `rc` → `main` PR publishes it
   ([Final release](#final-release-rc--main)).
4. **Merge `main` back** into `rc` and `dev` ([After a release](#after-a-release-merge-main-back)).

A fix for a published release that cannot wait takes the [hotfix](#hotfixes) path from `main` instead.

**Only real versions appear on the Releases page** (owner's decision, 7 October 2026). CI never publishes a dev
prerelease and never creates a `-dev.` tag; every run that is not a release is a test build whose installers are only
the run's `ReCut-windows` artifact (its AppImage the `ReCut-linux` artifact, its dmgs the `ReCut-macos-arm64` and
`ReCut-macos-x64` artifacts). The one kind of pre-release on the Releases page is a
[release candidate](#release-candidates): a real version with its own release-prep PR, published from `rc`.

**Never create the release or the tag by hand before the release is merged** (into `main`, or for a candidate into
`rc`), not in the web UI ("Draft a new release" / "Choose a tag") and not with git. A tag made that way points at
whatever commit was selected (twice so far, a release was created on the wrong target this way). If the `v<version>`
tag exists when the release is merged, CI treats the version as already released and only makes a test build.

Details:

- Only pushes to `main` (stable versions) and to `rc` (release candidates) release automatically. A push to `main`
  with a pre-release version is a test build with a warning; a push to `rc` with a stable version, or with a
  pre-release that is not `X.Y.Z-rc.N`, is a test build. Pushes to `dev`, pull requests (into `main`, `rc`, `dev`,
  `devDavid` or `devJames`) and manual runs (*Run workflow*, `workflow_dispatch`) always make test builds, which
  publish nothing: the release decision and the `publish` job both require a push to `main` or `rc` with the right
  kind of version, or of a `v` tag.
- A push to `main` or `rc` that changes only `*.md` or `docs/**` files does not run the workflow, so it cannot
  release. A release-prep PR always changes `package.json`, so its merge always runs, and so does an `rc` → `main`
  merge.
- Runs on `main` and `rc` (and on tags, `dev` and manual runs) queue instead of cancelling each other; only a pull
  request's run is cancelled by a newer push to that pull request. So a release run is never cancelled by a quick
  follow-up merge, and the next run sees the tag the release run created. If a merge lands while an earlier run of
  the same branch is still going, GitHub keeps only the newest waiting run: a release run that had not started yet
  can be replaced by the next merge's run, which then publishes the release from that newer commit (the version is
  still untagged).
- Just before publishing, a release run checks the tag again. If `vX.Y.Z` appeared during the build (someone tagged or
  released by hand), the version is already released: the publish job logs a warning, publishes nothing, leaves that
  release alone and finishes successfully. The run's installers are still in its `ReCut-windows` artifact, its
  AppImage in `ReCut-linux` and its dmgs in `ReCut-macos-arm64` and `ReCut-macos-x64`.
- The tag is created by the workflow's `GITHUB_TOKEN`, and GitHub does not start workflows for events caused by
  `GITHUB_TOKEN`, so the new tag does not start a second build.

### Promoting dev to rc (cut / pick)

Changes reach `rc` only from `dev`, never straight from a task or personal branch, through PRs into `rc` that the owner
merges. A promotion PR never changes the version or `CHANGELOG.md` release headings (the release-prep PR does). There
are two kinds:

- **Cut:** everything on `dev` up to a chosen commit.

  ```bash
  git fetch origin
  git switch -c claude/promote-<topic> origin/rc
  git merge <dev commit>                      # a commit on origin/dev
  ```

- **Pick:** only chosen `dev` PRs. Cherry-pick each PR's merge commit into `dev`, in `dev` order (oldest first):

  ```bash
  git fetch origin
  git switch -c claude/promote-<topic> origin/rc
  git cherry-pick -x -m 1 <merge sha>         # once per PR, oldest first
  ```

  `-m 1` takes the PR's changes as `dev` received them, and `-x` adds `(cherry picked from commit <merge sha>)` to the
  message, which is how a later review tells that the PR is already in `rc`. A PR that builds on an earlier `dev` PR
  needs that one picked first (the [review](#review-dev-for-rc-report-format) lists the dependencies).

Push the branch and open the PR into `rc`; say what it promotes (the `dev` commit, or the PRs by number) and how any
conflict was resolved (in favour of what `dev` has). Its CI run is a test build; the owner merges it once it is green.

### Pre-releases from rc

1. **Release-prep PR into `rc`**, once what the candidate ships is on `rc`: branch `claude/release-X.Y.Z-rc.N` from
   `rc`, run `npm version X.Y.Z-rc.N --no-git-tag-version`, and add `## [X.Y.Z-rc.N] - YYYY-MM-DD` at the top of
   `CHANGELOG.md`, listing the changes since the previous candidate (for `rc.1`: since the last stable release; see
   [What goes in the changelog](#what-goes-in-the-changelog)). No saved-project fixture, and no roadmap **Status** or
   Progress change (they name stable releases). Run `npm run typecheck` and `npm test`, then open the PR against `rc`.
2. **The owner merges it.** The merge is a push to `rc`, so `.github/workflows/windows.yml` runs. Its first step sees
   a release-candidate version (`X.Y.Z-rc.N`, N from 1) that has its changelog section and no tag yet, and makes the
   run a release. After the same seven gates as a stable release ([What gates a release](#what-gates-a-release)) the
   publish job publishes `ReCut X.Y.Z-rc.N` on tag `vX.Y.Z-rc.N` (on the merge commit), marked **Pre-release** and
   never Latest, with the same five files, its dmgs signed and notarized ([Release candidates](#release-candidates)).
3. Check the release page: the **Pre-release** label is shown, **Latest** is still on the last stable release, the
   notes start with the release-candidate line, and both `.exe` files, the `.AppImage` and both `.dmg` files are
   attached.
4. **QA the candidate** with the QA checklist in [NEXT-RELEASE.md](NEXT-RELEASE.md). A fix goes into `dev` first, in
   a normal PR, and is then picked into `rc` (a promotion PR); the fixes are released as the next candidate,
   `rc.N+1`, with its own release-prep PR. A published candidate is never changed: its tag and release are final.

Later pushes to `rc` (promotions of fixes) find `vX.Y.Z-rc.N` already tagged and make test builds until the next
release-prep PR is merged.

### Final release (rc → main)

1. **Release-prep PR into `rc`**, once the last candidate has passed QA: branch `claude/release-X.Y.Z` from `rc`, run
   `npm version X.Y.Z --no-git-tag-version` and add the full `## [X.Y.Z] - YYYY-MM-DD` section at the top of
   `CHANGELOG.md`, written for people coming from the last stable release (everything since then, the candidates'
   changes included; the `## [X.Y.Z-rc.N]` sections stay below it unchanged, as history). Update
   [LIMITATIONS](LIMITATIONS.md) if what it lists changed. Check `docs/ROADMAP.md`: every roadmap entry this release
   ships has its **Status** line and its row in the Progress table marked done with this version (the feature PR sets
   them; the release-prep PR fixes any that are missing or still name an older version). Add the version's
   saved-project fixture: `node scripts/make-project-fixture.mjs` writes `tests/fixtures/projects/recut-X.Y.Z.recut`
   with this checkout's own code (the unit suite fails while the fixture of a stable version in `package.json` is
   missing). Never edit or regenerate an older fixture. Run `npm run typecheck` and `npm test`, then open the PR
   against `rc`. Its merge is a push to `rc` with a stable version: a test build, which publishes nothing.
2. **Release merge: one PR from `rc` into `main`.** Open it once the release-prep PR is merged and the `rc` push run of
   that merge is green. It contains nothing but `rc`'s commits since the last release. Merging it is the release step.
   Don't merge anything else into `rc` between the two, or it ships too.
3. **CI publishes.** The merge is a push to `main`, so `.github/workflows/windows.yml` runs. Its first step sees that
   the `package.json` version (for example `0.3.0`) is stable, has a `## [0.3.0]` section in `CHANGELOG.md` and that
   no tag `v0.3.0` exists yet, and makes this run a release. It then builds, smoke-tests the unpacked app, installs and
   uninstalls the installer and launches the portable exe, while the Windows unit tests, end-to-end tests and launcher
   check, the Linux job (unit and end-to-end tests, AppImage build and AppImage smoke test) and the macOS jobs (unit
   tests, the Apple Silicon and Intel dmgs, signed and notarized, with their smoke tests, and the end-to-end tests)
   run in parallel. Only when all of them have passed does the final `publish` job publish the release: tag `v0.3.0`
   on the merge commit (created by the publish job), name `ReCut 0.3.0`, not a prerelease, marked **Latest**, body =
   that version's changelog section plus the install / SmartScreen / AppImage / dmg note, with the installer, the
   portable exe, the AppImage and both dmgs attached. See [What gates a release](#what-gates-a-release).
4. Check the release page: both `.exe` files, the `.AppImage` and both `.dmg` files are attached and the notes read
   correctly. In the installer, linux and macos jobs' logs, the smoke tests list the licence files the builds ship
   (see [Licence files every release ships](#licence-files-every-release-ships)).
5. [Merge `main` back](#after-a-release-merge-main-back) into `rc` and `dev`.

Every later push to `main` finds `v0.3.0` already tagged and makes a [test build](#test-builds) (all gates, installers
kept as a CI artifact, nothing published) until the next release is merged into `main`.

### After a release (merge main back)

After a stable release or a [hotfix](#hotfixes), merge `main` back into the other two branches, so they have the
release's version, changelog section and fixture (and a hotfix's fix), and the next release does not undo them:

1. **`main` into `rc`:** branch `claude/merge-main-X.Y.Z` from `rc`, `git merge origin/main`, PR into `rc`. The owner
   merges it. Its push run is a test build (`rc` now has a stable version).
2. **`main` into `dev`:** branch `claude/merge-main-X.Y.Z-dev` from `dev`, `git merge origin/main`, PR into `dev`. In
   [NEXT-RELEASE.md](NEXT-RELEASE.md) keep the entries of `dev` changes that were not released and drop the ones the
   release shipped.

Merge, never rebase: the merge commits are what let later cuts and picks apply cleanly.

### Hotfixes

A fix that cannot wait for the next release (a published release is broken) goes straight to `main`:

1. Branch from `main` (for example `claude/hotfix-0.3.1`). Make the fix with its regression test, and make it a
   release in the same branch: bump to the next PATCH version (`npm version 0.3.1 --no-git-tag-version`), add the
   `## [0.3.1] - YYYY-MM-DD` section to `CHANGELOG.md` and the version's saved-project fixture, as in a release-prep
   PR. Run `npm run typecheck` and `npm test`.
2. Open the PR against `main`. Hotfix PRs and the `rc` → `main` release merge are the only PRs that ever target
   `main`. Merging it publishes `0.3.1` like any release.
3. Then [merge `main` back](#after-a-release-merge-main-back) into `rc` and `dev` (PRs merged by the owner), so both
   have the fix, the version and the changelog section.

### Review dev for rc (report format)

On request, the coordinator (Claude) writes a "review dev for rc" report before a promotion. It covers every PR
merged into `dev` that is not yet in `rc` or `main` (merged into `dev` after the last cut, and not picked: a picked
PR's merge sha appears in a `(cherry picked from commit …)` line on `rc`). For each PR:

| | |
|---|---|
| **Summary** | What it changes, in plain words. |
| **Type** | Fix → PATCH. Feature or behaviour change → MINOR. Project format change (`formatVersion`) → MINOR, and flagged. |
| **Risk and tests** | How risky it is and why; CI status; test coverage (unit, end-to-end, regression test); manual checks needed. |
| **Dependencies** | Other `dev` PRs it needs, or that need it, so they are promoted together and in order. |
| **Verdict** | **safe**, **needs testing** or **hold**. |

It ends with a **promotion plan**: the promotion PRs in order (a cut up to a named `dev` commit, or the picks), how
they map to versions (the largest type since the last stable release decides MINOR or PATCH), and the sequence from
`X.Y.Z-rc.1` through any further candidates to `X.Y.Z`.

### What gates a release

`.github/workflows/windows.yml` (display name "Windows build"; it builds Linux and macOS too) has seven required
jobs, the release gates. They run in parallel, four on `windows-latest`, one on `ubuntu-22.04` and two on `macos-14`
(`macos` runs twice, once per dmg; `needs: macos` waits for both legs, and `fail-fast: false` lets both finish and
report even when one fails):

| Job | Checks |
|---|---|
| `installer` (Installer + portable exe) | Builds the installer and portable exe, smoke-tests the unpacked app, runs the install check (five silent install / smoke / uninstall cycles and a portable launch), and decides the release metadata. |
| `tests` (Unit tests on Windows) | The vitest suite. |
| `e2e` (End-to-end tests on Windows) | The Playwright suite driving the built app. |
| `launcher` (Start ReCut.cmd from a fresh clone) | `Start ReCut.cmd -Smoke`. |
| `linux` (Linux AppImage + tests) | On `ubuntu-22.04`: typecheck, the vitest suite and the Playwright suite under xvfb, all with the FFmpeg that gets bundled; builds the x86-64 AppImage with that FFmpeg (`scripts/linux/get-ffmpeg.sh`), checks the OCR packaging budget and the bundled FFmpeg files, and smoke-tests the AppImage twice, mounted with FUSE and with `--appimage-extract-and-run` (media protocol, encode + probe with the FFmpeg inside the AppImage, licence files, OCR worker, UI mounted). Uploads the `ReCut-linux` artifact. |
| `macos` (macOS arm64 / x64 dmg + smoke test) | A matrix over `arm64` and `x64`, both on `macos-14` (Apple Silicon; the x64 leg runs its programs under Rosetta 2, never on Intel hardware): typecheck and the vitest suite with the FFmpeg and speech-to-text engine that get bundled; builds that arch's dmg, Developer ID signed and notarized when the signing secrets are set ([MACOS-SIGNING.md](MACOS-SIGNING.md)); checks the OCR packaging budget, the bundled FFmpeg and engine files (that arch only) and the signature of every binary (plus Gatekeeper and the stapled ticket when signed); mounts the dmg and smoke-tests the app inside it. **On a release run it fails unless all five signing secrets are set and the app is signed, notarized and stapled**; a test build without the secrets is ad-hoc signed. Uploads the `ReCut-macos-arm64` / `ReCut-macos-x64` artifact. |
| `macos-e2e` (End-to-end tests on macOS) | The Playwright suite on `macos-14` (arm64 only). |

The macos job decides "release or test build" itself, by the same rules as the installer job's release metadata
step (it runs in parallel and cannot wait for it), in its first step, so a release run without the signing secrets
fails within a minute. A release is never published with an ad-hoc signed dmg.

Publishing happens in a separate last job, `publish`, which runs only on a release run and only when all seven gates
succeeded (both `macos` legs included). It downloads the installer job's build, the Linux job's AppImage, both
macOS dmgs and the release notes, checks that exactly the five release files are there and named for the version
being released (`ReCut-Setup-<version>.exe`, `ReCut-Portable-<version>.exe`,
`ReCut-<version>-linux-x86_64.AppImage`, `ReCut-<version>-macos-arm64.dmg`, `ReCut-<version>-macos-x64.dmg`),
re-checks the tag, and publishes. If any gate fails, is cancelled or is skipped, `publish` is skipped. None of the gates is allowed to
fail (`continue-on-error` is not used). On a test build `publish` is always skipped.

Every run, release or test build, runs all seven gates the same way (the only difference: a release run's dmgs
must be signed). A run with any red gate publishes nothing and
creates no tag. `installer-stress` (manual only) is not a gate.

**On a red run:** nothing was published. Look at the failed job, fix the problem (see
[If the release build fails](#if-the-release-build-fails)); the next run that passes every gate publishes the release (or, for a test build, has
an artifact worth testing). A test that is red because of the
runner, not the code, can be re-run (see [If the release build fails](#if-the-release-build-fails)). Never make a
gate pass by weakening, skipping or deleting a test, and never re-add `continue-on-error` to a gate.

### Licence files every release ships

ReCut is MIT-licensed; the FFmpeg it bundles is GPL and is distributed alongside it with its licence and source
information (see [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)). A release that bundles FFmpeg must contain all
of these, in the installed app, in the portable exe and in the AppImage:

| File in the packaged app | Comes from |
|---|---|
| `resources/LICENSE` | `LICENSE` (ReCut, MIT), via `package.json` → `build.extraResources` |
| `resources/THIRD_PARTY_NOTICES.md` | `THIRD_PARTY_NOTICES.md`, via `build.extraResources` |
| `resources/ffmpeg/ffmpeg.exe`, `ffprobe.exe` (Windows); `resources/ffmpeg/ffmpeg`, `ffprobe` (Linux) | `scripts/windows/get-ffmpeg.ps1` / `scripts/linux/get-ffmpeg.sh`, via the `resources/ffmpeg` entry (`**/*`) |
| `resources/ffmpeg/FFMPEG-LICENSE.txt` | the licence file in the downloaded FFmpeg archive, copied by the script |
| `resources/ffmpeg/FFMPEG-BUILD.txt` | written by the script: source URL, build name, `ffmpeg -version`, date, where to get the corresponding source (the Linux one also names the platform and how the binaries are linked) |
| `resources/ffmpeg/FFMPEG-README.txt` | the archive's readme, when it has one (gyan.dev builds do; the BtbN builds, used for Linux, do not) |
| `LICENSE.electron.txt`, `LICENSES.chromium.html` (next to `ReCut.exe` / inside the AppImage next to `recut`) | added by electron-builder |

- Both scripts refuse an FFmpeg download that has no licence file and try the next source, so a build cannot bundle
  FFmpeg without `FFMPEG-LICENSE.txt` and `FFMPEG-BUILD.txt`. `get-ffmpeg.sh` also refuses binaries that are not
  x86-64 or that link to shared libraries other than glibc's own (and libgcc_s), so the AppImage does not depend on
  libraries a user's distribution may lack.
- The installer job's and the linux job's smoke tests log `smoke: licences shipped=... absent=...` for the unpacked
  app and the AppImage, and the macos job for the app inside each dmg; on a release run `absent=` should list
  nothing but, at most, `FFMPEG-README.txt` (always absent on Linux and macOS).
- After changing a runtime dependency (`package.json` → `dependencies`), run `node scripts/third-party-notices.mjs`
  and commit the updated `THIRD_PARTY_NOTICES.md`; the unit suite fails while it is out of date.
- Do not remove any of these files from the packaging config (see `docs/INSTALL.md`, "Bundling FFmpeg").
- **macOS:** the `macos` job bundles an arm64 FFmpeg (Apple Silicon dmg) or an x86-64
  FFmpeg (Intel dmg), both from the same jellyfin-ffmpeg release, with the same three files
  (`scripts/mac/get-ffmpeg.sh`; `FFMPEG-LICENSE.txt` is the build's `COPYING.GPLv3`, there is no readme) plus
  `LICENSE.electron.txt` and `LICENSES.chromium.html` in `ReCut.app/Contents/Resources`. Signing and notarization
  of the dmg: [MACOS-SIGNING.md](MACOS-SIGNING.md).
- **Before every release, check the FFmpeg source links still work**, for Windows, Linux and macOS. The release
  does not carry FFmpeg's source code; `FFMPEG-BUILD.txt` points to where it can be downloaded (the owner's decision,
  7 October 2026: a link, not an attached copy). After the release run, open the latest release build's logs (the
  linux job and each macos leg print their `FFMPEG-BUILD.txt` in the "Bundled FFmpeg files" step) or the shipped
  `FFMPEG-BUILD.txt`, and confirm that the "Corresponding source" links still download: for gyan.dev builds
  `https://ffmpeg.org/releases/ffmpeg-<version>.tar.xz`, for BtbN builds the FFmpeg commit archive
  `https://github.com/FFmpeg/FFmpeg/archive/<commit>.tar.gz`, for jellyfin-ffmpeg builds the source archive of the
  release tag (`https://github.com/jellyfin/jellyfin-ffmpeg/archive/refs/tags/<tag>.tar.gz`). If one no longer does, attach that version's source
  archive to the release by hand or switch to attaching it in CI. The GPL expects the source to stay available for as
  long as the release is offered.

### Fallback: pushing the tag yourself

The old tag-push path still works and is optional; it is not needed for a normal release. Use it only after the
release is merged into `main` (for a candidate, its release-prep PR into `rc`), only if no `v<version>` tag exists
yet, and only from a machine that can push tags:

```bash
git fetch origin main
git log --oneline -3 origin/main          # find the release merge commit (origin/rc for a candidate)
git tag v0.3.0 <merge sha>
git push origin v0.3.0
```

Use a plain tag `v<MAJOR>.<MINOR>.<PATCH>` (or, for a release candidate, `v<MAJOR>.<MINOR>.<PATCH>-rc.<N>`). The tag run checks that the tag equals `v` + the `package.json` version at
that commit and that `CHANGELOG.md` has a `## [<version>]` section, fails within seconds if either is wrong, and
otherwise builds, checks and (once every gate is green) publishes the same release as the automatic path. If a
`main` or `rc` run is building the same version at that moment, it sees your tag when it re-checks before publishing, logs a
warning that the version is already released, and publishes nothing (the tag run publishes the release). If the
branch run published first, the tag already exists on the right commit and your push has nothing to do.

### If the release build fails

Publishing is the last job and needs every gate, so a failed run (any red gate: build, smoke test, install check,
unit tests, end-to-end tests or the launcher check) published nothing and created no tag. The version is still
unreleased, and the next run of the same branch (`main`, or `rc` for a candidate) that passes every gate will release
it.

- **Flaky failure** (runner or network trouble, a check that passes on retry): open the failed run on the Actions tab
  and click **Re-run failed jobs** (or **Re-run all jobs**). The publish job runs again after the re-run gates pass,
  and releases the same merge commit, because `vX.Y.Z` still does not exist.
- **Real failure** (the build, smoke test, install check, a unit or end-to-end test or the launcher is broken): fix
  forward. Fix the problem in a normal PR into `dev` and pick it into `rc` ([promotion PR](#promoting-dev-to-rc-cut--pick)).
  For a candidate, the push to `rc` of that pick publishes the still-unreleased `X.Y.Z-rc.N` once every gate passes.
  For a final release, open another `rc` → `main` PR (or, for a small fix, take the [hotfix](#hotfixes) path without
  the version bump and merge `main` back afterwards); because `X.Y.Z` is still unreleased, the first `main` run after
  that merge that passes every gate publishes `X.Y.Z` from the fixed commit. If the fix belongs in the notes, the
  promotion PR may add its line to the unreleased section (it does not change the heading or the version). A new
  release-prep PR is only needed once the version has actually been published (next item).
- **A macos leg fails with "a release must be signed and notarized"**: one or more of the five signing secrets are
  missing (or were removed), or signing or notarization failed. Set the secrets or fix the cause
  ([MACOS-SIGNING.md](MACOS-SIGNING.md)), then **Re-run failed jobs**; the version is still unreleased. Never work
  around it by publishing without macOS: the dmgs are required release files.
- **Manual tag does not match the version** (fallback path only, for example a tag on the wrong commit): delete the
  tag (`git push origin :refs/tags/v0.3.0`, `git tag -d v0.3.0`) and tag the right commit, or let the next `main`
  run release it. This is only allowed while no release exists for that tag.
- **A published release turns out to be broken:** fix it in `dev`, pick it into `rc` and release the next PATCH
  version (or, for a candidate, the next `rc.N`) from `rc` as usual, or as a [hotfix](#hotfixes) from `main` when it
  cannot wait.

**Never move or re-use a published tag.** Once a release exists for `vX.Y.Z`, that tag and its files are final.

## Release candidates

Candidates are published from `rc` ([Pre-releases from rc](#pre-releases-from-rc)), stable releases from `main`.
1.0.0 is preceded by release candidates `1.0.0-rc.1`, `1.0.0-rc.2`, … ([ROADMAP → Release
candidates](ROADMAP.md#release-candidates-100-rc1-rc2-)). A candidate is a real release: it has its own release-prep
PR, version, changelog section, tag and release page, it runs every gate, and it ships the same files. Only these
things differ from a stable release:

| | Stable `1.0.0` | Candidate `1.0.0-rc.2` |
|---|---|---|
| Version (release-prep PR into `rc`) | `npm version 1.0.0 --no-git-tag-version` | `npm version 1.0.0-rc.2 --no-git-tag-version` |
| `CHANGELOG.md` heading | `## [1.0.0] - YYYY-MM-DD` | `## [1.0.0-rc.2] - YYYY-MM-DD` |
| Tag and release name (made by CI) | `v1.0.0`, `ReCut 1.0.0` | `v1.0.0-rc.2`, `ReCut 1.0.0-rc.2` |
| Published by | The push to `main` of the `rc` → `main` merge | The push to `rc` of its release-prep PR's merge |
| Releases page | Full release, marked **Latest** | Marked **Pre-release**, never Latest: Latest stays on the newest stable release |
| `CHANGELOG.md` section lists | Everything since the last stable release | The changes since the previous candidate (`rc.1`: since the last stable release) |
| Release notes | The changelog section, then the install note | A first line saying it is a release candidate for testing, then the same |
| Files | `ReCut-Setup-1.0.0.exe`, `ReCut-Portable-1.0.0.exe`, `ReCut-1.0.0-linux-x86_64.AppImage`, `ReCut-1.0.0-macos-arm64.dmg`, `ReCut-1.0.0-macos-x64.dmg` | The same five, named `…-1.0.0-rc.2…` |
| macOS signing | The dmgs must be Developer ID signed, notarized and stapled | The same: a candidate is a release run, so the `macos` legs fail without the signing secrets |
| Saved-project fixture | `recut-1.0.0.recut`, required | None (see below) |
| Update notice | Offered to everyone on an older version | Offered only to people running an earlier candidate of 1.0.0 |

**How CI tells them apart.** The "Release metadata" step of `.github/workflows/windows.yml` accepts a `package.json`
version `MAJOR.MINOR.PATCH` or `MAJOR.MINOR.PATCH-<pre-release>` (SemVer, no build metadata); a version with a
pre-release part is published as a pre-release with `make_latest` false, and the publish job checks that again from
the tag before publishing. A push to `rc` publishes only a candidate `X.Y.Z-rc.N` and a push to `main` only a stable
version: the release decision, the publish job's `if:` and its final check all enforce it. The `macos` job's
"Release run?" step decides the same way (a `vX.Y.Z-rc.N` tag push, or a push to `rc` whose candidate version has its
changelog section and no tag yet, is a release run), so a candidate's dmgs must be signed and notarized like a stable
release's. ReCut uses only `-rc.<N>`: N counts from 1 without leading zeros (`rc.9`, then `rc.10`),
and only `vX.Y.Z-rc.<N>` tags start the [tag-push fallback](#fallback-pushing-the-tag-yourself). The changelog heading
must name the full version in brackets exactly, `## [1.0.0-rc.2] - YYYY-MM-DD`. The lookup is exact, so `1.0.0`,
`1.0.0-rc.1` and `1.0.0-rc.10` each find only their own section, and a section ends at the next `## [` heading.

**Saved-project fixtures.** The [compatibility promise](project-format.md#compatibility-promise) covers stable
releases, so a candidate has no fixture of its own: `node scripts/make-project-fixture.mjs` refuses a pre-release
version (unless `--out` is given, for a scratch copy), and the unit suite asks for a fixture only when the version in
`package.json` is stable. While the candidates are out, the newest fixture is the last stable release's, which every
candidate must open like every other build. The 1.0.0 release-prep PR adds `recut-1.0.0.recut`.

**The update notice.** Someone running a stable version asks GitHub for `releases/latest`, which never returns a
pre-release, and is never told about a candidate. Someone running a candidate asks for the list of recent releases
instead (still one request) and is told about a later candidate of the same version (`rc.2` after `rc.1`, `rc.10`
after `rc.9`) or about a newer stable release (`1.0.0`), whichever comes first in SemVer precedence:
`1.0.0-rc.1 < 1.0.0-rc.2 < … < 1.0.0-rc.10 < 1.0.0`. Once 1.0.0 is published, every candidate user is pointed at it.

### Cutting 1.0.0-rc.1

1. The 1.0 milestones are promoted to `rc` and the feature freeze starts (ROADMAP → Release candidates): from now on
   only fixes for release-blocking defects (and documentation) are promoted from `dev` to `rc`.
2. Release-prep PR into `rc`, branch `claude/release-1.0.0-rc.1` from `rc`:
   - `npm version 1.0.0-rc.1 --no-git-tag-version`
   - add `## [1.0.0-rc.1] - YYYY-MM-DD` at the top of `CHANGELOG.md`, written like any release section
     ([What goes in the changelog](#what-goes-in-the-changelog)) and covering everything since the last stable
     release
   - no saved-project fixture; no roadmap **Status** or Progress change (they name stable releases)
   - `npm run typecheck` and `npm test`, then open the PR against `rc`.
3. The owner merges it. On that push to `rc`, CI runs every gate and the publish job publishes `ReCut 1.0.0-rc.1` on
   tag `v1.0.0-rc.1`.
4. Check the release page: the **Pre-release** label is shown, **Latest** is still on the last stable release, the
   notes start with the release-candidate line, and both `.exe` files, the `.AppImage` and both `.dmg` files are
   attached.

### Cutting 1.0.0-rc.2 (and later candidates)

1. Fixes land in normal PRs into `dev` (through the personal branches) and are picked into `rc`
   ([promotion PRs](#promoting-dev-to-rc-cut--pick)). They do not touch the version or the `## [1.0.0-rc.1]` section
   (it is published and final).
2. Release-prep PR `claude/release-1.0.0-rc.2` from `rc`: `npm version 1.0.0-rc.2 --no-git-tag-version`, and a new
   `## [1.0.0-rc.2] - YYYY-MM-DD` section above `## [1.0.0-rc.1]` listing what changed since rc.1 (usually only
   **Fixed**). No fixture. `npm run typecheck`, `npm test`, open the PR against `rc`; the owner merges it.
3. CI publishes `ReCut 1.0.0-rc.2` as a pre-release. People running rc.1 with the update check on are told about it.
4. A broken candidate is never fixed in place: fix forward and cut the next one (`rc.3`). The tag and the release of
   a published candidate are final, like any release.

### Releasing 1.0.0

1. Every item under **Ready for 1.0** holds (ROADMAP), including a week of normal use of the last candidate.
2. Release-prep PR into `rc`, `claude/release-1.0.0`, as for any stable release ([Final release](#final-release-rc--main)):
   - `npm version 1.0.0 --no-git-tag-version`
   - `## [1.0.0] - YYYY-MM-DD` at the top of `CHANGELOG.md`, above the candidates' sections, written for people
     coming from the last stable release: it covers everything since that release, the candidates' fixes included.
     The `## [1.0.0-rc.N]` sections stay below it unchanged, as history.
   - `node scripts/make-project-fixture.mjs` writes `tests/fixtures/projects/recut-1.0.0.recut` (the unit suite
     fails without it)
   - the roadmap **Status** lines and Progress rows of what 1.0.0 ships
   - `npm run typecheck` and `npm test`, then open the PR against `rc`.
3. The owner merges it, then the `rc` → `main` PR. CI publishes `ReCut 1.0.0` on tag `v1.0.0`, a full release marked
   **Latest**. Everyone with the update check on is told about it, candidate users included. Then
   [merge `main` back](#after-a-release-merge-main-back).
4. The candidates' releases stay on the Releases page as pre-releases; nothing needs deleting.

## What goes in the changelog

`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), newest version first. Each release
section uses these headings (leave out empty ones):

- **Added**: new features and capabilities.
- **Changed**: behaviour users will notice even though nothing is broken: new prompts, stricter validation, different
  output, different defaults. Put behaviour changes here, in bold if a user could be surprised.
- **Fixed**: bugs fixed. Link the closed issue for every bug, for example
  `([#139](https://github.com/jelloshooter848/ReCut/issues/139))`.
- **Known issues**: important open bug issues, linked, plus any limitation users must know about.

Rules:

- Describe what users see, not how it was implemented. One line per item where possible. No marketing.
- Write the section from the changelog draft in [NEXT-RELEASE.md](NEXT-RELEASE.md) as it is on `rc`, which each
  issue's PR fills in as it goes and which promotions carry to `rc`. Check it against
  `git log --oneline <previous tag>..origin/rc` and the bug issues closed since the previous release (label `bug`, or
  `done on dev`) that were promoted: add what is missing, drop "(on devJames)" / "(on devDavid)" marks, and tidy the
  wording. The draft's **Development** items go under the section's own **Development** heading.
- A candidate's section (`## [X.Y.Z-rc.N]`) lists the changes since the previous candidate (`rc.1`: since the last
  stable release). The final `## [X.Y.Z]` section covers everything since the last stable release.
- Link repository files with relative links (`docs/...`). CI rewrites them to absolute links at
  the release tag for the GitHub release notes.
- Mention a project `formatVersion` change explicitly.
- CI copies everything between `## [x.y.z]` and the next `## [` heading into the release notes, so keep that section
  self-contained.

### The empty NEXT-RELEASE.md

Once a release-prep PR has moved the entries into `CHANGELOG.md`, [NEXT-RELEASE.md](NEXT-RELEASE.md) on `rc` is
back to this template (keep the intro paragraph as it is in the file), so the next candidate or release starts from
an empty draft. On `dev` the file keeps the entries of changes not promoted yet (see
[After a release](#after-a-release-merge-main-back)):

```markdown
# Next release

Changes on `dev` (and on the personal branches heading there) that are not in a release yet. ...

## Changelog draft

### Added

### Changed

### Fixed

### Known issues

### Development

## QA checklist

Test on a `dev` build (`npm run dev` on `dev`). Tick an item when it behaves as described. A block marked (on devJames) or
(on devDavid) needs that branch until it is merged into `dev`.
```

A hotfix does not touch NEXT-RELEASE.md: its fix is released at once and gets its changelog line in the hotfix's own
section.

## Build names

| Trigger | Tag | Result |
|---|---|---|
| Push to `main` of a stable `<version>`; `CHANGELOG.md` has `## [<version>]`; no tag `v<version>` yet | `v<version>` (created by CI) | Release `ReCut <version>`, marked Latest |
| Push to `rc` of a candidate `<version>` such as `1.0.0-rc.1` (`X.Y.Z-rc.N`, N from 1); the same conditions | `v1.0.0-rc.1` (created by CI) | Release `ReCut 1.0.0-rc.1`, marked **Pre-release**, never Latest |
| Push of tag `v<version>` (optional fallback; `v<x.y.z>` or `v<x.y.z>-rc.<N>`) | `v<version>` (yours) | The same release as the automatic path (Latest, or Pre-release for a candidate) |
| Push to `main` or `rc`; `v<version>` already tagged, or no changelog section | none | [Test build](#test-builds): `ReCut-windows`, `ReCut-linux`, `ReCut-macos-arm64` and `ReCut-macos-x64` CI artifacts only |
| Push to `main` of a pre-release version (with a warning), or to `rc` of a stable version or of a pre-release that is not `X.Y.Z-rc.N` | none | [Test build](#test-builds): `ReCut-windows`, `ReCut-linux`, `ReCut-macos-arm64` and `ReCut-macos-x64` CI artifacts only |
| Push to `dev`, a pull request into `main`, `rc`, `dev`, `devDavid` or `devJames`, or a manual run (`workflow_dispatch`) | none | [Test build](#test-builds): `ReCut-windows`, `ReCut-linux`, `ReCut-macos-arm64` and `ReCut-macos-x64` CI artifacts only |

A release is published only when all seven gates pass ([What gates a release](#what-gates-a-release)), release
candidates included, and its dmgs are always signed and notarized. Only real versions (`0.4.0`, `0.5.0`, …, and the
release candidates `1.0.0-rc.N`) ever appear on the Releases page: there are no dev or test-build prereleases.

### Test builds

Every run that is not a release is a test build of an unreleased commit. It runs every gate exactly like a release
(installer build, smoke test, install check, unit tests, end-to-end tests, launcher check, the Linux and macOS
jobs), but creates no tag and publishes nothing. Its installer and portable exe are kept only as the run's
`ReCut-windows` workflow artifact, its AppImage as the `ReCut-linux` artifact and its dmgs as the `ReCut-macos-arm64`
and `ReCut-macos-x64` artifacts, for 14 days. Its dmgs are signed and notarized only if the signing secrets are set;
otherwise they are ad-hoc signed and need the first-launch steps in [INSTALL.md](INSTALL.md#macos). The file names carry the last released
version (the version in `package.json` on that commit), so `ReCut-Setup-0.5.0.exe` from a test build is a build made
after 0.5.0, not 0.5.0 itself.

To download a test build: open the repository's **Actions** tab → **Windows build** → the run (its summary says
"Test build: download the installers from this run's Artifacts (ReCut-windows)") → **Artifacts** → **ReCut-windows**.
GitHub downloads a zip with `ReCut-Setup-<version>.exe` and `ReCut-Portable-<version>.exe`; you must be signed in to
GitHub. The Linux build is the **ReCut-linux** artifact of the same run, a zip with
`ReCut-<version>-linux-x86_64.AppImage` (unzipping drops the executable bit: run `chmod +x` on it). The macOS
builds are the **ReCut-macos-arm64** (Apple Silicon) and **ReCut-macos-x64** (Intel) artifacts, each a zip with one
dmg. Use a test build only if the seven required jobs of its run (installer, tests, e2e, launcher, linux, macos,
macos-e2e) are green. Users should install the release marked **Latest**.

The newest unreleased code is on `dev`: the latest green run of the `dev` branch has its test builds. The next
release's code is on `rc`: its latest green run has test builds of it between candidates. A pull request into `main`,
`rc`, `dev`, `devDavid` or `devJames` makes a test build of the pull request's merge result. To make a test build of
any other branch, run the workflow by hand (*Run workflow*, `workflow_dispatch`) on that branch.

### Tags

The workflow only runs for plain semver tags (`v[0-9]+.[0-9]+.[0-9]+`) and release-candidate tags
(`v[0-9]+.[0-9]+.[0-9]+-rc.[0-9]+`). The `v<version>` tag of an automatic release
does match that pattern, but it is created with the workflow's `GITHUB_TOKEN`, and tags created with `GITHUB_TOKEN`
do not trigger workflows, so it does not start a second build. Documentation-only pushes to a branch skip the build
(`paths-ignore`), but GitHub does not evaluate path filters for tag pushes, so a release tag always builds.

Before this standard, CI published every branch build as `v0.1.0-win.<run>` ("ReCut 0.1.0 for Windows (build N)"),
and until 7 October 2026 it published every non-release build as a dev prerelease `v<version>-dev.<run>`. Neither
kind is created any more, and neither tag pattern starts a build. The existing ones still exist; the owner may delete
them (release and tag) from the GitHub Releases page; agents must not.
