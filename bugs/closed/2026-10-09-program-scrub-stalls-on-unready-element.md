# Program monitor can stop following a fast scrub (no seeks for the whole drag)

| Field | Value |
|---|---|
| Status | fixed |
| Severity | low |
| Area | playback |
| Reported by / date | Claude (side finding of bugs/closed/2026-10-08-perf-multi-hour-scrub-long-tasks-flaky.md), 2026-10-09 |
| Found on commit | 37912dd (`claude/perf-gate-080`) |
| Environment | 4-core cloud container, Linux 6.18, xvfb with software GL, Electron 33 under Playwright, source build |

## Report

### Summary
During the bench's 3 s multi-hour scrub at 1 px/frame (a page flip every frame, about 1,079 frames per step), the
Program player sometimes issues no seek at all for the whole drag. So the Program monitor would keep showing the
frame from before the drag until the playhead rests. Seen in 1 of 11 instrumented runs, possibly 2.

### Steps to reproduce
Not reduced yet. In the instrumented copy of `tests/perf/electron-perf.mjs` (session scratchpad), the
`HTMLMediaElement.prototype.currentTime` setter was counted during the timing pass of
`long tasks during scrub multi-hour @ 1 px/frame, no selection`, and the pooled elements' state was logged before it.

### Expected
The player keeps seeking at the rate its scrub rounds allow: 58–80 `currentTime` writes per 3 s pass in the other
9 runs.

### Actual
Run s3: 0 `currentTime` writes and 0 media elements created during the pass. Before the pass, 2 of the 10 live pooled
elements had `readyState < 2` or `seeking`. Run t2 (traced, not counted) shows no activity on the renderer's Media
thread during the pass either.

### Suspected cause (hypothesis)
`SequencePlayer.scrubTick` (`src/playback/sequencePlayer.ts`) waits until every element of the last scrub round has
landed (`seekInFlight`: `el.seeking || el.readyState < 2`) before it seeks again. If an element of that round never
reaches `readyState` 2, the round never ends, so nothing is sought until the playhead rests (pausedTick's full update
resets `round`). For example, Chromium may defer loading a paused element that is not in the DOM, or suspend an
idle player. A timeout on a scrub round, or dropping elements that have not loaded, would bound it. Not verified;
needs a reduced repro, ideally an e2e test that scrubs across many files and checks that the Program canvas changes.

---

## Verification

| Field | Value |
|---|---|
| Verified by / date | Claude (Claude Code session), 2026-10-09 |
| Verified on commit | 2494b6e (`claude/fix-multihour-scrub`) |
| Verdict | Confirmed as an app bug in `SequencePlayer`: an element that stays in flight is waited for without limit and is never sought again. What makes Chromium leave the seek pending was not reproduced. |

**The evidence from the report, re-read.** In run s3 the same 2 pooled elements were reported as `seeking` or
`readyState < 2` before each of the 5 multi-hour scrub rows. Those rows span several minutes and include a rest of the
playhead before every pass. 3 timing passes had 0 `currentTime` writes. The other 2 had 12 and 13 writes, against
58–184 in every other run. So the elements stayed in flight for minutes, through rests, not for one scrub.

**Why the player never recovers (verified in the code, 2494b6e):**
- `scrubTick` returns without doing anything while any element of the last round is in flight
  (`seekInFlight`: `seeking || readyState < 2`). Nothing else ends the round during a drag.
- `syncVisible` (scrub) and `syncElement` (the full update at rest) never seek an element whose `seeking` is true
  ("never queue a seek behind a pending one"). So a seek that Chromium never completes is never issued again, by
  either path.
- At rest, `composite()` skips a layer whose slot has not settled, so that layer is not drawn. Below an opaque top
  layer, the occluded layers are not drawn either (`visibleLayers`), so the monitor can stay black there, or show an
  occluded layer's stale frame where the top layer has no data.

So once Chromium leaves one paused seek pending, the Program monitor stops following every scrub that has that
element in view, until playback starts or the element is evicted or released. That explains all of s3: 0 writes
whenever the first scrub step lands on the stuck element (the multi-hour rows all start at frame 0), and a few writes
in the in-page rows, which start elsewhere and stall once they reach it.

