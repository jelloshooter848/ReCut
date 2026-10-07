# Windows e2e: three Program Monitor tests fail on every main run since PR #18

| Field | Value |
|---|---|
| Status | fixed |
| Severity | medium |
| Area | tests (e2e, playback) |
| Reported by / date | coordinator agent (bisect of Windows CI runs), 2026-10-07 |
| Found on commit | f99a967 (main, run #72); first failing commit 2e4ffb8 (merge of PR #18, run #51) |
| Environment | GitHub Actions `windows-latest`, job "End-to-end tests on Windows" (`.github/workflows/windows.yml`), Electron from source via Playwright, FFmpeg from `scripts/windows/get-ffmpeg.ps1` |

## Report

### Summary
The Windows end-to-end job has failed on every push to main since PR #18 (6 Oct). `continue-on-error: true` on the
job hid it. The same three tests in `tests/e2e/program.spec.ts` fail every time. The same suite passes on Linux under
xvfb. No user-facing behaviour is wrong: the failing assertion encodes a canvas size from before PR #18.

### Steps to reproduce
1. Push to main (or dispatch `windows.yml`) and open the "End-to-end tests on Windows" job.
2. Or on Linux, reproduce the same failure set by giving the monitor less room: in the original spec, change
   `w.setSize(1600, 1000)` (line 48) to `w.setSize(1200, 700)` and run
   `xvfb-run -a npx playwright test -c tests/e2e/playwright.config.ts tests/e2e/program.spec.ts`.

### Expected
All four Program Monitor tests pass on Windows, as they do on Linux.

### Actual
Run #72 (f99a967), and the same in every main run from #51 on:

```
1) tests\e2e\program.spec.ts:44:7 › Program Monitor › renders, plays, seeks and marks in/out
   Expected: 960
   Received: 913
   > 171 |     await expect.poll(() => page.evaluate((sel) => (document.querySelector(sel) as HTMLCanvasElement).width, CANVAS)).toBe(960);
2) tests\e2e\program.spec.ts:179:7 › Program Monitor › Play In to Out stops at Out when Loop is off (E-15)
   Expected: true  Received: false
   > 188 |     await expect.poll(() => getState<boolean>(page, '(s) => s.playback.playing')).toBe(true);
3) tests\e2e\program.spec.ts:236:7 › Program Monitor › a cut between two clips of one file reuses the pooled element and lands on the right frame
   Expected: true  Received: false
   > 269 |       await expect.poll(async () => { prev = sig; ...; return sig === prev && sig.split(',').some((v) => Number(v) > 20); }, ...).toBe(true);
3 failed, 49 passed (4.0m)
```

### Evidence
- Bisect over `windows.yml` runs on main: the last green e2e job is run #50 (PR #17, 88370fc, run id 37407538730).
  The first failing one is run #51 (PR #18, 2e4ffb8, run id 37413304972). Every later main run fails the same three
  tests (checked #64 and #72).
- PR #18 (commit f68fa0d, "cap canvas to display") caps the Program canvas at the monitor's on-screen size:
  `src/panels/program/ProgramPanel.tsx:258-262` calls `setDisplaySize(box.w * dpr, box.h * dpr)` with the
  letterboxed `.pm-video` box. `src/playback/sequencePlayer.ts:847-848` scales the canvas by
  `s = min(1, cap.w / w, cap.h / h)`.

### Suspected cause (hypothesis)
1. At :171 the maximized monitor box on the Windows runner is about 514 px tall, so 1/2 resolution (960x540) is
   capped to 913x514. The window set at :48 is smaller there than on xvfb (frame, title bar, and possibly the
   runner's screen size).
2. The other two are knock-ons. The spec shares one app via `test.beforeAll(launchApp)`, not in serial mode, with
   `workers: 1, retries: 0`. When :44 fails, Playwright restarts the worker, and `beforeAll` launches a fresh app
   with an empty project. :179 then has nothing to play. :236 (added in PR #18) relies on the clips "from the
   first test" (comment at :240), so its sampled quadrant stays black.

### Scope
Any e2e assertion of a hard-coded Program canvas size. A search of `tests/e2e` found only program.spec :171. The
gauntlet reads canvas brightness only, and `tests/perf/electron-perf.mjs` asserts no sizes. Any test that relies
on state left by an earlier test in a shared-app spec has the same cascade risk.

---

## Verification

| Field | Value |
|---|---|
| Verified by / date | Claude (agent), 2026-10-07 |
| Verified on commit | f99a967 (origin/main) |
| Verdict | confirmed (mechanism); the cause of the smaller Windows box is partly revised, see below |

- The run #50 e2e job succeeded, and the run #51 and #72 e2e jobs failed, per the GitHub Actions job lists. The run
  #72 log shows the three failures above, with `Received: 913`.
- I reproduced the exact Windows failure set on Linux by shrinking the window in the original spec
  (`setSize(1200, 700)`): `:44` failed with `Expected: 960, Received: 945`, `:179` failed at :188 and `:236` failed
  at :269, while `:197` passed. This confirms that the cap at :171 is the primary failure and the other two are
  the worker-restart cascade.
- Partial correction to the hypothesis: the requested window size is not honoured on either platform. Under
  `xvfb-run` (1280x1024 screen) the window is clamped to the screen: content 1279x996, outer 1279x1023 (logged by
  the new spec). The maximized monitor box there is 1271x714, so 1/2 resolution is uncapped. On Windows the box is
  about 200 px shorter than on xvfb, which is more than a title bar. Most likely the runner's smaller display clamps
  the window as well, with the frame and menu bar taking the rest. The spec now logs the content, outer and
  work-area sizes, so the coordinator's Windows run will show the actual numbers. The fix does not depend on which
  of these it is.

---

## Resolution

| Field | Value |
|---|---|
| Closed by / date | Claude (agent), 2026-10-07 |
| Fix | branch `claude/fix-win-program-e2e` (commit 15562ab and the commit adding this file) |
| Files changed | `tests/e2e/program.spec.ts`, `tests/unit/open-freeze.test.ts` (run #64 unit-test timeout, see Follow-ups) |
| Regression test | `tests/e2e/program.spec.ts::Program Monitor › renders, plays, seeks and marks in/out` (exact capped-size checks); the other three Program Monitor tests are now self-contained |

### Root cause
The test, not the app. PR #18 intentionally capped the canvas at the on-screen monitor size, but the spec kept the
uncapped 960 px expectation. That only held where the maximized monitor box is at least 960x540, as it happens to
be under xvfb. Two later tests also depended on state left by the first one, so its failure cascaded.

### Fix
`tests/e2e/program.spec.ts` only, with no app code changes:
- `canvasSizes()` / `expectCanvasSize()` compute the expected canvas size from the live monitor box, the same way
  the app does. That means `fitBox` of the `.pm-video` rect (floored), times `devicePixelRatio`
  (`setDisplaySize`, rounded), then `min(1, cap.w / w, cap.h / h)` on sequence size × playback resolution, each side
  rounded, minimum 2. The helper asserts exact equality and that height/width stays within one pixel of the
  sequence aspect ratio. A failed poll prints every input of the computation.
- The size is checked three times:
  - Docked at full resolution: always capped, and the test asserts `capped` and `width < 1920`, so the capped
    branch runs on every platform.
  - Maximized at 1/2 resolution: this replaces `toBe(960)`. Uncapped it must be exactly 960x540; capped it must
    be the computed value and below 960.
  - Docked again after un-maximizing: the canvas must follow the smaller box.
- Window chrome: `beforeAll` sets the window's content size, not its outer size, and logs content, outer and
  work-area sizes. The assertions do not depend on the window size. The window was not enlarged.
- No cascade: every test starts with `newProject()` (dirty cleared, so no prompt), imports movie 1 and inserts its
  own clips (`freshProjectWithMovie`, `insertTwoRanges`, `twoClipProject`). The still-image test now also has video
  under the image, as it did when run after the first test. The cut test settles on the first clip, then counts
  `<video>` creation across the cut. This is stricter than before, since the second clip's element is no longer
  pre-created by an earlier test. The test also restores `document.createElement` afterwards. It samples the
  whole frame now that no image covers part of it. No retries or serial mode were added.

### Before / after
- Before, Windows: `:171` expected 960, got 913, and `:179` and `:236` failed on the empty project after the
  worker restart.
- Before, Linux with a small window (1200x700): the same three failures (945 instead of 960).
- After, Linux at the default size: docked 315x177 (capped, box 315x177), maximized 1/2 960x540 (uncapped, box
  1271x714), docked again 315x177. 4/4 passed.
- After, Linux with a small window (temporary local tweak, `setContentSize(1200, 640)`, not committed): maximized
  1/2 945x532 (capped, box 945x532). 4/4 passed, so the capped branch of the 1/2 check was exercised.
- After, with an injected failure at the start of test 1 (temporary): test 1 failed, and `:179`, `:197` and `:236`
  passed on the fresh worker.

### Regression test proof
The original spec with a smaller window fails `:171` with `Expected: 960, Received: 945`, plus the two cascades.
The new spec passes at both window sizes and keeps passing the other tests when the first one fails (see Before /
after).

### Tests run
- Linux: `npm run typecheck` clean; `npm test` 61 files, 1150/1150 passed.
- Linux: `xvfb-run -a npm run test:e2e -- tests/e2e/program.spec.ts` twice, 4/4 passed both times. Extra runs:
  small window 4/4 passed; injected first-test failure 1 failed + 3 passed; original spec with small window 3
  failed + 1 passed.
- Windows: run #74 (id 37557931999, `workflow_dispatch` on `claude/gate-verify` = this branch + the release-gate
  workflow): "End-to-end tests on Windows" **52 passed** (3.2 min), "Unit tests on Windows" passed. First green
  Windows e2e run since #50.

### Changed existing assertions
- `program.spec.ts:171`: `canvas.width === 960` became "equals the computed capped size". This is exact 960x540
  when the monitor is big enough, and the computed value with an aspect check otherwise. The old assertion encoded
  the pre-PR #18 behaviour, uncapped.
- `program.spec.ts:236`: the signature samples the whole frame instead of the bottom-right quarter, because the
  still image from the previous test is no longer there. The `<video>` counter now starts after the first clip has
  loaded rather than at the start of the test.

### Compatibility risks
None. Tests only; no app, project-file or export change.

### Follow-ups
- Windows CI run #64 (id 37506434883, PR #30), job "Unit tests on Windows":
  - What failed: `tests/unit/open-freeze.test.ts > opened project: idle freeze > freezes children before parents`
    timed out at 5000 ms (5246 ms), with 1 failed and 1065 passed. The same job passed in runs #50, #51 and #72.
  - Classification: a load-dependent flake in the test, not a Windows path issue and not an app bug.
  - Cause: the freeze walk is cut into 8 ms wall-clock slices, and the test walks the whole ~36k-clip project at
    every slice boundary. On a slower or busier machine it gets more slices, and each check is slower, so the cost
    grows with the square of the slowdown. In that run `time-critic.test.ts` was using 35 s of CPU in parallel.
  - Fix: the test now uses a virtual `performance.now` (1 ms per read). Every slice is then ~2k walk steps on any
    machine, deterministically 15 slices with a 300-clips-per-track project, and the test asserts at least 10
    checks. It runs in ~0.1 s instead of ~1.4 s locally. I mutation-checked it: freezing a parent before its
    children makes it fail (`brokenInvariant` 11, expected 0).
- `.github/workflows/windows.yml` still has `continue-on-error: true` on the `tests` and `e2e` jobs. Another agent
  is removing it; this branch does not touch the workflow.
