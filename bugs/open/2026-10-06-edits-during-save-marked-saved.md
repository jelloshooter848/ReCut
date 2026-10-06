# Edits committed while a save is in flight are marked saved without being written

| Field | Value |
|---|---|
| Status | open |
| Severity | high (silent data loss possible: the app reports the project saved and closes / discards without asking) |
| Area | project I/O |
| Reported by / date | open/save agent (filed by the save-race agent), 2026-10-06 |
| Found on commit | 41c3031 (`claude/perf-c-projectio`, PR #19) |
| Environment | Linux 6.18, Node 22.22.0, source (vitest); not media-related, no FFmpeg involved |

## Report

### Summary
`saveProject` (src/state/mediaActions.ts) serializes a snapshot of the project, then awaits the sliced
serialization (25 ms slices, PR #19) and the IPC write, then calls `markSaved`, which clears `dirty`
unconditionally. Any edit committed in that window is not in the file, but the dirty flag, the `*` in the title and
the close / new / open / quit "Save changes?" prompts all say there is nothing to save. Closing or opening another
project then loses the edit without a prompt.

### Steps to reproduce
Regression test: `tests/unit/save-race.test.ts` (real store + `saveProject`, a `window.recut` whose
`saveProjectJson` resolves only when the test says so).

1. Rename the project to `A` (dirty).
2. Call `saveProject('/p/x.recut')` and wait until the write reaches the mocked IPC.
3. Rename the project to `B` (a committed edit while the write is in flight).
4. Resolve the write.

In the app: save a large project (the sliced serialization makes the window several hundred ms) and make an edit
before the "Saved" toast; then close: no prompt.

### Expected
After step 4 the file holds `A`, the project is still dirty (title keeps `*`), and the next save writes `B`.

### Actual
`dirty` is `false` after step 4 although the file holds `A`. Variants (same test file):
- undo while the save is in flight: dirty `false`, file holds the pre-undo project;
- Save As with an edit in flight: dirty `false`;
- New Project while a save is in flight: the late `markSaved` sets the *new* project's `projectPath` to the old file
  and clears its dirty flag (the next Ctrl+S overwrites the old project with the new one);
- Save pressed twice (edit between): both writes are in flight at once; if the older write lands last, the file
  holds the older content and the project is clean;
- close / new / open prompt (`confirmDiscardIfDirty`) → "Save" → edit during that save: resolves `true` (safe to
  discard), so the caller replaces the project and the edit is gone. `handleBeforeQuit` does the same and quits.

### Evidence
Failing-before output of `npx vitest run tests/unit/save-race.test.ts` on 41c3031:
```
   × an edit after serialization starts keeps the project dirty; the next save writes it
   × an edit right after save is called (before the first slice / IPC) is not marked saved
   × undo while a save is in flight keeps the project dirty
   × Save As with an edit in flight takes the new path but stays dirty
   × a save of a project that was replaced (new project) while in flight does not touch the new one
   × two saves (save pressed twice): an older write never leaves newer content marked saved
   × close-without-saving prompt: "Save" with an edit during the save does not report it safe to discard
 FAIL  ... an edit after serialization starts keeps the project dirty; the next save writes it
AssertionError: expected false to be true // Object.is equality
 FAIL  ... a save of a project that was replaced (new project) while in flight does not touch the new one
AssertionError: expected '/p/x.recut' to be null // Object.is equality
 FAIL  ... two saves (save pressed twice): an older write never leaves newer content marked saved
AssertionError: expected 'A' to be 'B' // Object.is equality
 FAIL  ... close-without-saving prompt: "Save" with an edit during the save does not report it safe to discard
AssertionError: expected true to be false // Object.is equality
      Tests  7 failed | 1 passed (8)
```

### Suspected cause (hypothesis)
- src/state/mediaActions.ts:383 `if (res.ok) useStore.getState().markSaved(res.path);` runs after two awaits
  (lines 380-382) with no check that the project is still the one serialized at line 377.
- src/state/store.ts:445 `markSaved(path) { set({ projectPath: path, dirty: false }); }` clears unconditionally.
- Nothing orders two saves, so their writes can land out of order.
- src/app/project.ts:90 / :267 treat `requestSave() === true` as "nothing left to lose".

### Scope
- Autosave (`autosaveProject`, src/state/mediaActions.ts:460): writes `<project>.recut.autosave` and does not touch
  `dirty` or any "autosaved" marker, so it cannot mark anything saved.
- Save As (`requestSaveAs`) and save-on-close (`confirmDiscardIfDirty`, `handleBeforeQuit`) all go through
  `saveProject`.

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