**Deterministic repro (no Chromium needed).** `tests/unit/program-scrub.test.ts` → "a seek that never lands does not
freeze the Program monitor": the fake `<video>` gets a `stalled` flag that drops its pending seek (no `seeked`,
`seeking` stays true) until the next `currentTime` write, which is what the s3 elements reported. On 2494b6e the
top layer is sought once and never again, during a 1.1 s drag and after the playhead rests. The e2e test
`tests/e2e/program.spec.ts` → "a seek that never completes does not freeze the monitor" does the same in the real
app. It overrides `seeking` / `readyState` of the Program `<video>` from its first scrub seek until the app seeks it
again.

**What makes Chromium leave the seek pending: not found.** What I tried, all on the unfixed build:
- 16 runs of an instrumented copy of `electron-perf.mjs` (generated by `mkprobe.mjs` in the session scratchpad,
  heavy lock held). It logs the `currentTime` writes of every scrub pass. Before each pass it also logs every pooled
  element that is seeking or below readyState 2, with its last DOM media events and its media-internals events (CDP
  `Media` domain). Result: no pass without seeks, and no element in flight for longer than a normal seek. Together
  with the 11 runs in the report, that is 1 (possibly 2) stalls in 27 runs.
- A minimal Electron page (no app code) with 4–16 paused `<video>` elements, served over `file://` and over a copy of
  the app's `recut-media://` handler. Up to 7,200 scrub-like seeks in 60 s, with element creation and disposal every
  0.3–0.5 s and seeks issued before load. No seek stayed pending for 3 s.
- The same page with 12 long-GOP 1080p files (GOP 240). Seeks took 3–10 s each, but all completed. With 4 elements
  they took about 0.2 s. With `--disable-media-suspend` it was the same, and media-internals (CDP `Media` domain)
  logged no suspend. So this is CPU throughput (12 concurrent 1080p prerolls on 4 cores), not a stall. It does show
  that a paused seek can legitimately take several seconds, which the fix must not interrupt for ever.
- One hypothesis from Chromium 130's source was checked and not confirmed. When more than 8 players are idle,
  `RendererWebMediaPlayerDelegate` marks them stale at once, and `WebMediaPlayerImpl` can then suspend a paused player
  between the end of its pipeline seek and its preroll. The media logs of these experiments show no suspend after a
  seek.

The fix does not depend on the trigger. Only a new seek can restart an element: in s3 the stuck elements fired
nothing for minutes. Chromium does not elide a seek to the same time when the element's `readyState` is below
HAVE_ENOUGH_DATA (`WebMediaPlayerImpl::DoSeek`), so the retry is a real seek even when the target is unchanged.

---

## Resolution

| Field | Value |
|---|---|
| Closed by / date | Claude (Claude Code session), 2026-10-09 |
| Fix | branch `claude/fix-program-scrub-stall` |
| Files changed | `src/playback/sequencePlayer.ts`, `tests/unit/program-scrub.test.ts`, `tests/e2e/program.spec.ts`, `docs/attack/performance.md`, this file |
| Regression test | `tests/unit/program-scrub.test.ts` → "SequencePlayer: a seek that never lands does not freeze the Program monitor" (3 tests); `tests/e2e/program.spec.ts` → "a seek that never completes does not freeze the monitor: it is issued again" |

### Root cause

`SequencePlayer` (`src/playback/sequencePlayer.ts`) waited for media element seeks without any limit, and never
issued a seek again on an element that reported `seeking`. A paused seek that Chromium never completes therefore
froze the Program monitor wherever that element was in view: no seek for the rest of the drag (`scrubTick`), and none
at rest either (`syncElement`), so the layer was not drawn until playback started. The perf bench hit it in about 1
run in 10. Chromium's reason for leaving the seek pending was not identified (see Verification).

### Fix

Bounded waits, in `sequencePlayer.ts` only:
- **`SEEK_STALL_MS` = 1,000 ms.** A paused seek that has not landed after this long counts as stalled
  (`seekStalled`). The clock is per element (`pendingSince`), from the last seek the player issued on it, or from the
  first time the player saw it in flight. It is per element because a reused element can still be on a seek issued
  for the previous clip. Every seek goes through `seekSlot`, which starts the clock.
