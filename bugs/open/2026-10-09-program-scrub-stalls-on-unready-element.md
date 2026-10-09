# Program monitor can stop following a fast scrub (no seeks for the whole drag)

| Field | Value |
|---|---|
| Status | open |
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
