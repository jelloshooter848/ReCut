# Program can flash the previous frame for about one display frame after a paused seek under load

| Field | Value |
|---|---|
| Status | open |
| Severity | low |
| Area | playback (Program monitor) |
| Reported by / date | Claude (agent), 2026-10-07 |
| Found on commit | branch `claude/fix-program-pool-flake` (fix for `bugs/closed/2026-10-07-program-stale-frame-after-seek.md`) |
| Environment | Linux, Electron 33.4.11 under xvfb, software compositing, 4 parallel Electron instances |

## Report

### Summary
`SequencePlayer` still draws as soon as a seek reports landed (`seeking` false, readyState 4 / `seeked`). Under load
Chromium can report that before the landed frame reaches the element's compositor, so the draw paints the previous
frame. Since the closed bug's fix, a `requestVideoFrameCallback` repaints the correct frame when it is presented. The
picture at rest is correct, but the wrong frame is on screen for 9–20 ms first (measured). On a cut back to a reused
pooled element, that brief frame is from the other clip. `composite()` tries to prevent exactly that with
`slot.settled`.

### Steps to reproduce
1. Instrument `drawImage` as described in the closed report's Evidence.
2. Run `tests/e2e/program.spec.ts:327` with `--repeat-each 40 --workers=4`.
3. 4 of 320 cut-back seeks drew the previous picture first, then the correct one 9–20 ms later.

### Expected
A paused draw never shows a frame other than the one at the playhead (black or the held picture is acceptable while
the frame is not ready).

### Actual
The previous frame is shown for about one display frame.

### Suspected cause (hypothesis)
`slot.settled` and `syncVisible().ready` treat `!seeking && readyState >= 2` as drawable. A stricter gate would be:
the element has presented a frame whose `mediaTime` (from the `requestVideoFrameCallback` metadata) matches the
frame-centred target, within half a frame. It needs a fallback when they never match, for example a seek clamped at
the file end or variable-frame-rate media, so the picture cannot stay black.

### Scope
Paused draws in `SequencePlayer` (Program, Compare).

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
