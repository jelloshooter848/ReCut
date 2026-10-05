# Versioning and releases

## Version numbers

ReCut uses [semantic versioning](https://semver.org/). Before 1.0 the version is `0.MINOR.PATCH`:

| Part | Bump when a release contains |
|---|---|
| MINOR (`0.2.0` → `0.3.0`) | A roadmap milestone, a user-visible feature, or a behaviour change users will notice. Reset PATCH to 0. |
| PATCH (`0.2.0` → `0.2.1`) | Bug fixes only. |
| `1.0.0` | The owner's call, when ReCut is stable enough for other people to rely on. |

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
   below). Run `npm run typecheck` and `npm test`. Open the PR.
2. **Merge it.** That is the whole release step.
3. **CI publishes.** The merge is a push to `main`, so `.github/workflows/windows.yml` runs. Its first step sees that
   the `package.json` version (`0.3.0`) has a `## [0.3.0]` section in `CHANGELOG.md` and that no tag `v0.3.0` exists
   yet, and makes this run a release. It then builds, smoke-tests the unpacked app, installs and uninstalls the
   installer and launches the portable exe, and only then publishes the release: tag `v0.3.0` on the merge commit
   (created by the publish step), name `ReCut 0.3.0`, not a prerelease, marked **Latest**, body = that version's
   changelog section plus the install / SmartScreen note, with the installer and portable exe attached.
4. Check the release page: both `.exe` files are attached and the notes read correctly.

Every later push to `main` finds `v0.3.0` already tagged and publishes a dev prerelease, as usual, until the next
release PR is merged.

**Never create the release or the tag by hand before the release PR is merged**, not in the web UI ("Draft a new
release" / "Choose a tag") and not with git. A tag made that way points at whatever commit was selected (twice so
far, a release was created on the wrong target this way). If a `vX.Y.Z` tag exists when the release PR is merged, CI
treats the version as already released and only makes a dev build.

Details:

- Only pushes to `main` release automatically. Other branches and manual runs (*Run workflow*, `workflow_dispatch`)
  always make dev prereleases.
- A push to `main` that changes only `*.md` or `docs/**` files does not run the workflow, so it cannot release. A
  release PR always changes `package.json`, so its merge always runs.
- Runs on `main` queue instead of cancelling each other, so a release run is never cancelled by a quick follow-up
  merge, and the next run sees the tag the release run created. If a merge lands while an earlier `main` run is still
  going, GitHub keeps only the newest waiting run: a release run that had not started yet can be replaced by the next
  merge's run, which then publishes the release from that newer commit (the version is still untagged).
- Just before publishing, a release run checks the tag again. If `vX.Y.Z` appeared during the build (someone tagged or
  released by hand), it publishes a dev prerelease instead and leaves that release alone.
- The tag is created by the workflow's `GITHUB_TOKEN`, and GitHub does not start workflows for events caused by
  `GITHUB_TOKEN`, so the new tag does not start a second build.

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
otherwise builds, checks and publishes the same release as the automatic path. If a `main` run is building the same
version at that moment, whichever publishes second sees the tag and falls back to a dev build.

### If the release build fails

Publishing is the last step, so a failed run published nothing and created no tag. The version is still unreleased,
and the next `main` run that builds will release it.

- **Flaky failure** (runner or network trouble, a check that passes on retry): open the failed run on the Actions tab
  and click **Re-run jobs**. A re-run builds the same merge commit again and releases it, because `vX.Y.Z` still does
  not exist.
- **Real failure** (the build, smoke test or install check is broken): fix forward. Fix the problem in a normal PR.
  Because `X.Y.Z` is still unreleased, the first `main` run after that merge that passes publishes `X.Y.Z` from the
  fixed commit; nothing else is needed. If the fix belongs in the notes, the fix PR may add its line to the
  unreleased `## [X.Y.Z]` section (it does not change the heading or the version). A new PATCH release PR is only
  needed once `X.Y.Z` has actually been published (next item).
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

| Trigger | Tag | Release name | Kind |
|---|---|---|---|
| Push to `main`; `CHANGELOG.md` has `## [<version>]`; no tag `v<version>` yet | `v<version>` (created by CI) | `ReCut <version>` | Release, marked Latest |
| Push to `main`; `v<version>` already tagged, or no changelog section | `v<version>-dev.<run>` | `ReCut <version>-dev.<run> (Windows test build)` | Prerelease |
| Push to another watched branch, or a manual run (`workflow_dispatch`) | `v<version>-dev.<run>` | `ReCut <version>-dev.<run> (Windows test build)` | Prerelease |
| Push of tag `v<version>` (optional fallback) | `v<version>` | `ReCut <version>` | Release, marked Latest |

Dev prereleases are test builds of unreleased commits. Their `<version>` is the last released version (the version
in `package.json` on that commit), so `0.2.0-dev.57` is a build made after 0.2.0, not before it. Users should install
the release marked **Latest**.

The workflow only runs for plain semver tags (`v[0-9]+.[0-9]+.[0-9]+`), so the `-dev.` tags it creates for
prereleases never start another build. The `v<version>` tag of an automatic release does match that pattern, but it
is created with the workflow's `GITHUB_TOKEN`, and tags created with `GITHUB_TOKEN` do not trigger workflows, so it
does not start a second build either. Documentation-only pushes to a branch skip the build (`paths-ignore`), but GitHub does not evaluate path
filters for tag pushes, so a release tag always builds.

Before this standard, CI published every branch build as `v0.1.0-win.<run>` ("ReCut 0.1.0 for Windows (build N)").
Those prereleases and tags still exist. The owner may delete them from the GitHub Releases page; agents must not.
