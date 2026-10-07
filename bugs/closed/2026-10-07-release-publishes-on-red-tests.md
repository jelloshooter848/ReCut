# Windows workflow publishes releases while the unit or end-to-end jobs are red

| Field | Value |
|---|---|
| Status | fixed |
| Severity | high |
| Area | packaging / CI release |
| Reported by / date | owner, 2026-10-07 |
| Found on commit | f99a967 (merge of PR #38, release 0.3.0) |
| Environment | GitHub Actions, `.github/workflows/windows.yml`, `windows-latest` runners |

## Report

### Summary
Stable releases (and dev prereleases) are published even when a release-gating test suite is red. v0.3.0 was
published while the Windows end-to-end job was failing. Users get a "Latest" release that did not pass its own tests.
Owner's requirement: "Stable releases must not publish while any required release-gating test suite is red."

### Steps to reproduce
1. Push a commit to `main` (or any watched branch) on which a Windows unit or end-to-end test fails.
2. Watch the "Windows build" run.
3. The `installer` job publishes the release or dev prerelease; the run's failing test job does not stop it.

### Expected
Nothing is published, neither a release nor a dev prerelease, unless the build, smoke and install checks, the Windows
unit tests, the Windows end-to-end tests and the launcher check have all passed.

### Actual
v0.3.0 was published at 00:56:16 UTC on 7 October 2026 by run #72 (id 37553737364, commit f99a967): the `installer`
job's "Publish GitHub Release" step completed at 00:56:16. The `e2e` job ("End-to-end tests on Windows") finished
red at 00:58:13 (`npx playwright test` step failed), two minutes after the release was out.

The e2e suite has been red on every run since run #51 (PR #18), and the Windows unit job was red on run #64. All of
this was hidden by `continue-on-error: true`: the runs showed as successful and kept publishing.

### Evidence
`gh run view 37553737364 --json jobs` (run #72):

```
Start ReCut.cmd from a fresh clone   success  00:54:02Z
Unit tests on Windows                success  00:55:17Z
End-to-end tests on Windows          failure  00:58:17Z  playwright step failure @ 00:58:13Z
Installer + portable exe             success  00:56:19Z  Final release check @ 00:56:06Z, Publish GitHub Release @ 00:56:16Z
```

### Suspected cause (hypothesis)
In `.github/workflows/windows.yml`:
- `tests` and `e2e` have `continue-on-error: true`, so their failure never fails the run;
- the "Final release check" and "Publish GitHub Release" steps run inside the `installer` job, which does not depend
  on `tests`, `e2e` or `launcher`, so publishing can happen before those jobs finish, and regardless of their result.

### Scope
Every run of the workflow: automatic releases on `main`, the manual tag fallback, and dev prereleases
(`v<version>-dev.<run>`) on `main`, other watched branches and `workflow_dispatch`.

---

## Verification

| Field | Value |
|---|---|
| Verified by / date | Claude agent, 2026-10-07 |
| Verified on commit | f99a967 |
| Verdict | confirmed |

Confirmed from the workflow file at f99a967 and from run #72's job timings (above): the publish steps are in the
`installer` job with no `needs`, and both test jobs carry `continue-on-error: true`. The suspected cause is correct.

---

## Resolution

| Field | Value |
|---|---|
| Closed by / date | Claude agent, 2026-10-07 |
| Fix | branch `claude/release-gate` (PR pending) |
| Files changed | `.github/workflows/windows.yml`, `docs/RELEASING.md`, `docs/INSTALL.md`, `docs/LIMITATIONS.md`, this report |
| Regression test | gate-proof run: `workflow_dispatch` of `.github/workflows/windows.yml` on throwaway branch `claude/gate-proof` (a deliberately failing e2e test, `tests/e2e/program.spec.ts` "gate proof: must fail") |

### Root cause
Publishing was a step of the build job instead of a job that depends on the test jobs, and the test jobs were allowed
to fail (`continue-on-error: true`), so neither ordering nor result tied publishing to the tests.

### Fix
- New final job `publish` with `needs: [installer, tests, e2e, launcher]` and
  `if: github.event_name != 'pull_request'` (no `always()`/`failure()`/`cancelled()`, so the implicit `success()`
  applies: a failed, cancelled or skipped gate skips it). It checks out (for `git ls-remote`), downloads the
  `ReCut-windows` artifact into `release/`, downloads the `release-notes` artifact, and runs the existing "Final
  release check" and "Publish GitHub Release" steps unchanged except that their inputs come from
  `needs.installer.outputs` (`target_commitish: ${{ github.sha }}` kept). Permissions: `contents: write`.
- The `installer` job keeps build, smoke test, install check, the `ReCut-windows` upload and the "Release metadata"
  step, and exposes `auto`, `tag`, `name`, `prerelease`, `latest`, `notes`, `dev_tag`, `dev_name`, `dev_notes` as job
  outputs. The two publishing steps were removed from it.
- Release notes cross jobs as files: the metadata step writes `release-notes.md` and `dev-notes.md` (same content
  and encoding as before) into `$RUNNER_TEMP/release-notes/`, which is uploaded as the `release-notes` artifact and
  downloaded by `publish`. `notes` / `dev_notes` outputs are the file names in that artifact. The bytes
  `softprops/action-gh-release` reads are the bytes the metadata step wrote.
- `continue-on-error: true` removed from `tests` and `e2e`.
- Triggers, `paths-ignore`, concurrency, `installer-stress`, `launcher` and all timeouts are unchanged.

This gates dev prereleases too (owner's decision): any red required job means nothing is published.

### Before / after
- Before: run #72 published v0.3.0 at 00:56:16 while `e2e` went red at 00:58:13; the run showed green.
- After: `publish` starts only after all four gates finish successfully. A red `e2e` (or `tests`, `launcher`,
  `installer`) fails the run and skips `publish`: no release, no prerelease, no tag.

### Regression test proof
Pending coordinator's gate-proof run (`workflow_dispatch` on `claude/gate-proof`; expected: `e2e` red, `publish`
skipped, no `v<version>-dev.<run>` release or tag created).

### Tests run
- `actionlint` 1.7.12 on `.github/workflows/windows.yml`: no findings (it type-checks the `needs.installer.outputs.*`
  and `steps.*.outputs.*` references).
- YAML parsed with PyYAML and compared job by job with the previous file: `on`, `concurrency`, `permissions`,
  `launcher` and `installer-stress` identical; `tests` and `e2e` identical apart from `continue-on-error`; the two
  publish steps identical apart from their inputs.
- `npm run typecheck`: passes. `npm test`: 1150/1150 (61 files). The workflow change does not affect them.

### Changed existing assertions
None.

### Compatibility risks
- The e2e suite has been red on Windows since run #51, so until it is fixed every run fails and nothing is published,
  including dev prereleases. That is the intended behaviour, but it means no new Windows builds until it is green.
- One extra job (and one Windows runner start, about a minute) per run.
- Release names, tags, notes and attached files are unchanged.

### Follow-ups
- The Windows end-to-end failures since run #51 (PR #18) and the unit failure seen on run #64 need their own reports;
  they now block every publish.
