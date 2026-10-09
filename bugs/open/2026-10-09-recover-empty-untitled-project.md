# Recovery offers an empty untitled autosave, and Recover marks the blank project unsaved so File › Open asks to save it

| Field | Value |
|---|---|
| Status | open |
| Severity | medium |
| Area | project I/O (autosave, crash recovery, dirty tracking) |
| Reported by / date | James, 2026-10-09 |
| Found on commit | 5ec0fb4 |
| Environment | macOS 26 (Apple Silicon), source build (`npm run dev`), FFmpeg 8.1.3 (jellyfin portable) |

## Report

### Summary
At launch ReCut offers "Recover unsaved changes?" for an untitled project. Clicking **Recover** shows what looks like a
plain new project, as if nothing was recovered. Then **File › Open** asks to save changes to that blank project before
opening the chosen one. A user who changed nothing should not be asked to recover or to save anything.

### Steps to reproduce
1. Run ReCut with an untitled project open, without saving it, and end the session (here: the dev app was stopped
   while running; the exact earlier actions are not known).
2. Launch ReCut. The "Recover unsaved changes?" dialog appears: "Recover unsaved changes from 10/9/2026, 10:37:59 AM?
   ReCut found an autosave for an unsaved project that is newer than the last save."
3. Click **Recover**.
4. Choose **File › Open…** and pick a project.

### Expected
- Step 2: no recovery prompt when the autosave holds nothing a user made (an empty "Untitled Project").
- Step 3: if recovery is offered and accepted, the recovered work is visible.
- Step 4: with no changes made since launch, the chosen project opens without a "Save changes?" prompt.

### Actual
- Step 3: an empty project (no media, an empty Sequence 01), the same as a new project. See the screenshot.
- Step 4: "Save changes to "Untitled Project"…?" (Save / Don't Save / Cancel) before the chosen project opens.

### Evidence
The autosave on disk after these steps, `~/Library/Application Support/ReCut/autosave/untitled.recut.autosave`
(2686 bytes), is an empty project:

```
name: Untitled Project   media: 0   sequences: 1 (empty)   scenes: 0   subtitleTracks: 0
createdAt: 1791566248908   modifiedAt: 1791567966387
```

So **Recover** most likely did load the autosave correctly; the autosave itself was empty.

### Suspected cause (hypothesis)
Not verified. Read from the code on 5ec0fb4:

1. **An empty untitled autosave is offered on every launch.** `checkRecovery` (`electron/project/io.ts:603`) offers
   `untitled.recut.autosave` whenever it exists and is non-empty (`recoveryFrom`, `io.ts:584`). Unlike project-backed
   autosaves (`io.ts:619`), there is no newer-than check, and nothing checks whether the project has any content. The
   prompt's text "newer than the last save" (`src/app/project.ts:257`) is not checked for this case.
2. **Recover always marks the project dirty.** `checkStartupRecovery` calls `loadProjectData` and then
   `useStore.setState({ dirty: true })` (`src/app/project.ts:274-276`) unconditionally. So a recovered empty project
   counts as unsaved, File › Open, File › New and Quit ask "Save changes?" (`confirmDiscardIfDirty`,
   `project.ts:103-114`), and autosave rewrites `untitled.recut.autosave` (`project.ts:215`, `:336`).
3. **The untitled autosave is not cleaned up.** It is deleted only by Discard (`io.ts:634`) or by saving the same
   project id (`electron/ipc.ts:320`), not by Recover, Don't Save on quit, or File › New. Quitting with Don't Save after
   step 3 leaves it, so the prompt can come back on every launch.
4. **How the empty project became dirty in the first place** is unknown. Candidates: undo and redo set `dirty`
   unconditionally (`src/state/store.ts:506`, `:515`), so an edit undone back to empty still autosaves; or an earlier
   Recover of the same file (point 2) started the loop. No startup code path was found that dirties a fresh project.

### Scope
- Project-backed autosaves: Recover sets dirty the same way, but those are only offered when newer than the project
  file, so the empty case is less likely.
- File › New and Quit use the same dirty check as File › Open.
- Possible fixes to weigh: do not offer (or delete) an untitled autosave whose project has no content; on Recover,
  set dirty only when the recovered project differs from a fresh project (untitled) or from the file on disk; delete
  the untitled autosave on Don't Save and on New; derive dirty from the undo position.
- Related, closed: `bugs/closed/2026-10-08-job-mirror-marks-saved-project-dirty.md`,
  `bugs/closed/2026-10-08-autosave-after-save-spurious-recovery.md`.

---

## Verification
<!-- Filled in by whoever works the bug. -->

| Field | Value |
|---|---|
| Verified by / date | |
| Verified on commit | |
| Verdict | |

---

## Resolution
<!-- Required before moving the file to bugs/closed/. -->

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
