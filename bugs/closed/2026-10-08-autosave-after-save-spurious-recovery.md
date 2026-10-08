# An autosave in flight during a save lands after it: recovery is offered after a clean save + quit

| Field | Value |
|---|---|
| Status | fixed |
| Severity | medium |
| Area | project I/O (autosave / recovery) |
| Reported by / date | fix-recovery agent, 2026-10-08 (seen in CI) |
| Found on commit | f02e248 (main); CI run https://github.com/jelloshooter848/ReCut/actions/runs/37807721307, job "End-to-end tests on Windows" |
| Environment | Windows CI runner (e2e, source build); reproduced on Linux 6.18, Node 22.22.0, Electron under xvfb |

## Report

### Summary
After a clean save followed by quit, the next launch sometimes opens "Recover unsaved changes?" for the project that
was just saved. Intermittent, timing-dependent; seen on the Windows e2e job, where the recovery dialog then blocked
the rest of the gauntlet (a `dialog-backdrop` intercepted clicks, the Export dialog never opened).

### Steps to reproduce
1. New project, a few edits (the project is untitled and dirty).
2. Save it (`actions.saveProject(path)`) while an autosave of the project is still being serialized / written.
3. Quit (nothing to save), relaunch.

Deterministic repro: tests/e2e/lifecycle.spec.ts "a clean save + quit while an autosave is still being written offers
no recovery on relaunch" (holds `requestIdleCallback` so the autosave is mid-serialization when the save runs), and
tests/unit/autosave-save-race.test.ts.

### Expected
No recovery prompt: the project file holds everything.

### Actual
CI (gauntlet TEST 1): `no spurious recovery prompt after a clean save+quit | expect(received).toBe(expected) |
Expected: 0 | Received: 1`.

### Evidence
CI log timestamps: last edit (crossfade) 16:20:48.31, save done 16:20:51.04. The lifecycle's first autosave of the
session comes due at once (`lastAutosaveAt` starts at 0, so the 60 s interval tick fires as soon as the project is
dirty) and waits only for the autosave gate's 2 s quiet period: ~16:20:50.3, the moment of the save.

### Suspected cause (hypothesis)
Saves and autosaves run on separate queues (src/state/mediaActions.ts `saveQueue`, `autosaveQueue`); nothing orders
an autosave's write against a save.

### Scope
Any project: for a never-saved project the untitled autosave (offered whatever its age); for a saved project its
`<project>.autosave` when it lands more than 1 s after the project file.

---

## Verification

| Field | Value |
|---|---|
| Verified by / date | fix-recovery agent, 2026-10-08 |
| Verified on commit | f02e248 |
| Verdict | confirmed |

The new e2e test fails on f02e248 exactly like CI: after relaunch `recut.checkRecovery()` returns
`{ autosavePath: ".../userData/autosave/untitled.recut.autosave", projectName: "Race Cut", projectPath: null, ... }`.
The unit tests in tests/unit/autosave-save-race.test.ts fail on f02e248 (5 of 10; the other 5 guard the fix against
dropping autosaves it must keep).

---

## Resolution

| Field | Value |
|---|---|
| Closed by / date | fix-recovery agent, 2026-10-08 |
| Fix | branch `claude/fix-recovery-after-clean-quit` |
| Files changed | src/state/mediaActions.ts, electron/project/io.ts, tests/unit/autosave-save-race.test.ts, tests/e2e/lifecycle.spec.ts |
| Regression test | tests/unit/autosave-save-race.test.ts (all); tests/e2e/lifecycle.spec.ts::a clean save + quit while an autosave is still being written offers no recovery on relaunch |

### Root cause
A clean save does not delete the project's autosave; recovery relies on ordering instead: a `<project>.autosave`
is offered only when more than 1 s newer than the project file, and the untitled autosave (never-saved project) is
dropped by main right after the save writes the file (electron/ipc.ts `afterSave` -> `clearUntitledAutosaveForId`)
and otherwise offered whatever its age. But an autosave and a save were not ordered at all. The ordering that hit CI:

