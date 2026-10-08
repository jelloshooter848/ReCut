# Sequence Settings… changes the frame rate of a sequence with clips, silently re-timing every clip

| Field | Value |
|---|---|
| Status | fixed |
| Severity | medium |
| Area | timeline / UI (sequence settings) |
| Reported by / date | Claude (agent, docs audit), 2026-10-08 |
| Found on commit | 679026b (main) |
| Environment | Linux 6.18, Node 22.22.0; source build. No media involved. |

## Report

### Summary
Sequence Settings… (the New Sequence dialog in edit mode) lets the user pick any frame rate for a sequence that
already has clips. Clip positions and durations are stored in frames, so every clip keeps its frame numbers and plays
at a different speed / time: a 48-frame clip at 24 fps (2 s) lasts 1.92 s at 25 fps and drifts against its source
time. The Inspector says the opposite ("Frame rate is fixed once a sequence has clips (positions are frames)",
`src/panels/inspector/SequenceInspector.tsx:73`).

### Steps to reproduce
1. Insert any clip into a 24 fps sequence.
2. File › Sequence Settings…, set Frame rate to 25, Apply.

Store-level: `updateSequenceSettings(seqId, { fps: { num: 25, den: 1 } })` on a sequence with clips.

### Expected
The frame rate cannot change once the sequence has clips (as the Inspector says), or the clips are re-timed.

### Actual
The rate changes to 25 fps; the clip keeps `start: 0, duration: 48`. The dialog only notes "Changing the frame rate
does not re-time existing clips (positions stay in frames)".

### Evidence
`src/app/dialogs/NewSequenceDialog.tsx` `submit()` passes `fps: form.fps` in edit mode; `updateSequenceSettings`
(`src/state/store.ts`) validates only the value (`isValidFps`), not whether the sequence has clips.

### Suspected cause (hypothesis)
The edit mode reused the New Sequence form unchanged; the store action has no clip check. The conform prompt
(`src/panels/source/insert.ts` `conformTargetFor`) already only changes empty sequences.

### Scope
Any caller of `updateSequenceSettings` with `fps`: the dialog, the conform prompt (empty sequences only), tests.

---

## Verification

| Field | Value |
|---|---|
| Verified by / date | Claude (agent), 2026-10-08 |
| Verified on commit | 679026b |
| Verdict | confirmed |

On 679026b, "the rest of the patch still applies; the same rate (any spelling) is not a change" fails: the sequence
ends up at 25 fps with its 48-frame clip unchanged.

---

## Resolution

| Field | Value |
|---|---|
| Closed by / date | Claude (agent), 2026-10-08 |
| Fix | branch `claude/small-fixes-docs-audit` |
| Files changed | `src/state/store.ts`, `src/state/types.ts`, `src/app/dialogs/NewSequenceDialog.tsx`, `tests/unit/docs-audit-fixes.test.ts` (new) |
| Regression test | `tests/unit/docs-audit-fixes.test.ts` › "the frame rate of a sequence with clips is fixed" (4 tests) |

### Root cause
Neither the dialog nor the store action enforced the rule the Inspector states.

### Fix
- Store: `updateSequenceSettings` drops an `fps` that differs (by value, `fpsEquals`) from the current rate when the
  sequence has any clip (`sequenceHasClips`, exported), with the warning toast "Frame rate not changed. Frame rate is
  fixed once a sequence has clips (positions are frames)."; the rest of the patch still applies (no undo step when
  nothing is left). `FPS_LOCKED_REASON` holds the Inspector's sentence.
- Dialog: in edit mode for a sequence with clips (`sequenceFpsLock`), the frame-rate select and custom field are
  disabled with that sentence as tooltip and note; Match Media keeps the rate; Apply sends no `fps`. Name, size and
  audio stay editable. An empty sequence can still change its rate.

Refusing (rather than re-timing clips) is the smallest fix and matches the Inspector, the conform prompt and the
docs' advice to set the rate before building.

### Before / after
Before: 24 fps sequence with a 48-frame clip -> Sequence Settings 25 fps -> 25 fps, clip 48 frames (1.92 s).
After: the rate field is disabled; a store call is refused with the toast, the sequence stays 24 fps.

### Regression test proof
On 679026b the new store tests fail (`sequenceHasClips is not a function`; the partial-patch test: sequence at
`{ num: 25, den: 1 }`). All 4 pass with the fix.

### Tests run
`npm run typecheck`: clean. `npm test`: 113 files, 1963 passed, 3 skipped (1966). No e2e spec drives Sequence Settings; `tests/e2e/export.spec.ts` "720p Preview" and "pre-export warnings" (they set the rate on an empty sequence, the second after deleting all clips): 2/2 passed.

### Changed existing assertions
None. `tests/unit/fps-followups.test.ts` ("updateSequenceSettings still applies valid patches") changes the rate of
an empty sequence, which stays allowed.

### Compatibility risks
Scripts / e2e specs that set the rate after inserting clips now keep the old rate (none found: every spec sets it on
an empty sequence). Saved projects are unaffected.

### Follow-ups
docs/USER-GUIDE.md (step 4 of "Adding clips") on `claude/docs-audit` says Sequence Settings changes the rate without
re-timing; it must say the rate is fixed once the sequence has clips.
