# Program keeps showing the previous frame after a paused seek (stale draw at 'seeked')

| Field | Value |
|---|---|
| Status | fixed |
| Severity | high |
| Area | playback (Program monitor) |
| Reported by / date | Claude (agent), 2026-10-07, from the intermittent e2e failure seen on CI and by other agents |
| Found on commit | 3adc6d3 (main) |
| Environment | Linux, Electron 33.4.11 from source under xvfb (`RECUT_DISABLE_GPU=1`, software compositing), FFmpeg 6.1.1; also GitHub Actions `ubuntu-latest` (run 37683476657) |

## Report

### Summary
`tests/e2e/program.spec.ts:327` "a cut between two clips of one file reuses the pooled element and lands on the right
frame" fails intermittently. It looked like a flaky test. It is an app bug: after a paused seek the Program canvas
can keep the frame from **before** the seek, and nothing replaces it while the playhead rests. Users would see the
wrong picture at the playhead after a click, arrow key or cut-back. That is wrong output, and frame exactness is a
project rule.

### Steps to reproduce
1. `npm run build`
2. Run the spec in four parallel Electron instances. This is the load that other agents' concurrent e2e runs and the
   CI runner put on it:
   `xvfb-run -a npx playwright test -c tests/e2e/playwright.config.ts tests/e2e/program.spec.ts -g "a cut between" --repeat-each 40 --workers=4`

### Expected
40 passed. Every settled sample at frame 10 shows the same burned-in frame, and so does every sample at frame 70.

### Actual
8 of 40 failed on 3adc6d3:
```
expect(new Set(at70).size).toBe(1)   Expected: 1  Received: 2     (5 runs, program.spec.ts:372)
expect(new Set(at10).size).toBe(1)   Expected: 1  Received: 2     (2 runs, program.spec.ts:371)
settleAt(10) on the first load: canvas never bright for 20 s      (1 run, program.spec.ts:354/358)
```
CI run 37683476657 (Linux, branch claude/delivery-intermediates, no preview changes) failed at :371 the same way.

### Evidence
For diagnostics I instrumented the spec (not committed). It wraps `CanvasRenderingContext2D.drawImage` to log each
Program draw: the element's `currentTime`, `seeking` and `readyState`, plus a hash of the canvas right after the
draw. It also wraps the `currentTime` setter and the `seeked` event. In each settle it re-reads the canvas 1.5 s
later.

One failing cut back to frame 70 (5.9384 s) is below. The only draw has `currentTime` 5.9384, is not seeking and is
at readyState 4, yet it paints the frame-10 picture (`#edcab268`, the hash of every correct frame-10 paint in that
run). Nothing draws again, and 1.5 s later the canvas is unchanged:
```
19016 seek 5.9384 from 1.4379
19046 draw ct=5.9384 seeking=false rs=4
         painted #edcab268          <- the picture of frame 10, not 70 (#90ed6fcf)
19046 seeked ct=5.9384 rs=4
(no further draw)
```
Without load (20 repeats) the draw always paints the new frame. In 40 instrumented repeats under the 4-worker load,
8 of 320 cut-back seeks drew the previous frame first, and all 8 stayed wrong. An earlier run, with 6 busy loops
instead of parallel instances, failed the same way at :371: the draw came synchronously in the `seeked` handler and
painted the frame-70 picture at frame 10.

