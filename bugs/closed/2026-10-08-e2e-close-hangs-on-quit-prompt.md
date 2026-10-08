# e2e teardown hangs: close() meets the Save changes? prompt when a proxy job dirties the project during quit

| Field | Value |
|---|---|
| Status | fixed |
| Severity | high |
| Area | tests (e2e harness) / CI release gate |
| Reported by / date | Claude (agent), 2026-10-08 |
| Found on commit | 679026b (main, 0.8.0 release run #183) |
| Environment | macOS CI runner (End-to-end tests on macOS, a release gate); reproduced deterministically on Linux (xvfb), FFmpeg 6.1.1 |

## Report

### Summary
The 0.8.0 release run #183 (https://github.com/jelloshooter848/ReCut/actions/runs/37819116469) failed in the macOS e2e job:
`source.spec.ts:218` passed (1.1 s), then its `afterAll(() => launched.app.close())` timed out after 120 s, followed by
"Worker teardown timeout": the app never exited. Same failure, same spot, on main run #165 (37775843697, before #84).
About 2 of 7 macOS e2e runs; never seen on Windows or Linux. Nothing was published.

### Steps to reproduce
1. `npm run build`
2. `xvfb-run -a npx playwright test -c tests/e2e/playwright.config.ts teardown.spec.ts` on the old `tests/e2e/helpers.ts`.

### Expected
`close()` (helpers.ts launchApp: "plain close() discards changes") quits the app.

### Actual
`close()` never returns; the app sits on the native "Save changes to … before quitting?" box.

### Evidence
Instrumented `source.spec.ts` (Linux, 3 runs): at the moment of `afterAll`, the AC-3 movie's proxy (auto-started by the
E-08 test's import, 0.3–1 s earlier) is always still running:
`[["Galaxy Saga 1 - A New Dawn.mp4","none"],["Galaxy Saga 0 - HEVC Prequel.mp4","ready"],…,["Galaxy Saga 2 - Dark Tide.mp4","running"]]`.
Its completion (jobsRouter → `store.setProxy`, a quiet change with `{ dirty: true }`) lands at a time that depends on
the runner's encode speed, which is why only the slower macOS runner, and only this spec, hits it.

---

## Verification

| Field | Value |
|---|---|
| Verified by / date | Claude (agent), 2026-10-08 |
| Verified on commit | 679026b |
| Verdict | confirmed |

The quit path, in order:
1. helpers.ts close wrapper: `store.setState({ dirty: false })` in the renderer, then Playwright's close runs
   `app.quit()` in main.
2. main `before-quit`: `quitConfirmed` is false → `preventDefault`, `requestQuit(false)`: sends `ev:beforeQuit` and arms
   the 3 s hung-renderer fallback.
3. renderer `handleBeforeQuit` (src/app/project.ts): `await api.quitAck()` → main clears the fallback (by design: from
   here the renderer owns the quit, as it may ask the user).
4. renderer reads `useStore.getState().dirty`; when true it shows the native Save / Don't Save / Cancel box and waits
   for the user.

A proxy job finishing between 1 and 4 (`setProxy` → `dirty: true`) makes step 4 prompt. Nobody answers in a test and
the fallback is already cleared, so main waits for ever. With the job mirror forced into that window (a renderer
`onBeforeQuit` listener registered after the app's, which runs while the app's handler awaits `quitAck`), the hang
reproduces every time (see Regression test proof).

Not the app's quit path, and not #84: with a clean project at step 4 the quit completes (every other spec, every
platform); the prompt with a dirty project is the intended behaviour (a real user answers it), and the same failure
predates #84 (run #165). #84 changed only save / autosave ordering, which the quit path with a clean project never
reaches. Other awaits in the quit path are bounded: main's `will-quit` window-bounds flush races a 1 s timer, and
`mediaHandlers.shutdown()` is not awaited.

---

## Resolution

| Field | Value |
|---|---|
| Closed by / date | Claude (agent), 2026-10-08 |
| Fix | branch `claude/fix-quit-hang` |
| Files changed | tests/e2e/helpers.ts, tests/e2e/gauntlet-helpers.ts, tests/e2e/project.spec.ts, tests/e2e/teardown.spec.ts (new) |
| Regression test | tests/e2e/teardown.spec.ts › close() quits when a background job marks the project dirty while the quit request is handled |

### Root cause
The e2e harness discarded unsaved changes at close by marking the project clean once, before the quit request. A
background job mirror (a proxy finishing) could mark it dirty again before the renderer read `dirty` for the quit
request, and the app then (correctly) asked Save / Don't Save / Cancel, which no test answers.

### Fix
`discardChangesOnQuit(app)` in tests/e2e/helpers.ts, run before every helper close: it still marks the project clean,
and it also answers the quit prompt "Don't Save" in the main process (`dialog.showMessageBox` wrapped; any other box
goes to the previous implementation), so whatever the project's state when the renderer handles the quit request, the
close discards and quits. Used by launchApp's `close()` (all specs using `launchApp`), gauntlet-helpers `closeApp` and
project.spec's `afterAll`, which had the same mark-clean-then-close pattern. No app code changes: bounding the prompt
with a timeout would quit (or save) behind the user's back.

### Before / after
Before: teardown.spec hangs (fails at its 30 s bound); source.spec's afterAll hung on macOS in ~2/7 runs.
After: teardown.spec passes in 0.9 s; the app exits through the real quit path (renderer handler → "Don't Save" →
`quit(true)`).

### Regression test proof
Old helper:
```
✘ teardown.spec.ts:13:5 › close() quits when a background job marks the project dirty while the quit request is handled
  Error: close() returned within 30 s
  Expected: true
  Received: false
```
New helper:
```
✓ 23 tests/e2e/teardown.spec.ts:13:5 › close() quits when a background job marks the project dirty while the quit request is handled (870ms)
```

### Tests run
`npm run typecheck`: clean. `npm test`: 112 files, 1956 passed, 2 skipped. e2e (Linux, xvfb): teardown 1/1, source 5/5,
lifecycle 9/9, project 8/8, gauntlet 4/4.

### Changed existing assertions
None.

### Compatibility risks
None: test harness only.

### Follow-ups
- gauntlet.spec's mid-test "quit for real and relaunch" steps call the raw `close()` right after a save, on purpose
  (the real quit path). A proxy finishing in the same window would prompt there too; not seen in CI so far, left as is.
- App-side, not causing this failure: once the renderer has acked `ev:beforeQuit`, main has no fallback; if the
  renderer process died after the ack, `quitPending` would stay true and further quit requests would be ignored until
  the window is destroyed.
