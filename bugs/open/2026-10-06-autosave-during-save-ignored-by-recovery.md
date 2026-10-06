# Autosave of edits made during a save is ignored by recovery; next autosave waits for the interval

| Field | Value |
|---|---|
| Status | open |
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
| Verified by / date | |
| Verified on commit | |
| Verdict | |

---

## Resolution

| Field | Value |
|---|---|
| Closed by / date | |
| Fix | |
| Files changed | |
| Regression test | |

### Root cause

### Fix

### Before / after

### Regression test proof

### Tests run

### Changed existing assertions

### Compatibility risks

### Follow-ups
