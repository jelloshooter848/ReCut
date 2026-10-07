# Versioning and releases

## Version numbers

ReCut uses [semantic versioning](https://semver.org/). Before 1.0 the version is `0.MINOR.PATCH`:

| Part | Bump when a release contains |
|---|---|
| MINOR (`0.2.0` → `0.3.0`) | A roadmap milestone, a user-visible feature, or a behaviour change users will notice. Reset PATCH to 0. |
| PATCH (`0.2.0` → `0.2.1`) | Bug fixes only. |
| `1.0.0` | The owner's call, when every item under **Ready for 1.0** in [ROADMAP → Road to 1.0](ROADMAP.md#road-to-10) holds. Release candidates (`1.0.0-rc.1`, `rc.2`, …) come first; the release workflow publishes only `X.Y.Z` today and needs pre-release support for them before rc.1. |

The version lives in `package.json` (and `package-lock.json`). The app reads it from there through Electron's
`app.getVersion()` (Preferences › Version and Help › About), the Windows file names use it
(`ReCut-Setup-<version>.exe`), and CI names releases after it. Do not write the version anywhere else.

**The project file format is versioned separately.** `formatVersion` in `.recut` files (`PROJECT_FORMAT_VERSION` in
`shared/model.ts`, read and migrated in `shared/project.ts`) changes only when the file format changes, never because
the app version changed. A format change is a MINOR bump at least, and the changelog says so.

## Who changes the version

Only a **release PR** changes the version. Feature and bug PRs never touch `package.json` `version`,
`package-lock.json` versions or `CHANGELOG.md` release headings. A release PR contains only:

1. The version bump: `npm version <x.y.z> --no-git-tag-version` (updates `package.json` and `package-lock.json`).
2. A new dated section at the top of `CHANGELOG.md`: `## [x.y.z] - YYYY-MM-DD`.
3. Doc lines that name the current version, if any (prefer wording that does not name a version).

## How to cut a release

Releases are published automatically by CI when a release PR is merged. Nobody pushes a tag or creates a release by
hand: agents cannot push tags (their git proxy drops tag pushes), and the owner works in the GitHub web UI.

1. **Release PR.** Branch from `main` (for example `claude/release-0.3.0`). Bump the version with
   `npm version 0.3.0 --no-git-tag-version` and add the `## [0.3.0] - YYYY-MM-DD` section to `CHANGELOG.md` (see
   below). Check `docs/ROADMAP.md`: every roadmap entry this release ships has its **Status** line and its row in the
   Progress table marked done with this version (the feature PR sets them; the release PR fixes any that are
   missing or still name an older version). Run `npm run typecheck` and `npm test`. Open the PR.
2. **Merge it.** That is the whole release step.
3. **CI publishes.** The merge is a push to `main`, so `.github/workflows/windows.yml` runs. Its first step sees that
   the `package.json` version (`0.3.0`) has a `## [0.3.0]` section in `CHANGELOG.md` and that no tag `v0.3.0` exists
   yet, and makes this run a release. It then builds, smoke-tests the unpacked app, installs and uninstalls the
   installer and launches the portable exe, while the Windows unit tests, end-to-end tests and launcher check run in
   parallel. Only when all of them have passed does the final `publish` job publish the release: tag `v0.3.0` on the
   merge commit (created by the publish job), name `ReCut 0.3.0`, not a prerelease, marked **Latest**, body = that
   version's changelog section plus the install / SmartScreen note, with the installer and portable exe attached.
   See [What gates a release](#what-gates-a-release).
4. Check the release page: both `.exe` files are attached and the notes read correctly. In the installer job's log,
   the smoke test lists the licence files the build ships (see [Licence files every release ships](#licence-files-every-release-ships)).

Every later push to `main` finds `v0.3.0` already tagged and makes a [test build](#test-builds) (all gates, installers
kept as a CI artifact, nothing published) until the next release PR is merged.

**Only real versions appear on the Releases page** (owner's decision, 7 October 2026). CI never publishes a dev
prerelease and never creates a `-dev.` tag; every run that is not a release is a test build whose installers are only
the run's `ReCut-windows` artifact.

**Never create the release or the tag by hand before the release PR is merged**, not in the web UI ("Draft a new
release" / "Choose a tag") and not with git. A tag made that way points at whatever commit was selected (twice so
far, a release was created on the wrong target this way). If a `vX.Y.Z` tag exists when the release PR is merged, CI
treats the version as already released and only makes a test build.

Details:

- Only pushes to `main` release automatically. Other branches and manual runs (*Run workflow*, `workflow_dispatch`)
  always make test builds, which publish nothing.
- A push to `main` that changes only `*.md` or `docs/**` files does not run the workflow, so it cannot release. A
  release PR always changes `package.json`, so its merge always runs.
- Runs on `main` queue instead of cancelling each other, so a release run is never cancelled by a quick follow-up
  merge, and the next run sees the tag the release run created. If a merge lands while an earlier `main` run is still
  going, GitHub keeps only the newest waiting run: a release run that had not started yet can be replaced by the next
  merge's run, which then publishes the release from that newer commit (the version is still untagged).
- Just before publishing, a release run checks the tag again. If `vX.Y.Z` appeared during the build (someone tagged or
  released by hand), the version is already released: the publish job logs a warning, publishes nothing, leaves that
  release alone and finishes successfully. The run's installers are still in its `ReCut-windows` artifact.
- The tag is created by the workflow's `GITHUB_TOKEN`, and GitHub does not start workflows for events caused by
  `GITHUB_TOKEN`, so the new tag does not start a second build.

### What gates a release

`.github/workflows/windows.yml` has four required jobs, the release gates. They run in parallel on `windows-latest`:

| Job | Checks |
|---|---|
| `installer` (Installer + portable exe) | Builds the installer and portable exe, smoke-tests the unpacked app, runs the install check (five silent install / smoke / uninstall cycles and a portable launch), and decides the release metadata. |
| `tests` (Unit tests on Windows) | The vitest suite. |
| `e2e` (End-to-end tests on Windows) | The Playwright suite driving the built app. |
| `launcher` (Start ReCut.cmd from a fresh clone) | `Start ReCut.cmd -Smoke`. |

Publishing happens in a separate last job, `publish`, which runs only on a release run and only when all four gates
succeeded. It downloads the installer job's build and release notes, re-checks the tag, and publishes. If any gate
fails, is cancelled or is skipped, `publish` is skipped. None of the gates is allowed to fail (`continue-on-error` is
not used). On a test build `publish` is always skipped.

Every run, release or test build, runs all four gates the same way. A run with any red gate publishes nothing and
creates no tag. `installer-stress` (manual only) is not a gate.

**On a red run:** nothing was published. Look at the failed job, fix the problem in a normal PR (or push the fix to
the branch), and push again; the next run that passes every gate publishes the release (or, for a test build, has
an artifact worth testing). A test that is red because of the
runner, not the code, can be re-run (see [If the release build fails](#if-the-release-build-fails)). Never make a
gate pass by weakening, skipping or deleting a test, and never re-add `continue-on-error` to a gate.

### Licence files every release ships

ReCut is MIT-licensed; the FFmpeg it bundles is GPL and is distributed alongside it with its licence and source
information (see [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)). A release that bundles FFmpeg must contain all
of these, in the installed app and in the portable exe:

| File in the packaged app | Comes from |
|---|---|
| `resources/LICENSE` | `LICENSE` (ReCut, MIT), via `package.json` → `build.extraResources` |
| `resources/THIRD_PARTY_NOTICES.md` | `THIRD_PARTY_NOTICES.md`, via `build.extraResources` |
| `resources/ffmpeg/ffmpeg.exe`, `ffprobe.exe` | `scripts/windows/get-ffmpeg.ps1`, via the `resources/ffmpeg` entry (`**/*`) |
| `resources/ffmpeg/FFMPEG-LICENSE.txt` | the licence file in the downloaded FFmpeg archive, copied by `get-ffmpeg.ps1` |
| `resources/ffmpeg/FFMPEG-BUILD.txt` | written by `get-ffmpeg.ps1`: source URL, build name, `ffmpeg -version`, date, where to get the corresponding source |
| `resources/ffmpeg/FFMPEG-README.txt` | the archive's readme, when it has one (gyan.dev builds do) |
| `LICENSE.electron.txt`, `LICENSES.chromium.html` (next to `ReCut.exe`) | added by electron-builder |

- `get-ffmpeg.ps1` refuses an FFmpeg download that has no licence file and tries the next source, so a build cannot
  bundle FFmpeg without `FFMPEG-LICENSE.txt` and `FFMPEG-BUILD.txt`.
- The installer job's smoke test logs `smoke: licences shipped=... absent=...` for the unpacked app; on a release run
  `absent=` should list nothing but, at most, `FFMPEG-README.txt`.
- After changing a runtime dependency (`package.json` → `dependencies`), run `node scripts/third-party-notices.mjs`
  and commit the updated `THIRD_PARTY_NOTICES.md`; the unit suite fails while it is out of date.
- Do not remove any of these files from the packaging config. If FFmpeg is ever bundled for Linux or macOS, the same
  files must go next to those binaries (see `docs/INSTALL.md`, "Bundling FFmpeg").
- **Before every release, check the FFmpeg source link still works.** The release does not carry FFmpeg's source
  code; `FFMPEG-BUILD.txt` points to where it can be downloaded (the owner's decision, 7 October 2026: a link, not an
  attached copy). After the release run, open the latest release build's log or the installed `FFMPEG-BUILD.txt`,
  and confirm that the "Corresponding source" link (for gyan.dev builds, `https://ffmpeg.org/releases/ffmpeg-<version>.tar.xz`)
  still downloads. If it no longer does, attach that version's source archive to the release by hand or switch to
  attaching it in CI. The GPL expects the source to stay available for as long as the release is offered.

### Fallback: pushing the tag yourself

The old tag-push path still works and is optional; it is not needed for a normal release. Use it only after the
release PR is merged, only if no `vX.Y.Z` tag exists yet, and only from a machine that can push tags:

```bash
git fetch origin main
git log --oneline -3 origin/main          # find the release PR's merge commit
git tag v0.3.0 <merge sha>
git push origin v0.3.0
```

Use a plain tag `v<MAJOR>.<MINOR>.<PATCH>`. The tag run checks that the tag equals `v` + the `package.json` version at
that commit and that `CHANGELOG.md` has a `## [<version>]` section, fails within seconds if either is wrong, and
otherwise builds, checks and (once every gate is green) publishes the same release as the automatic path. If a
`main` run is building the same version at that moment, it sees your tag when it re-checks before publishing, logs a
warning that the version is already released, and publishes nothing (the tag run publishes the release). If the
`main` run published first, the tag already exists on the right commit and your push has nothing to do.

### If the release build fails

Publishing is the last job and needs every gate, so a failed run (any red gate: build, smoke test, install check,
unit tests, end-to-end tests or the launcher check) published nothing and created no tag. The version is still
unreleased, and the next `main` run that passes every gate will release it.

- **Flaky failure** (runner or network trouble, a check that passes on retry): open the failed run on the Actions tab
  and click **Re-run failed jobs** (or **Re-run all jobs**). The publish job runs again after the re-run gates pass,
  and releases the same merge commit, because `vX.Y.Z` still does not exist.
- **Real failure** (the build, smoke test, install check, a unit or end-to-end test or the launcher is broken): fix
  forward. Fix the problem in a normal PR. Because `X.Y.Z` is still unreleased, the first `main` run after that merge
  that passes every gate publishes `X.Y.Z` from the fixed commit; nothing else is needed. If the fix belongs in the
  notes, the fix PR may add its line to the unreleased `## [X.Y.Z]` section (it does not change the heading or the
  version). A new PATCH release PR is only needed once `X.Y.Z` has actually been published (next item).
- **Manual tag does not match the version** (fallback path only, for example a tag on the wrong commit): delete the
  tag (`git push origin :refs/tags/v0.3.0`, `git tag -d v0.3.0`) and tag the right commit, or let the next `main`
  run release it. This is only allowed while no release exists for that tag.
- **A published release turns out to be broken:** fix it and release the next PATCH version with a release PR.

**Never move or re-use a published tag.** Once a release exists for `vX.Y.Z`, that tag and its files are final.

## What goes in the changelog

`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), newest version first. Each release
section uses these headings (leave out empty ones):

- **Added**: new features and capabilities.
- **Changed**: behaviour users will notice even though nothing is broken: new prompts, stricter validation, different
  output, different defaults. Put behaviour changes here, in bold if a user could be surprised.
- **Fixed**: bugs fixed. Link the closed report for every bug that has one, for example
  `([report](bugs/closed/2026-10-05-export-perf-inputcount-stale.md))`.
- **Known issues**: important open reports under `bugs/open/`, linked, plus any limitation users must know about.

Rules:

- Describe what users see, not how it was implemented. One line per item where possible. No marketing.
- Build the section from `git log --oneline <previous tag>..origin/main` and from the reports moved to
  `bugs/closed/` since the previous release.
- Link repository files with relative links (`bugs/closed/...`, `docs/...`). CI rewrites them to absolute links at
  the release tag for the GitHub release notes.
- Mention a project `formatVersion` change explicitly.
- CI copies everything between `## [x.y.z]` and the next `## [` heading into the release notes, so keep that section
  self-contained.

## Build names

| Trigger | Tag | Result |
|---|---|---|
| Push to `main`; `CHANGELOG.md` has `## [<version>]`; no tag `v<version>` yet | `v<version>` (created by CI) | Release `ReCut <version>`, marked Latest |
| Push of tag `v<version>` (optional fallback) | `v<version>` (yours) | Release `ReCut <version>`, marked Latest |
| Push to `main`; `v<version>` already tagged, or no changelog section | none | [Test build](#test-builds): `ReCut-windows` CI artifact only |
| Push to another watched branch, or a manual run (`workflow_dispatch`) | none | [Test build](#test-builds): `ReCut-windows` CI artifact only |

A release is published only when all four gates pass ([What gates a release](#what-gates-a-release)). Only real
versions (`0.4.0`, `0.5.0`, …) ever appear on the Releases page: there are no prereleases.

### Test builds

Every run that is not a release is a test build of an unreleased commit. It runs every gate exactly like a release
(installer build, smoke test, install check, unit tests, end-to-end tests, launcher check), but creates no tag and
publishes nothing. Its installer and portable exe are kept only as the run's `ReCut-windows` workflow artifact, for 14
days. The file names carry the last released version (the version in `package.json` on that commit), so
`ReCut-Setup-0.5.0.exe` from a test build is a build made after 0.5.0, not 0.5.0 itself.

To download a test build: open the repository's **Actions** tab → **Windows build** → the run (its summary says
"Test build: download the installers from this run's Artifacts (ReCut-windows)") → **Artifacts** → **ReCut-windows**.
GitHub downloads a zip with `ReCut-Setup-<version>.exe` and `ReCut-Portable-<version>.exe`; you must be signed in to
GitHub. Use a test build only if every job in its run is green. Users should install the release marked **Latest**.

To make a test build of a work branch, run the workflow by hand (*Run workflow*, `workflow_dispatch`) on that branch.

### Tags

The workflow only runs for plain semver tags (`v[0-9]+.[0-9]+.[0-9]+`). The `v<version>` tag of an automatic release
does match that pattern, but it is created with the workflow's `GITHUB_TOKEN`, and tags created with `GITHUB_TOKEN`
do not trigger workflows, so it does not start a second build. Documentation-only pushes to a branch skip the build
(`paths-ignore`), but GitHub does not evaluate path filters for tag pushes, so a release tag always builds.

Before this standard, CI published every branch build as `v0.1.0-win.<run>` ("ReCut 0.1.0 for Windows (build N)"),
and until 7 October 2026 it published every non-release build as a dev prerelease `v<version>-dev.<run>`. Neither
kind is created any more, and neither tag pattern starts a build. The existing ones still exist; the owner may delete
them (release and tag) from the GitHub Releases page; agents must not.
