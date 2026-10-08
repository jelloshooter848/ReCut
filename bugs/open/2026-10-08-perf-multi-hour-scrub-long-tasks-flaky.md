# Perf gate: multi-hour scrub at 1 px/frame has 50–155 ms long tasks in about half the runs

| Field | Value |
|---|---|
| Status | open |
| Severity | medium |
| Area | timeline / performance gate |
| Reported by / date | Claude (perf gate re-run on 0.8.0), 2026-10-08 |
| Found on commit | 3b9ffdf (main, 0.8.0 + PR #92); also on 0.7.0 (2aaf2c0) |
| Environment | 4-core cloud container of the reference class (Xeon 2.10 GHz, 16 GB), Linux 6.18, Node 22.22.0, FFmpeg 6.1.1-3ubuntu5, xvfb with software GL, source build |

## Report

### Summary
The gate `electron | long | long tasks during scrub multi-hour @ 1 px/frame, no selection` (budget `== 0`) fails in
about half the runs, on 0.7.0 and on 0.8.0 alike. With `--runs 2` a gate must pass in both runs, so `npm run
perf:check` is not reproducibly green on the reference-class container. That leaves the 1.0 criterion "The
performance gate passes" (docs/ROADMAP.md, Ready for 1.0, item 7) open. A user scrubbing a 3 h sequence at
1 px/frame sees 2–5 hitches of 50–155 ms in the 3 s drag, about one run in two.

### Steps to reproduce
1. On a quiet machine, holding the perf lock: `npm run build`, then
   `xvfb-run -a -s "-screen 0 1920x1080x24" node tests/perf/electron-perf.mjs`. Or run
   `node tests/perf/perf-check.mjs --electron-only --skip-build`.
2. Read the row `long tasks during scrub multi-hour @ 1 px/frame, no selection` in `test-results/perf/electron.json`
   (`value` is the count, `longTasks` the durations in ms).
3. Repeat 3–5 times.

### Expected
0 long tasks in every run, as in the seed runs of the baseline (`calib/seed2`, 7 October: 0 and 0).

### Actual
Results of the same-host runs on 8 October, quiet machine, perf lock held. The lists are task durations in ms.

| Build | Runs | Values |
|---|---|---|
| main 3b9ffdf | 7 | 2 [109, 85], 3 [87, 100, 58], 0, 0, 0, 4, 0 |
| 0.7.0 2aaf2c0 | 3 | 5 [57, 80, 74, 60, 62], 4 [114, 118, 101, 85], 3 [82, 104, 81] |

The 0.7.0 runs were interleaved with three of the main runs (`perf-check.mjs --ab`).

In earlier result folders since the row was added on 6 October, it reads 0 to 7 on every build. For example, the
`i5/ab-iso` A/B on 7 October (pre-0.8.0 code) gave 4, 3, 0 and 7. The other multi-hour scrub variants nearly always
read 0: 50 clips selected, within the visible page, and zoom-to-fit.

### Evidence
- `docs/attack/performance.md` → "Gate re-run on 0.8.0 (8 October 2026)": the full table, and the A/B result
  (B better than A on this row: 0 [0–0] against 4 [3–5]).
- `bugs/closed/2026-10-05-perf-budgets-2500-clips.md` → Follow-ups already lists "first-visit page-flip cost on the
  3 h sequence on a loaded machine" as possible future work.

### Suspected cause (hypothesis)
This row has not been profiled. The counting pass of the same scrub records about 176–180 page flips: every page
flip mounts a newly visible page of the 3 h sequence. The long tasks are probably first-visit page flips, which
mount clips and request filmstrips and waveforms, and land in the timing pass when the counting pass has not already
visited those pages. A hypothesis to check: whether the run order (counting pass, then timing pass) and caching in
`src/panels/timeline` decide when a page counts as visited. Profile it with `electron-cpuprof.mjs` adapted to this
scenario, or with a Chromium trace of the timing pass, and compare a run with long tasks against one without.

### Scope
Two related rows also keep the gate from being reproducibly green. Neither is a 0.8.0 change.
- `main | thumbs | filmstrip 48 frames cold` (guardrail, ≤ 3,000 ms): 3,036 and 2,859 ms on 8 October. The baseline
  median is 2,984 ms and was over budget in 1 of its 2 seed runs.
- `electron | pool | media elements created during 10 s playback @ 1 px/frame` (guardrail, count, baseline 0,
  tolerance 1): it reads 0–2 on every build since the seed, including 1 and 2 on code equal to the baseline's playback
  code. The seed's 0 / 0 was the low end, so medians of 1.5–2 fail the zero-baseline rule.

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