- **Backoff.** A seek issued because the previous one stalled may stay pending twice as long (2 s, 4 s, … up to
  `SEEK_STALL_MAX_MS` = 16 s). Any other seek starts again at 1 s. So a seek that is only slow (several seconds for a
  long-GOP original on a busy machine, as measured above) still lands, instead of being restarted for ever.
- **Scrub (`scrubTick`).** A round waits as before, but once one of its pending seeks has stalled the round is dropped
  without a draw, and the next round starts at the latest playhead. `syncVisible` sends the stalled element again
  (the only case in which it seeks behind a pending seek). The dropped round is not drawn because its picture would
  lack that layer, and under it the occluded layers hold stale frames (they are not sought while scrubbing).
- **At rest (`pausedTick` → `syncElement`).** A stalled element is sought again when not playing natively.
  `armStallCheck` sets a timer for the earliest stall deadline of the lent elements, because a resting playhead asks
  for no tick and a stalled element fires no event.

Unchanged: seeks are still never queued behind a pending seek that is not stalled, a round is drawn only when all
its layers have landed, the picture at rest is still exactly the playhead frame (frame-centred targets, `framesShown`
hold), and native playback is untouched. Proxy and direct-path selection is in the planner and is not affected.

### Before / after

| | Before (2494b6e) | After |
|---|---|---|
| Unit: a seek dropped during a drag | Top layer sought once; no further seek or draw during the drag | Sought again at 1 s, to the latest playhead; drawn when it lands; one seek per round again afterwards |
| Unit: a seek dropped at rest | Never sought again; layer not drawn | Sought again after 1 s (timer); drawn when it lands |
| Unit: a seek that takes 1.5 s | (waited) | Retried once at 1 s, then left alone for 2 s, lands |
| e2e: first scrub seek of the Program `<video>` made to look stalled | `resought` 0 after a 2.5 s drag (test fails) | `resought` 1; the frame at rest matches the reference |

### Regression test proof

On 2494b6e (with `SEEK_STALL_MS` exported so the test file loads):
```
 × ... a scrub round stops waiting for a stalled seek after 1000 ms and seeks on to the playhead
   → expected 1 to be 2 // Object.is equality
 × ... a seek that stalls while the playhead rests is issued again, and the frame is drawn when it lands
   → expected 1 to be 2 // Object.is equality
 × ... a seek that is slow rather than stalled still lands: each retry waits twice as long
   → expected 1 to be 2 // Object.is equality
      Tests  3 failed | 15 passed (18)
```
The e2e test on a build of 2494b6e:
```
  ✘  1 tests/e2e/program.spec.ts:380:7 › Program Monitor › a seek that never completes does not freeze the monitor: it is issued again (10.5s)
    Error: expect(received).toBe(expected) // Object.is equality
    Expected: 1
    Received: 0
```
On this branch: 18 of 18 and 5 of 5 (program.spec.ts) pass.

### Tests run

- `npm run typecheck`: clean.
- `npm test`: 119 files, 2,029 passed, 2 skipped.
- `tests/unit/program-scrub.test.ts`, `playback*.test.ts`, `program-*.test.ts`, `keyframes-playback.test.ts`: 99 passed.
- e2e under xvfb, heavy lock held: `program.spec.ts` 5/5 (with the new test); `timeline`, `nest`, `keyframes`,
  `program-present`, `program-transitions` and `compare` specs: 14/14; `tests/attack/e2e` (`chromium-seek.spec.ts`): 4/4.
- `npm run perf:check -- --runs 2`: see `docs/attack/performance.md` → "Program scrub stall and pool row".

### Changed existing assertions

None. The fake `<video>` in `program-scrub.test.ts` gained the opt-in `stalled` flag; the existing tests never set it.

### Compatibility risks

None for projects or exports. Playback timing: a scrub over an element whose seek is slow now restarts that seek
after 1 s to the latest playhead (then waits 2 s, 4 s, …), where it used to wait for it.

### Follow-ups

- Chromium's trigger is still unknown. The perf bench probe (`mkprobe.mjs`, session scratchpad) logs the stuck
  element's DOM events and its media-internals events before every scrub row; if the bench shows a stall again, run
  it to capture them.
- `docs/ARCHITECTURE.md` describes scrub rounds; it could mention `SEEK_STALL_MS` (not edited here: outside this
  task's files).
