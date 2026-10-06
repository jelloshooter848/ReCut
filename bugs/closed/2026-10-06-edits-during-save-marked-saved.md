# Edits committed while a save is in flight are marked saved without being written

| Field | Value |
|---|---|
| Status | fixed |
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
| Verified by / date | save-race agent, 2026-10-06 |
| Verified on commit | 41c3031 |
| Verdict | confirmed |

`tests/unit/save-race.test.ts` reproduces every variant in the report on 41c3031 (7 of 8 cases fail; the control
case "no edit in flight" passes). The suspected cause was right: `markSaved` ran after the awaits with no check of
what had been written, saves were not ordered, and the close prompts trusted `requestSave() === true`. Autosave was
checked and is not affected: `autosaveProject` writes `<project>.recut.autosave` (or the untitled autosave) and never
touches `dirty`; there is no "autosaved" marker in the store.

---

## Resolution

| Field | Value |
|---|---|
| Closed by / date | save-race agent, 2026-10-06 |
| Fix | branch `claude/save-race` (commit "Fix: edits made while a save is in flight stay unsaved") |
| Files changed | src/state/types.ts, src/state/store.ts, src/state/mediaActions.ts, src/app/project.ts, tests/unit/save-race.test.ts |
| Regression test | tests/unit/save-race.test.ts (9 cases) |

### Root cause
- src/state/mediaActions.ts:383 (41c3031): `if (res.ok) useStore.getState().markSaved(res.path);` after awaiting the
  sliced serialization and the IPC write, with nothing recording which project state was written.
- src/state/store.ts:445 (41c3031): `markSaved(path) { set({ projectPath: path, dirty: false }); }` cleared `dirty`
  and set the path unconditionally, even for a project that New / Open had replaced meanwhile.
- Two saves could be in flight at once, so an older write could land after a newer one.
- src/app/project.ts:90 and :267 (41c3031): the close / new / open / quit prompts treated a successful save as
  "nothing left to lose".

### Fix
- Store (`src/state/types.ts`, `src/state/store.ts`): a `revision` counter, bumped by every write that sets `dirty`
  (commit, quiet `{ dirty: true }`, undo, redo, endTransaction) and by newProject / loadProjectData, which also set
  `loadedRevision`. `markSaved(path, revision?)`: same revision → path + `dirty: false` (as before); older revision
  of this project → path only, `dirty` stays as it is (Save As still moves the project to the new file); revision
  from before the last new / open → nothing. Without `revision` it behaves as before.
- `saveProject` (`src/state/mediaActions.ts`): saves run one at a time through a promise queue; each takes its
  snapshot (and `revision`) when its turn comes, so the last write to land is always the newest snapshot, and passes
  that revision to `markSaved`.
- Close flow (`src/app/project.ts`): `confirmDiscardIfDirty` ("Save") and `handleBeforeQuit` ("Save") go through
  `saveBeforeClose`, which returns true only when the save succeeded *and* the project is no longer dirty; otherwise
  it toasts "Changes made while saving are not saved yet. Save again." and the new / open / quit does not proceed.
- Undo / redo: unchanged. Both already set `dirty: true` unconditionally (undoing back to the saved state stays
  dirty); they now also bump `revision`, so an undo during a save keeps the project dirty.
- View-only changes (playhead / scroll / zoom / in / out, transient drags) do not bump `revision`, exactly as they do
  not set `dirty`, so they do not make a finished save leave the project dirty.

Smallest correct: one counter compared at the one place `dirty` is cleared, plus ordering of saves (without it the
counter alone cannot stop an older write landing last) and the close check (without it the counter keeps `dirty`
but the caller discards anyway).

### Before / after
| Case | Before (41c3031) | After |
|---|---|---|
| Edit while the write is in flight | file `A`, `dirty: false` | file `A`, `dirty: true`; next save writes `B`, then `dirty: false` |
| Undo during save | `dirty: false`, file has pre-undo project | `dirty: true` |
| Save As + edit in flight | `dirty: false` | new path taken, `dirty: true` |
| New Project while a save is in flight | new project gets the old `projectPath`, `dirty: false` | `projectPath: null`, `dirty` untouched |
| Save twice, older write lands last | file `A`, `dirty: false` | writes ordered: file `B`, `dirty: false` |
| "Save changes?" → Save + edit during save | resolves `true` (discard) | resolves `false`, warning toast, project kept |
| Autosave during a manual save | does not touch `dirty` | unchanged (autosave holds `B`, project stays dirty) |

### Regression test proof
Before (fix reverted, test file as committed):
```
   × an edit after serialization starts keeps the project dirty; the next save writes it
   × an edit right after save is called (before the first slice / IPC) is written or stays dirty
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
(The autosave case was added with the fix; it documents behaviour that was already correct.)

After:
```
 ✓ tests/unit/save-race.test.ts (9 tests)
      Tests  9 passed (9)
```

### Tests run
- `npm run typecheck`: clean (renderer + electron).
- `npm test`: 48 files, 1035/1035 (includes the new tests/unit/save-race.test.ts 9/9 and the existing
  project-io-perf.test.ts / store.test.ts save and markSaved cases, unchanged).
- `npx vitest run -c tests/attack-qa/vitest.config.ts`: 84/84 (project-io, undo-torture).
- `npm run build`: ok.
- `xvfb-run -a npx playwright test -c tests/e2e/playwright.config.ts tests/e2e/project.spec.ts tests/e2e/lifecycle.spec.ts`:
  16/16.
- `xvfb-run -a npx playwright test -c tests/attack-qa/playwright.config.ts tests/attack-qa/lifecycle-quit.spec.ts`: 6/6
  (quit prompt Save / Don't Save / Cancel).

### Changed existing assertions
None. The test case "an edit right after save is called" was first written to expect the snapshot to exclude that
edit; with saves queued the snapshot is taken one microtask later and includes it, so the case asserts the actual
requirement instead (the edit is in the file, or the project stays dirty). It fails on the old code either way.

### Compatibility risks
- Saved projects / file format: none (`revision` and `loadedRevision` are store state, not written to the file).
- Saves are serialized: a save that never resolves (hung IPC) now also holds back later saves; before, a later save
  could run alongside it. A failed or rejected save does not block the queue.
- A save that finishes after an edit now leaves the `*` in the title, and Save on close / new / open / quit asks the
  user to save again instead of proceeding.

### Follow-ups
- Not fixed here (crash-recovery only, no loss while the app keeps running): if an autosave of the newer edits lands
  before the manual save's write, `checkRecovery` (electron/project/io.ts, `autoSt.mtimeMs <= projSt.mtimeMs + 1000`)
  ignores that autosave as older than the project file. The project stays dirty, so the next debounced / interval
  autosave (at most `autosaveIntervalSec`, default 60 s) rewrites it; a crash before then loses the edit. Possible
  fix: schedule an autosave when a save completes with the project still dirty (src/app/project.ts). Filed as
  bugs/open/2026-10-06-autosave-during-save-ignored-by-recovery.md.
