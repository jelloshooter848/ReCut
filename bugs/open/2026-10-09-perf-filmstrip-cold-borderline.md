# Perf gate: "filmstrip 48 frames cold" sits on its 3,000 ms guardrail

| Field | Value |
|---|---|
| Status | open |
| Severity | low |
| Area | media/FFmpeg / performance gate |
| Reported by / date | Claude (split from bugs/closed/2026-10-08-perf-multi-hour-scrub-long-tasks-flaky.md), 2026-10-09 |
| Found on commit | 37912dd (`claude/perf-gate-080`); `electron/media/thumbs.ts` unchanged since 0.7.0 |
| Environment | 4-core cloud container of the reference class, Linux 6.18, Node 22.22.0, FFmpeg 6.1.1-3ubuntu5 |

## Report

### Summary
The node guardrail `main | thumbs | filmstrip 48 frames cold (4 ffmpeg batches of 12, 3 concurrent)` (≤ 3,000 ms) is
within about 10 % of its budget, so a run on a slightly busy machine fails it. The baseline median is 2,984 ms, and
the row was over budget in 1 of its 2 seed runs.

### Steps to reproduce
1. On a quiet machine, holding the perf lock:
   `NODE_OPTIONS=--expose-gc npx vitest run -c tests/perf/vitest.config.ts tests/perf/main.perf.test.ts -t "thumbnail: miss vs hit"`.
2. Read the row in `test-results/perf/main.json`. Repeat 3 times.

### Expected
Comfortably under 3,000 ms on the reference machine.

### Actual
- 8 October gate re-run: 3,036 and 2,859 ms. One run earlier that day at load 4.1: 3,007 ms.
- 9 October (perf:check --runs 2 and 3 single runs, quiet): 2,528, 2,706, 2,604, 2,609 and 2,561 ms.

So it passes on a quiet machine by 10–15 %. It cannot absorb the ±10 % calibration tolerance or a little load.

### Evidence
`docs/attack/performance.md` → "Gate re-run on 0.8.0" and "Multi-hour scrub long tasks: root cause and fix".

### Suspected cause (hypothesis)
`getFilmstrip` (`electron/media/thumbs.ts`) splits the 48 uncached times into batches of `FILMSTRIP_BATCH` = 12 and runs
them through a semaphore of `MAX_CONCURRENT` = 3. So 3 batches run together, then the 4th runs alone: the wall time
is about two batch times. Each input of a batch seeks with `-ss` and decodes from the preceding keyframe of a 720p
x264 file (default GOP of 250 frames, up to about 10 s of decoding per frame).

Balanced batches, about `ceil(n / (3 × rounds))` frames each, would finish 48 frames in one or two even rounds: 3
batches of 16, or 6 of 8. Note that the row's name encodes the batch layout ("4 ffmpeg batches of 12, 3
concurrent"). A change to the batching therefore needs a renamed row, which starts a new baseline key. It also
needs the owner's agreement and the guardrail note in docs/DEVELOPMENT.md. The Electron row `main: filmstrip 48
frames cold via IPC` measures 731–757 ms on the bench's own media and is not affected.
