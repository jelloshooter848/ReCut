# A background job finishing after a clean save marks the project dirty: quit asks "Save changes?"

| Field | Value |
|---|---|
| Status | fixed |
| Severity | medium |
| Area | project I/O / store (job mirrors, quit prompt) |
| Reported by / date | Claude (agent), 2026-10-08 (follow-up of 2026-10-08-e2e-close-hangs-on-quit-prompt.md) |
| Found on commit | 888c4d2 |
| Environment | Linux 6.18 (xvfb), Electron 33.4.11, FFmpeg 6.1.1, source build |

## Report

### Summary
Save a project, let a background job finish (a proxy, a scene detection, a channel proxy), quit: ReCut asks "Save
changes to … before quitting?" and the title bar shows the unsaved marker, although the user changed nothing. The
same job also starts an autosave, which is newer than the project file. It is what made the e2e teardown hang in
the 0.8.0 release run (bugs/closed/2026-10-08-e2e-close-hangs-on-quit-prompt.md), where the harness was fixed but
the app behaviour was left as it was.

### Steps to reproduce
1. Import a movie, add a clip, save.
2. Generate its proxy (Source › Generate proxy, or `__recut.actions.startProxy(id)`), wait until it is ready.
3. Quit.

Automated: tests/e2e/quit.spec.ts "a proxy job finishing after a clean save: quit asks nothing and exits";
tests/unit/job-mirrors-not-dirty.test.ts.

### Expected
No prompt, no dirty marker; the app quits.

### Actual
```
Error: no Save changes? prompt
+ Array [
+   "Save changes to \"Untitled Project\" before quitting?",
+ ]
```

### Suspected cause (hypothesis)
src/state/store.ts: the job mirrors (`setProxy`, `invalidateProxy`, `setChannelProxies`, `setSceneDetectStatus`,
`setDetectedScenes`) are `quiet(…, { dirty: true })`.

### Scope
Every job-driven store write: probe, proxy, channel proxy, scene detection, OCR / Whisper results, relink,
offline flags.

---

## Verification

| Field | Value |
|---|---|
| Verified by / date | Claude (agent), 2026-10-08 |
| Verified on commit | 888c4d2 |
| Verdict | confirmed |

The e2e test above fails on 888c4d2 with the output under Actual; 7 of the 10 unit tests fail (Regression test
proof). The hypothesis was right. How each job-driven write is persisted and whether it is re-derived on load:

| Write | In the .recut? | Re-derived on load? | Decision |
|---|---|---|---|
| `setProxy` / `invalidateProxy` (media.proxy) | yes (`queued` / `running` load as `none`) | ready paths are stat-checked (verifyProxies); a proxy is made again from the content-keyed cache in no time | mirror: not dirty |
| `setChannelProxies` (media.channelProxies) | yes | yes: initChannelProxies requests what clips need, cache hits | mirror: not dirty |
| `setSceneDetectStatus` / `setDetectedScenes` | yes (`running` loads as `none`) | no, but a new run hits the scenes cache (`scenes/<key>_<threshold>.json`) | mirror: not dirty (renaming / merging / splitting scenes are undoable edits and stay dirty) |
| `setOffline` | yes | yes (verifyMediaOnline on open) | was already not dirty |
| `setMediaProbe` | yes | **no**: media are probed only on import and relink | stays dirty: it completes the import / relink edit, and a probe missing from the file stays missing |
| `relinkMedia` | yes (path, size, mtime) | no | stays dirty: the user's change |
| OCR / Whisper results (`putOcrSubtitleTrack`, `putWhisperSubtitleTrack`) | yes | no | stay dirty: they are undo steps (commits) the user asked for |
| waveform / thumbnails | renderer caches only (no store write); `waveformStatus` has no setter | — | — |
| OCR / Whisper / FFmpeg status, `store.jobs` | separate stores / not in the project | — | — |

---

## Resolution