1. The project is untitled and dirty. The lifecycle starts an autosave (snapshot at revision R, target: the untitled
   autosave); it streams to main while it serializes in idle slices.
2. The save starts (snapshot at revision R too), writes the project file, and main drops the untitled autosave
   (there is none yet, or an older one).
3. The autosave reaches its commit and renames its temp file over the untitled autosave path: an autosave of
   exactly the saved content, written after the save.
4. `markSaved` clears `dirty`; quit has nothing to ask; the next launch offers the untitled autosave.

The same happens when the autosave's commit is already being processed by main when the save starts (main runs
both concurrently), or when the autosave starts *during* the save (the project is still dirty until `markSaved`).
For a project saved before, the stale `<project>.autosave` is offered when it lands > 1 s after the save (slow
idle slices / disk). Windows makes it likelier (slower idle slices, the gauntlet's timing), but it is not
Windows-specific: the e2e repro fails on Linux.

### Fix
src/state/mediaActions.ts orders a save against autosave writes, by what each one holds (store `revision` /
`loadedRevision` / project id):
- `saveNow` first waits for an autosave write main is already doing (`autosaveWriting`), then snapshots the project
  in the same task and publishes what it writes (`savingNow`), and `lastSaved` once it succeeded.
- An autosave's write (the commit of a streamed autosave, the one IPC call otherwise; `writeAutosaveFile`) waits
  while a running save holds its content, and is dropped (a streamed autosave aborts its temp file) when a save
  wrote that content. An autosave of edits newer than every save is still written at once, as before, so nothing
  that is not in the project file is ever dropped, and a save is never held up by an autosave's serialization.

Hardening in main (electron/project/io.ts): removing an autosave (`clearUntitledAutosaveForId`, `discardRecovery`)
is retried on Windows EPERM / EACCES / EBUSY with the existing rename rule (`RENAME_RETRY`, a scan holding the
just-written file), and a removal failing other than ENOENT is logged instead of silently swallowed: a left-behind
untitled autosave is exactly what produces this prompt.

### Before / after
Before: an autosave in flight at save time could land after the save, and the next launch offered it. After: it
lands before the save (and the save drops it) or is not written; recovery after a clean save + quit offers nothing.
Real crashes are unchanged: edits not in the project file are autosaved and offered (tests below).

### Regression test proof
On f02e248 (fix stashed):
```
× ... (streamed writes) > an autosave already being written by main when the save starts lands before the save
× ... (one-string writes) > an autosave already being written by main when the save starts lands before the save
× streamed autosave serialized while a save runs > an autosave that snapshotted the project before the save and commits after it is dropped (no temp file left)
× streamed autosave serialized while a save runs > the same for a project saved before: its <project>.autosave is not left newer than the project file
× Windows: the save cannot remove the untitled autosave at once ... > the removal is retried, so the autosave is not left to be offered
Tests  5 failed | 5 passed (10)

✘ lifecycle.spec.ts › a clean save + quit while an autosave is still being written offers no recovery on relaunch
  Error: no spurious recovery prompt after a clean save+quit — expect(received).toBeNull()
  Received: {"autosavePath": ".../userData/autosave/untitled.recut.autosave", "projectName": "Race Cut", "projectPath": null, ...}
```
With the fix: 10/10 and the e2e test pass.

### Tests run
- `npm run typecheck`: clean.
- `npm test`: 112 files, 1949 passed, 2 skipped.
- e2e (Linux, xvfb): lifecycle.spec.ts 9/9 and project.spec.ts 8/8; gauntlet TEST 1 (17/17 steps) and TEST 4
  failure recovery (11/11 steps).

### Changed existing assertions
None.

### Compatibility risks
None for files: formats and paths are unchanged. A save may now wait for an autosave commit main is already
writing (one rename + fsync).

### Follow-ups
None.
