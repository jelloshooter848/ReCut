# Opening a project fails on Windows when the recent-list write collides with a prefs read

| Field | Value |
|---|---|
| Status | fixed |
| Severity | medium |
| Area | project I/O (open / save, preferences) |
| Reported by / date | relaunch-investigation agent, 2026-10-07 |
| Found on commit | f29a574 (branch `claude/s2-integration`); the same code is on main (a718aa9) |
| Environment | Windows Server (GitHub Actions `windows-latest`), Electron e2e, source build. Mechanism reproduced on Linux 6.18 by emulating the Windows rename rule |

## Report

### Summary
Opening a project (launch with `--project`, a double-clicked `.recut`, File › Open, Open Recent) failed now and then
on Windows with "Open failed: Error invoking remote method 'project:load': Error: EPERM: operation not permitted,
rename '…\.prefs.json.tmp-…' -> '…\prefs.json'". The project was fine; only the update of the recent-projects list
failed, and that failure was returned as the result of the open. A save could likewise be reported as failed
after the project file had been written.

### Steps to reproduce
1. Windows. Launch ReCut with `--project <file>.recut` (what the e2e gauntlet does after "save, quit, relaunch").
2. During startup the renderer requests AppInfo (main reads `prefs.json` for the cache folder), checks for recovery
   (reads `prefs.json`) and loads its shortcuts / layout (reads `prefs.json`), while the open adds the project to
   the recent list (reads `prefs.json`, writes a temp file, renames it over `prefs.json`).
3. When the rename lands while one of those reads still has `prefs.json` open, Windows refuses the rename (EPERM).

Repro on Linux: `tests/unit/prefs-concurrency.test.ts` emulates the Windows rule on `fs.promises` (a rename onto
`prefs.json` fails while a read of it is in flight).

### Expected
The project opens. The recent list is a convenience: failing to update it must not fail the open or the save.