| Field | Value |
|---|---|
| Closed by / date | Claude (agent), 2026-10-08 |
| Fix | branch `claude/fix-quit-save-robustness` |
| Files changed | src/state/store.ts, src/state/types.ts, docs/ARCHITECTURE.md, tests/unit/job-mirrors-not-dirty.test.ts (new), tests/unit/store.test.ts, tests/e2e/quit.spec.ts (new), tests/e2e/helpers.ts and tests/e2e/teardown.spec.ts (comments) |
| Regression test | tests/unit/job-mirrors-not-dirty.test.ts (all); tests/e2e/quit.spec.ts › a proxy job finishing after a clean save: quit asks nothing and exits |

### Root cause
The job mirrors marked the project dirty (and bumped `revision`) like an edit. `dirty` drives the quit / close /
open prompts, the title-bar marker and the autosave schedule, so a job finishing after a clean save made quit ask
"Save changes?" and started an autosave newer than the project file.

### Fix
The proxy, channel-proxy and scene-detect mirrors are plain `quiet` writes: no `dirty`, no `revision` bump, no
history (as before). They are in the store's project, so the next save or autosave (after any edit) writes them;
they are lost only when the app quits with no edit after them, and the jobs make them again from the content-keyed
cache. `revision` now means "edits" (types.ts), so `markSaved` keeps its rule: a mirror landing while a save is in
flight does not keep the project dirty (the save's snapshot holds every edit), and no follow-up autosave is
scheduled. The probe result and the relink keep `dirty: true` (table above). Undo is unchanged: mirrors are not
undo steps, `carryViewState` keeps their current values across undo / redo, and undo / redo still mark the project
dirty.

#84's guarantees hold: an autosave runs only for a dirty project, so a mirror after a clean save writes none (no
recovery prompt after quit), and an edit after a mirror is autosaved with the mirror (crash recovery).

### Before / after
Before: save → proxy ready → quit asks "Save changes to … before quitting?", title shows `*`. After: no prompt, no
marker, the app quits; the proxy is in the file after the next save.

### Regression test proof
On 888c4d2:
```
× each job mirror setter leaves a clean project clean, with no undo step and redo kept
× a proxy job finishing (jobsRouter) after a clean save leaves the project clean
× a scene-detect job finishing after a clean save leaves the project clean
× quit right after a clean save + a proxy job finishing quits without the Save changes? prompt
× nothing is autosaved for a mirror after a clean save (no recovery prompt after quit)
× a mirror landing while a save of an edited project is in flight: the project is clean after the save, no follow-up autosave
× a later edit makes the project dirty, and its autosave (crash recovery) holds the edit and the mirror
Tests  7 failed | 3 passed (10)

✘ quit.spec.ts › a proxy job finishing after a clean save: quit asks nothing and exits
  Error: no Save changes? prompt
  + "Save changes to \"Untitled Project\" before quitting?"
```
With the fix: 10/10, and the e2e test passes.

### Tests run
- `npm run typecheck`: clean.
- `npm test`: 115 files, 2011 passed, 2 skipped (with the branch's quit-flow fix).
- e2e (Linux, xvfb): quit.spec.ts 3/3, lifecycle.spec.ts 9/9, project.spec.ts 8/8, teardown.spec.ts 1/1,
  gauntlet.spec.ts 4/4 (TEST1 17/17, TEST2 21/21, TEST3 22/22, TEST4 11/11 steps).

### Changed existing assertions
tests/unit/store.test.ts "invalidateProxy resets a ready proxy quietly": `expect(S().dirty).toBe(true)` →
`toBe(false)`; it encoded this bug. The comment of "job/status mirrors … keep redo" now says the remaining dirty
comes from the relink (its assertion is unchanged).

### Compatibility risks
None for files. Behaviour: proxy / scene-detect / channel-proxy state that arrived after the last save is not
written when the user quits without editing; reopening shows the proxy as `none` (or the scenes undetected) until
it is generated again, which is a cache hit.

### Follow-ups
None.
