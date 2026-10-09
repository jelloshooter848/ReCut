# Perf gate: "media elements created during 10 s playback" reads 1–2 against a seed of 0

| Field | Value |
|---|---|
| Status | open |
| Severity | low |
| Area | playback / performance gate |
| Reported by / date | Claude (split from bugs/closed/2026-10-08-perf-multi-hour-scrub-long-tasks-flaky.md), 2026-10-09 |
| Found on commit | 37912dd (`claude/perf-gate-080`); also on 0.7.0 |
| Environment | 4-core cloud container of the reference class, Linux 6.18, Node 22.22.0, FFmpeg 6.1.1, xvfb with software GL, source build |

## Report

### Summary
The guardrail `electron | pool | media elements (<video> + <audio>) created during 10 s playback @ 1 px/frame`
(count, baseline median 0, zero-baseline tolerance 1) reads 0–2 on every build since the seed. A median of 1.5 or 2
fails the zero-baseline rule, so `npm run perf:check -- --runs 2` can fail on this row with no change to the
playback code. The row's own budget (≤ 16, the pool capacity) always passes.

### Steps to reproduce
1. On a quiet machine, holding the perf lock: `npm run build`, then
   `xvfb-run -a -s "-screen 0 1920x1080x24" node tests/perf/electron-perf.mjs`.
2. Read the `pool` row in `test-results/perf/electron.json`. Repeat 3 times.

### Expected
0, as in the seed runs.

### Actual
- 8 October gate re-run: R1 1, R2 2, B1–B3 2, 2, 2, A1–A3 (0.7.0) 1, 2, 1, V1 2, V2 0.
- 9 October, after the shared-memory fix of the multi-hour scrub bug: 2, 2, 1. That fix did not change it, so the
  cause is not shared.

### Evidence
`docs/attack/performance.md` → "Gate re-run on 0.8.0" and "Multi-hour scrub long tasks: root cause and fix".

### Suspected cause (hypothesis)
The Program player pools elements per (file, kind, slot) in a 16-element LRU pool (`src/app/media.ts`,
`src/playback/elementPool.ts`). An element is created the first time a (file, slot) pair is needed while not in the
pool. Before the playback row, the bench scrubs the 2,500-clip sequence. While paused, the Program monitor follows
the playhead and acquires elements for whatever files the scrub rounds land on. Which rounds land depends on timing:
a round waits for its seeks. So the pool's content when playback starts varies from run to run, and 10 s of playback
then needs 0–2 pairs that are not pooled. Those creations are legitimate, not churn. The row was meant to catch
per-clip or per-frame churn (7,471 creations before the fix).

To check: log the pool's keys at the start of the row, and the (path, role) of each creation during it, in a
passing and a failing run.

Possible resolutions, for the owner:
- (a) Measure steady state: count creations during a second 10 s playback of the same range.
- (b) Re-seed the row's baseline from more runs, with a stated reason.
- (c) Make the pool content deterministic before the row, e.g. play the range once untimed.

Each of these changes the bench or the baseline, so it needs the owner's decision (docs/DEVELOPMENT.md → Baseline).