### Actual
Windows CI run #82 (job "End-to-end tests on Windows"), `tests/e2e/gauntlet.spec.ts` TEST 2, step "Close and
relaunch with `--project`":
```
05:23:41.50 PASS (API) Save the project
05:24:12.78 FAIL Close and relaunch with `--project` …: Expected: "C:\Users\RUNNER~1\…\station-eleven-fan-edit.recut"
            Received: null — Timeout 30000ms exceeded while waiting on the predicate
05:24:12.83 WORKAROUND (actions.openProject(path) returned ok=true right away)
```
The app started (close + relaunch took about 1.3 s, like TEST 1's identical step), `projectPath` stayed null for
30 s, and a second open of the same file succeeded at once: the first open was refused, not stuck.

### Evidence
Emulating the Windows rename rule in `electron/project/io.ts` (rename onto `prefs.json` throws EPERM while a
`readPrefs` is in flight; reads held 15 ms), built, then 10 launches with `--project` of the TEST 2 project:
- before the fix: 8 of 10 launches ended with `projectPath=null`, title "Untitled Project — ReCut" and the toast
  "Open failed: Error invoking remote method 'project:load': Error: EPERM: operation not permitted, rename
  '…/userData/.prefs.json.tmp-…' -> '…/userData/prefs.json'"; the reader in flight was `resolveCacheDir` (the
  renderer's `appInfo()` request from `initApp`), the writer `addRecentProject` in the `project:load` handler;
- after the fix: 10 of 10 opened the project.
Without the emulation (Linux rename never refuses), 0 of 8 launches failed.

### Suspected cause (hypothesis)
`electron/ipc.ts` `project:load` awaited `io.addRecentProject` and let its error reject the open; `afterSave` did the
same for saves. `electron/project/io.ts` let every caller read and replace `prefs.json` at the same time.

### Scope
Every `prefs.json` writer: recent list (open, save, clear, remove), window bounds (`rememberBounds`), the renderer's
`setPrefs` (shortcuts, layout, cache folder). Overlapping read-modify-write updates could also drop each other's
change on any OS (e.g. window bounds written over a just-added recent project).

---

## Verification

| Field | Value |
|---|---|
| Verified by / date | relaunch-investigation agent, 2026-10-07 |
| Verified on commit | f29a574 |
| Verdict | confirmed (mechanism reproduced under emulation; the Windows rename rule itself was not run on Windows here) |

Ruled out for the CI failure: a dirty store at startup (a fresh launch is clean, so `confirmDiscardIfDirty` shows no
prompt); a stale recovery autosave (the TEST 2 temp folders hold none, and recovery cannot clear `projectPath`
without a click); the single-instance lock (a refused instance quits without a window, so `launchGauntlet` would
have retried after 5 s, not returned in 1.3 s); the open request being lost between `did-finish-load`, the preload
buffer and `setOpenProjectPathHandler` (each ordering replays it; 8/8 local relaunches opened within 10 ms of the
renderer being ready). Nothing in §2 touches this path; the code is the same on main.

---

## Resolution

| Field | Value |
|---|---|
| Closed by / date | relaunch-investigation agent, 2026-10-07 |
| Fix | branch `claude/s2-integration`, the commit that adds this file |
| Files changed | `electron/project/io.ts`, `electron/ipc.ts`, `tests/unit/prefs-concurrency.test.ts` |
| Regression test | `tests/unit/prefs-concurrency.test.ts` (5 tests) |

### Root cause
A best-effort side effect (the recent list) was on the success path of open and save, and prefs.json was read and
replaced concurrently. On Windows a rename over a file another handle has open fails, so a prefs read in flight
made the recent-list write fail, and the open with it.

### Fix
- `electron/project/io.ts`: all prefs operations of the process (`readPrefs`, `writePrefs`, `updatePrefs`,
  `addRecentProject`, `removeRecentProject`, `clearRecentProjects`, `existingRecentProjects`) run one at a time
  through one queue; a read-modify-write is one queued operation. No read of ours is ever open while we rename,
  and concurrent updates no longer lose each other's changes. A failed operation does not block the next one.
- `electron/ipc.ts`: `noteRecent` updates the recent list for open and save and logs a failure instead of
  returning it; `project:load` and the save handlers report what happened to the project file only.

### Before / after
Emulated Windows rename rule, 10 launches with `--project`: 8 failed opens before, 0 after.

### Regression test proof
On f29a574 (fix reverted): 3 or 4 of 5 tests fail (`reads and updates that overlap never rename over an open
prefs.json…`: EPERM; `opens the project even when prefs.json cannot be written`; `reports a save that reached the
disk as saved…`; the timing-based `opens the project at launch while the renderer reads prefs` fails in most runs).
With the fix: 5/5 pass (3 of 3 runs).

### Tests run
Linux (xvfb): `npm run typecheck` clean; `npm test` 1223/1223 (66 files); `tests/e2e/gauntlet.spec.ts
--repeat-each 5` 20/20; full e2e suite 62/62. Not run on Windows here (the Windows CI job is the check).

### Changed existing assertions
None.

### Compatibility risks
None for files: prefs.json keeps its format. Prefs reads may wait for a write in progress (milliseconds).

### Follow-ups
- `rememberBoundsSync` (window close, `electron/main.ts`) still writes prefs.json synchronously outside the queue;
  a queued prefs operation still in flight at close could collide with it (its failure is caught and logged; only
  the window bounds are lost). A rename refused by another process (an antivirus scan) is still
  possible for every atomic write on Windows; no retry was added here.
  - **Done** (branch `claude/perf-calibration`, 2026-10-07): the window bounds are kept in memory and written
    through the prefs queue (`io.LayoutPrefsWriter`, one queued read-modify-write of `layout` via
    `io.updateLayoutPrefs`): debounced 500 ms while the window moves, at once when it closes; `will-quit` waits for
    that last write (1 s at most) before the process exits. The close path no longer writes synchronously, so every
    prefs.json write of the process goes through the queue (`atomicWriteFileSync` stays, with the retry below, for
    a future synchronous caller).
  - **Done** (same branch): on Windows an atomic rename (`finishAtomic`, the `.bak` rename in `writeBackup`,
    `atomicWriteFileSync`) refused with EPERM, EACCES or EBUSY is retried after 50, 100, 200 and 400 ms
    (5 attempts, 750 ms at most); other errors and the last failure are thrown as before. Off on other platforms,
    where those errors are permanent.
  - Tests: `tests/unit/prefs-concurrency.test.ts` → "window bounds go through the prefs queue" (4 tests, with the
    emulated Windows rename rule) and "atomic rename retry" (8 tests: fake EPERM / EACCES / EBUSY / ENOSPC renames,
    async and sync).
