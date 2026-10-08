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
| Verified by / date | Claude (agent), 2026-10-08 |
| Verified on commit | 3b4c127 (main) |
| Verdict | confirmed: the draw paints the frame the element still holds, not the landed one |

Repro: `tests/e2e/program-present.spec.ts`. It is the cut of `program.spec.ts:327` (1–3 s and 5–7 s of one file, so one
pooled `<video>`), with 40 cut-back seeks (10 <-> 70) per run. It logs every Program draw with a signature of the
canvas right after it. Once the two right pictures are known, a wrong draw also logs the timestamp of the frame the
element holds (`new VideoFrame(el)`, the frame drawImage paints). Right draws skip that probe, so the probe cannot
change their timing. Run under the heavy lock:
`xvfb-run -a npx playwright test -c tests/e2e/playwright.config.ts tests/e2e/program-present.spec.ts --repeat-each N --workers=4`.

| Run (main's player) | Runs failed | Wrong draws / cut-back seeks |
|---|---|---|
| `--repeat-each 8` | 3/8 | 3/192 |
| `--repeat-each 40` | 14/40 | 20/1600 |
| `--repeat-each 40`, held-frame probe | 19/40 | 24/1600 |

Every wrong draw painted the other clip's picture (`at 70: frame 10`, `at 10: frame 70`). In 19 of the 24 probed ones,
the element **still held the other clip's frame** right after the draw, while `currentTime` was already the new
target and the seek had reported landed:
```
wrong draw at 10: currentTime 1.437916, frame held 5.916667     (10 times)
wrong draw at 70: currentTime 5.938416, frame held 1.416667     ( 9 times)
wrong draw at 10: currentTime 1.437916, frame held 1.416667     ( 2 times: the frame arrived between draw and probe)
wrong draw at 70: currentTime 5.938416, frame held 5.916667     ( 3 times: same)
```
On a right draw the held frame is the one containing `currentTime` (frame 10: timestamp 1.416667 at currentTime
1.437916, half a frame before it, since targets are frame-centred).

---

## Resolution

| Field | Value |
|---|---|
| Closed by / date | Claude (agent), 2026-10-08 |
| Fix | branch `claude/fix-program-stale-frame` |
| Files changed | `src/playback/sequencePlayer.ts`, `tests/unit/program-scrub.test.ts`, `tests/e2e/program-present.spec.ts` (new), `docs/ARCHITECTURE.md` |
| Regression test | `tests/unit/program-scrub.test.ts` › "a paused draw waits until the landed frame is presented" (5 tests); `tests/e2e/program-present.spec.ts` |

### Root cause
As the report suspected. A paused draw trusted the main thread's "seek landed" signals: `seeking` false, readyState
≥ 2 (`slot.settled`, `syncVisible().ready`), and the `seeked` event that triggers the draw. The landed frame reaches
the element's compositor in a separate media-pipeline task. Under load that task can run after the draw, so drawImage
paints the frame the element still holds. On a cut back to a reused pooled element, that is the other clip's frame.
PR #68's video-frame callback repainted it once presented (9–20 ms later). The wrong frame had still been on screen
for that time.

### Fix
`SequencePlayer.paintIfChanged` (paused draws only) now asks every painted video layer's element which frame it holds,
before it paints. `shownFrameTime(el)` constructs `new VideoFrame(el)`, the frame drawImage would paint, reads
`timestamp`, and closes it in a `finally`. If that frame does not contain the element's `currentTime` (timestamp
more than 1 ms after it, or at least one frame plus 1 ms before it), the draw is held. The canvas keeps its last
picture and `pausedKey` is not updated. The video-frame callback from PR #68 redraws once the landed frame is
presented, and the check then passes.

- **Fallback.** A hold lasts at most `PRESENT_HOLD_MS` (250 ms) after the first held attempt. A timer then forces the
  draw, so media whose timestamps never match cannot stay frozen.
- **Not checked.** Media probed as variable frame rate (a frame can last longer than 1/fps), and anything where the
  frame cannot be read: no WebCodecs, or the constructor or `timestamp` throws. These draw as before.
- **Why not `requestVideoFrameCallback` `mediaTime`, as the report suggested.** It is only delivered in the next
  rendering step, up to a display frame after the compositor has the frame. A gate on it would have held nearly every
  draw at `seeked`, including every scrub round.

Playback is untouched: the playing branch of `tick()` never calls the check. A unit test asserts that no
`VideoFrame` is constructed while playing.

### Before / after
`tests/e2e/program-present.spec.ts`, `--workers=4`, heavy lock, 40 cut-back seeks per run:

| Build | Runs failed | Wrong draws |
|---|---|---|
| Before (main 3b4c127's player) | 3/8, 14/40, 19/40 (36/88) | 47 of 3392 seeks |
| After | 0/40, then 0/100 (0/140) | 0 of 7082 draws (5600 seeks) |

In the 100-run batch the player checked 5049 frames for 5013 draws. The 36 extra checks are held attempts, the race
this fixes. All 5049 frames were closed: the spec counts constructions and `close()` calls and asserts they match.

**Cost of the check** (timed in the spec around each `new VideoFrame(el)` + `close()`, `performance.now()` resolution
0.1 ms): in all 100 runs the per-run median was below 0.1 ms. The per-run p95 was 0.1–0.2 ms and the maximum single
check 0.6 ms. There is one check per painted video layer per paused draw attempt: 1.00–1.09 per draw here, with one
layer. Nothing runs during playback.

### Regression test proof
On main's `sequencePlayer.ts`, the new unit tests fail:
```
× a cut back to a reused element draws nothing until the landed frame is presented, then that frame
  → expected [ { el: FakeMedia{ …(25) }, …(2) } ] to have a length of +0 but got 1
× a scrub whose seeks land before their frames are presented never draws a frame other than the one sought
  → expected false to be true
× draws anyway after 250 ms when the element never shows a matching frame
  → expected [ { el: FakeMedia{ …(25) }, …(2) } ] to have a length of +0 but got 1
```
The fake `VideoFrame` counts constructions and closes, and every gated test asserts they match. With the `close()`
removed from `shownFrameTime`, 4 tests fail.

### Tests run
- `npm run typecheck`: clean. `npm test`: see below.
- e2e (heavy lock, after merging main d30bf58 with #73): program, program-present, source, timeline, nest and compare
  specs, 17/17 passed. `program.spec.ts:327` (the test #68 de-flaked) `--repeat-each 40 --workers=4`: 40/40 passed.
- `program-present.spec.ts` repeats: as in Before / after.
- Not run: Windows and macOS, and the perf gate (the orchestrator runs the same-host A/B).

### Changed existing assertions
None.

### Compatibility risks
None for projects or exports. A paused picture can now appear up to one display frame later under load (it waits for
the landed frame rather than showing the previous one first), and at most 250 ms later if timestamps never match.
WebCodecs `VideoFrame` from an `HTMLVideoElement` is in Chromium on every platform, but this was only run on Linux
(xvfb, software compositing). Without it, the draw is not held.

### Follow-ups
- Variable-frame-rate media is not checked, so it can still show the transient frame (repaired by the video-frame
  callback, as before).