### Suspected cause (hypothesis)
The 'seeked' / readyState signal comes from the main thread. The landed frame reaches the element's
VideoFrameCompositor through a separate task (the media pipeline's PaintSingleFrame). Under load the main thread can
see `seeking=false` and readyState 4, or run the `seeked` handler, before that task has run. `drawImage` then paints
the compositor's previous frame. `SequencePlayer.compositeKey` keys the paused picture on `currentTime`, so the
stale picture looks current, and no later tick repaints it.

### Scope
Every paused draw of a pooled `<video>` in `SequencePlayer`: scrub rounds, rest updates, single seeks, cut-backs on a
reused element, and probably the first load (`loadeddata`), the 1 run that stayed black. Compare uses two
SequencePlayers and has the same exposure. SourcePlayer shows its `<video>` element directly and does not draw it to a
canvas, so it is not affected.

---

## Verification

| Field | Value |
|---|---|
| Verified by / date | Claude (agent), 2026-10-07 |
| Verified on commit | 3adc6d3 |
| Verdict | confirmed: app bug, not the test harness |

- **Not the harness.** `settleAt` does wait too short in principle: two equal samples 250 ms apart. But the wrong
  picture was still on the canvas 1.5 s later in every failure, and only one draw was logged. The test reported a
  picture that stays wrong.
- **Not a neighbouring frame.** The element is at exactly the requested frame-centred time (5.9384 / 1.4379), and the
  wrong picture equals the other seek target's picture. It is the previous frame, not an off-by-one.
- **Load sensitivity.** Repeats of the original spec:

  | Load | Failed |
  |---|---|
  | none | 0/20 |
  | 6 busy loops, instrumented spec | 1/20 |
  | 8 busy loops | 0/40 |
  | 1 busy loop, everything pinned to one CPU | 0/10 |
  | 4 parallel Electron instances (`--workers=4`) | 8/40 |
  | 4 parallel Electron instances, instrumented spec | 6/40 + 1/20 |

---

## Resolution

| Field | Value |
|---|---|
| Closed by / date | Claude (agent), 2026-10-07 |
| Fix | branch `claude/fix-program-pool-flake` (commit daa98ba and the commit adding this file) |
| Files changed | `src/playback/sequencePlayer.ts`, `tests/unit/program-scrub.test.ts`, `docs/ARCHITECTURE.md` |
| Regression test | `tests/unit/program-scrub.test.ts::SequencePlayer: the landed frame reaches the compositor after 'seeked'` (3 tests); `tests/e2e/program.spec.ts:327` unchanged |

### Root cause
Chromium can report a paused seek as complete before the landed frame can be drawn. `seeking` turns false, readyState
reaches 4 and `seeked` fires, all on the main thread. The landed frame reaches the element's compositor in a separate
task, and under load that task can run later. A Program draw in that window paints the previous frame.
`SequencePlayer` treated `seeked` / readyState as "the frame is drawable" and keyed the paused picture on
`currentTime`. So once that stale draw happened, nothing repainted it: the picture key already matched the new time.

### Fix
`SequencePlayer.ensureListeners` keeps a `requestVideoFrameCallback` loop on each video element the player uses.
Chromium runs that callback after the element's compositor takes a new frame, so it is the signal that the frame is
drawable. While paused, when an element lent to a clip presents a frame, the player forces one repaint
(`drawPending` + the existing `redraw` path). The loop is cancelled with the element's other listeners when the pool
disposes the element or the player is destroyed. When the API is missing, behaviour is unchanged. During playback
the callback only re-arms itself.

This is the smallest change that makes the resting picture correct whatever the thread timing. It adds no timers or
polling, and it does not change when seeks are issued or what counts as settled. Cost: in the common case, where the
frame was already presented when the draw ran, there is one redundant `drawImage` per landed paused seek. During
an active scrub the callback mostly arrives while the next round is in flight, so no extra draw happens there.

### Before / after
Same load (`--repeat-each N --workers=4`, original spec, no instrumentation):

| Build | Failed |
|---|---|
| Before (3adc6d3) | 8/40 |
| After | 0/40, then 0/120 (0/160 in total) |

Instrumented spec, before and after:

| Build | Failed | Cut-back seeks whose first draw was stale | Settles whose final picture was wrong |
|---|---|---|---|
| Before | 6/40 | 8/320 | 8 |
| After | 0/40 | 4/320 | 0 |

After the fix, the presentation callback repainted the correct frame 9–20 ms after the stale draw:
```
32272 seek 1.4379 from 5.9384
32301 draw ct=1.4379 seeking=false rs=4
         painted #90ed6fcf          <- stale (frame 70's picture)
32302 seeked ct=1.4379 rs=4
32322 draw ct=1.4379 seeking=false rs=4
         painted #edcab268          <- frame 10, from the video-frame callback
```
The black-canvas-after-load failure was seen twice in about 100 runs before the fix and never in 200 runs after it.

### Regression test proof
In `tests/unit/program-scrub.test.ts`, the fake `<video>` now models the compositor frame (`shown`) separately from
`currentTime`. `land(false)` fires `seeked` before the frame is presented, `present()` presents it and queues the
video-frame callbacks, and rVFC is opt-in, so the existing tests still cover an element without the API. On the old
`sequencePlayer.ts`:
```
× a cut back to the first clip of the same file repaints once the landed frame is presented
  → expected 5.9375 to be close to 1.4375        (the frame-70 picture left at frame 10)
× a seek that lands after the playhead rests repaints once the landed frame is presented
  → expected 10.020833333333334 to be close to 20.020833333333332
× stops asking for video frames when the player is destroyed
```
With the fix, all 10 tests in the file pass.

### Tests run
- `npm run typecheck`: clean.
- `npm test`: 85 files, 1564/1564 passed.
- e2e, under the heavy lock: the program.spec.ts:327 repeats above, and the full `xvfb-run -a npm run test:e2e`:
  68/68 passed (3.6 min).
- Not run: Windows and macOS. The fix uses only the standard `requestVideoFrameCallback` API, which is the same
  Chromium on every platform.

### Changed existing assertions
None. The e2e spec is unchanged: its assertion was right.

### Compatibility risks
None for projects or exports. The Program now does one extra paused redraw per landed seek. Browsers without
`requestVideoFrameCallback` behave as before. Electron 33 has it, and the e2e run showed it fires for the pool's
off-DOM `<video>` elements.

### Follow-ups
- A stale draw can still be on screen for about one display frame (9–20 ms measured) before the callback repaints
  it. During a cut-back, that brief frame comes from the other clip. Filed as
  `bugs/open/2026-10-07-program-transient-stale-frame-before-present.md` (low).
