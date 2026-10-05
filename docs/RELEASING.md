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

1. **Release PR.** Branch from `main` (for example `claude/release-0.3.0`), bump the version and write the
   changelog section (see below). Run `npm run typecheck` and `npm test`. Open the PR and merge it.
2. **Tag the merge commit.** After the merge, find the merge commit on `main` and tag it:

   ```bash
   git fetch origin main
   git log --oneline -3 origin/main          # find the release PR's merge commit
   git tag v0.3.0 <merge sha>
   git push origin v0.3.0
   ```

   Use a plain tag `v<MAJOR>.<MINOR>.<PATCH>`. Nothing else triggers a release.
3. **CI publishes.** `.github/workflows/windows.yml` runs on the tag. It first checks that the tag equals `v` +
   the `package.json` version at that commit and that `CHANGELOG.md` has a `## [<version>]` section, and fails within
   seconds if either is wrong. It then builds, smoke-tests the unpacked app, silently installs the installer and
   smoke-tests the installed app, and only then publishes the release: name `ReCut <version>`, not a prerelease,
   marked **Latest**, body = that version's changelog section plus the install / SmartScreen note, with the
   installer and portable exe attached.
4. Check the release page: both `.exe` files are attached and the notes read correctly.

### If the release build fails

- **Tag does not match the version** (for example the tag was put on the wrong commit before anything was
  published): delete the tag (`git push origin :refs/tags/v0.3.0`, `git tag -d v0.3.0`) and tag the right commit.
  This is only allowed while no release exists for that tag.
- **Build, smoke test or install check fails:** nothing was published. Fix the problem in a normal PR. Then cut a
  new PATCH release (`0.3.1`) with its own release PR and tag. Do not re-tag `v0.3.0` onto the fix.
- **A published release turns out to be broken:** fix it and release the next PATCH version.

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
| Push to a watched branch (`main`, ...) | `v<version>-dev.<run>` | `ReCut <version>-dev.<run> (Windows test build)` | Prerelease |
| Push of tag `v<version>` | `v<version>` | `ReCut <version>` | Release, marked Latest |

Dev prereleases are test builds of unreleased commits. Their `<version>` is the last released version (the version
in `package.json` on that commit), so `0.2.0-dev.57` is a build made after 0.2.0, not before it. Users should install
the release marked **Latest**.

The workflow only runs for plain semver tags (`v[0-9]+.[0-9]+.[0-9]+`), so the `-dev.` tags it creates for
prereleases never start another build. (Tags created with the workflow's `GITHUB_TOKEN` do not trigger workflows in
any case.) Documentation-only pushes to a branch skip the build (`paths-ignore`), but GitHub does not evaluate path
filters for tag pushes, so a release tag always builds.

Before this standard, CI published every branch build as `v0.1.0-win.<run>` ("ReCut 0.1.0 for Windows (build N)").
Those prereleases and tags still exist. The owner may delete them from the GitHub Releases page; agents must not.
