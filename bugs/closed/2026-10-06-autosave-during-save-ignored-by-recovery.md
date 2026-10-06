# Autosave of edits made during a save is ignored by recovery; next autosave waits for the interval

| Field | Value |
|---|---|
| Status | fixed |
| Severity | low |
| Area | project I/O (autosave / recovery) |
| Reported by / date | save-race agent, 2026-10-06 |
| Found on commit | 41c3031 + fix for bugs/closed/2026-10-06-edits-during-save-marked-saved.md (branch `claude/save-race`) |
| Environment | Linux 6.18, Node 22.22.0, source; found by reading the code, no test yet |

## Report

### Summary
Found while fixing bugs/closed/2026-10-06-edits-during-save-marked-saved.md. An edit made while a manual save is in
flight stays dirty (correct since that fix), and its debounced autosave may already have been written. When that
autosave lands *before* the manual save's write, startup recovery treats it as older than the project file and
ignores it. The next autosave comes only from the interval tick (`autosaveIntervalSec`, default 60 s), because the
debounce is scheduled on commits, not on a save that leaves the project dirty. A crash in that window loses the edit;
without the save, the same edit would be recoverable after at most the 5 s debounce.

### Steps to reproduce
1. Large project, Ctrl+S; while the sliced save runs, make an edit and wait for its debounced autosave (5 s), with
   the manual save's write landing after it (slow disk).
2. Kill the app within 60 s.
3. Restart: no recovery prompt; the edit is gone.

### Expected
A recovery prompt with the edit (or an autosave written right after the save completes with the project dirty).

### Actual
Not reproduced in a test yet; derived from the code below.

### Evidence
- electron/project/io.ts `checkRecovery`: `if (projSt && autoSt.mtimeMs <= projSt.mtimeMs + 1000) continue;`
- src/app/project.ts `initProjectLifecycle`: `scheduleDebouncedAutosave()` only when the history key changes or
  `dirty` goes false → true.

### Suspected cause (hypothesis)
See Evidence. Possible fix: in src/app/project.ts, schedule a debounced autosave when a save resolves with the
project still dirty.

### Scope
Crash recovery only; nothing is lost while the app keeps running (the project stays dirty and the close prompts ask
to save).

---

## Verification

| Field | Value |
|---|---|
| Verified by / date | perf-E agent, 2026-10-06 |
| Verified on commit | 91d0909 (branch `claude/perf-e-edits`, before the fix in it) |
| Verdict | reproduced in a unit test |

tests/unit/autosave-stream.test.ts, "autosave after a save that left edits unsaved": a manual save whose write is held
back, an edit during it, that edit's autosave written before the save's write lands. `checkRecovery` then returns
`null` for the project (the autosave is not more than 1 s newer than the project file), and with the follow-up
disabled no further autosave is written in the 5 s after the save (fake timers), so the edit is only recoverable after
the lifecycle's next interval autosave (60 s by default).

---

## Resolution

| Field | Value |
|---|---|
| Closed by / date | perf-E agent, 2026-10-06 |
| Fix | src/state/mediaActions.ts `autosaveAfterSave` (called from `saveNow`), autosave queue |
| Files changed | src/state/mediaActions.ts, tests/unit/autosave-stream.test.ts |
| Regression test | tests/unit/autosave-stream.test.ts, describe "autosave after a save that left edits unsaved" (3 tests) |

### Root cause
As reported: recovery compares file times (`autoSt.mtimeMs <= projSt.mtimeMs + 1000` skips the autosave), and nothing
autosaved again after a save that left the project dirty, so an autosave that landed before the save's write stayed
the newest one for up to the autosave interval.

### Fix
The suggested place (src/app/project.ts) is outside what this change owns, so the follow-up lives where saves and
autosaves are written (src/state/mediaActions.ts):
- `saveNow`: when a save succeeded but edits were committed while it ran (the project is still dirty at a newer
  revision of the same loaded project), it arms `autosaveAfterSave`.
- `autosaveAfterSave`: `AUTOSAVE_AFTER_SAVE_MS` (5 s, the lifecycle's debounce: past the 1 s recovery slack and FAT's
  2 s mtime resolution) after the save, it autosaves if the project is still dirty, is the same project (id and
  loadedRevision), and no autosave finished at least 3 s after the save meanwhile (that one already holds the edits
  and is newer than the file). Never while playing or during a drag (the lifecycle's rule): it re-arms until those end.
- Autosaves are now queued like saves (one at a time, each snapshots the project when its turn comes), so the
  follow-up and a lifecycle autosave never interleave and the newest content always lands last.

### Before / after
| Case | Before | After |
|---|---|---|
| Edit during a save, its autosave lands before the save's write | recovery ignores it; next autosave at the interval (60 s) | another autosave 5 s after the save; recovery offers it |
| Save with no edits in flight | no extra autosave | unchanged (no extra autosave) |
| Edit during a save, saved again before the follow-up is due | n/a | follow-up skipped (project clean) |
| Playing when the follow-up is due | n/a | waits until playback stops |

### Regression test proof
With the `autosaveAfterSave` call disabled (as before the fix), the new tests fail:
```
 × autosave after a save that left edits unsaved > the edit made during the save is autosaved again after the save, and recovery offers it
 × autosave after a save that left edits unsaved > waits for playback to stop before autosaving
AssertionError: expected [ Array(1) ] to have a length of 2 but got 1
AssertionError: expected [] to have a length of 1 but got +0
      Tests  2 failed | 12 passed (14)
```
After: `tests/unit/autosave-stream.test.ts (15 tests)` all pass.

### Tests run
`npm run typecheck`; `npm test` (53 files, 1086 tests); e2e lifecycle and timeline specs (see the perf-E report).

### Changed existing assertions
None.

### Compatibility risks
- One extra autosave (a background write of the autosave file) 5 s after a save that left edits unsaved.
- Autosaves are serialized: an autosave that never resolves would hold back later ones (as saves already do).

### Follow-ups
- If the lifecycle (src/app/project.ts) is reworked, the follow-up can move there as the report suggested (schedule
  the debounced autosave when a save resolves with the project dirty); the mediaActions timer can then go.
