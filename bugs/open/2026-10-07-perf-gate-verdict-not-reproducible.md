# Performance gate fails 15 of 98 gates on unchanged code on the same class of machine as its baseline

| Field | Value |
|---|---|
| Status | open |
| Severity | medium (no wrong output; the gate that decides whether large features may start gives a different verdict on identical code, and the 0.3.0 performance numbers do not reproduce on a comparable machine) |
| Area | performance / test tooling · docs |
| Reported by / date | Claude (Claude Code session), testing 0.3.0 at the project owner's request, 2026-10-07 |
| Found on commit | 6b59577 (app code identical to the baseline commit bd60227: `git diff bd60227 6b59577 -- src shared electron` is empty) |
| Environment | Linux 6.18.44-fc-v77, 4 cores, Intel(R) Xeon(R) Processor @ 2.80GHz, 16 GB, Node v22.22.0, FFmpeg 6.1.1-3ubuntu5, xvfb + software GL. Nothing else running (checked with `ps`). Second run: 1-minute load 1.75–1.93 at the start of each stage, below the gate's "busy" threshold of 2.0, which the gate waits for |

## Report

### Summary

`npm run perf:check -- --runs 2` on 6b59577 fails: **83 of 98 gates and 118 of 130 guardrails pass**. The release
(0.3.0, Roadmap §1 "done") recorded 98 of 98 and 130 of 130 on bd60227, which has the same app code. The baseline in
`tests/perf/baseline.json` was recorded on the same class of machine: 4 cores, an Intel Xeon (2.10 GHz there,
2.80 GHz here), 16 GB, the same kernel, Node and FFmpeg. So the gate's verdict depends on which cloud host a run lands
on, not on the code.

Everything else on 6b59577 passes: typecheck, unit tests (1,150), attack-qa (84), media attack (102), end-to-end
including the acceptance gauntlet (52; 17/17, 21/21, 22/22, 11/11 steps), and the smoke launch.

### Steps to reproduce

1. Check out 6b59577 (or bd60227) on a 4-core cloud container, `npm ci`.
2. Run `npm run perf:check` twice, alone, saving `test-results/perf` after each run.
3. `node tests/perf/perf-check.mjs --from <run1> <run2>`.

### Expected

The same code gives the same verdict on the machine class the baseline was recorded on: 98 of 98 gates and 130 of
130 guardrails, as recorded for 0.3.0.

### Actual

```
[perf:check] gates:       98, PASS 83, FAIL 15
[perf:check] guardrails:  130, PASS 118, FAIL 12 (budget 1, regression 11, missing 0); unconfirmed 0; no baseline 0
[perf:check] RESULT: FAIL
```

Failing gates (median of 2 runs, [runs passed, min–max]):

| Gate | Budget | Here | 0.3.0 record |
|---|---|---|---|
| 3 h sequence scrub fps @ 1 px/frame, no selection / 50 selected | ≥ 50 | 41.2 / 41.0 fps [0/2, 37.7–44.2] | 59.2 / 58.9 |
| Switch to big sequence → first paint @ zoom-to-fit | ≤ 100 ms | 134.2 ms [0/2, 128.7–139.7] | 49.0 |
| Switch sequence ×20 → paint (median) | ≤ 100 ms | 108.6 ms [0/2, 107.2–110] | 70.7 |
| openProject round trip | ≤ 1,000 ms | 1,065 ms [1/2, 782–1,349] | 714 |
| saveProject round trip | ≤ 500 ms | 450 ms [1/2, 333–567] | 214 |
| Scrub fps @ 1 px/frame (~120 clips) | ≥ 50 | 51.2 fps [1/2, 49.2–53.1] | 58.5 |
| Long tasks during scrub @ 1 px/frame, no selection / 50 selected | == 0 | 2.5 [1/2] / 1 [0/2] | 0 / 0 |
| 3 h long tasks during scrub, 50 selected | == 0 | 1 [1/2] | 0 |
| Wheel ×100 event → render (median) | ≤ 8 ms | 7.95 ms [1/2, 7.8–8.1] | ~6 |
| Project search worst keystroke → paint | ≤ 50 ms | 60 ms [0/2, 56–64] | pass |
| Transcript search worst keystroke → paint | ≤ 50 ms | 56 ms [1/2, 48–64] | pass |
| Scenes filter worst keystroke → paint | ≤ 50 ms | 56 ms [1/2, 40–72] | pass |
| 3 h insert (ripple) commit → paint | ≤ 50 ms | 43.4 ms [1/2, 33.6–53.1] | pass |

Guardrail "regressions" on identical code, including pure-JS and native work that cannot depend on the host's GPU:

| Guardrail | Baseline | Here |
|---|---|---|
| store commit: razor all tracks (median) | 3.65 ms | 7.24 ms (×1.98) |
| store commit: insertFromSource insert/ripple (median) | 3.7 ms | 6.73 ms (×1.82) |
| store commit: setClipSpeed ripple (median) | 2.04 ms | 4.11 ms (×2.01) |
| export graph: buildRenderGraph @ 500 clips (median) | 4.14 ms | 6.64 ms (×1.60) |
| ffmpeg wall time @ 100 clips (native FFmpeg) | 1,453 ms | 3,390 ms (×2.33) |
| io: normalizeProject (median of 3) | 109.5 ms | 169.8 ms (×1.55) |

### Evidence

- Both runs' raw output (`test-results/perf/*.json`, about 100 KB each) were kept outside the repo; the tables above
  are from `perf-check.mjs --from run1 run2`.
- `tests/perf/baseline.json` → `machine`: `nproc 4`, `Intel(R) Xeon(R) Processor @ 2.10GHz`, `memGB 16`,
  `linux 6.18.44-fc-v77`, `node v22.22.0`, FFmpeg 6.1.1, "quiet machine, load 0.7-2.8".
- `perf-check.mjs` writes `machine` into the baseline (`tests/perf/perf-check.mjs:212`) but never reads it back: no
  comparison, no warning when the current machine or its speed differs, no calibration.

### Suspected cause (hypothesis)

Cloud hosts of the same nominal class differ in real speed by about 1.5–2.3× here (pure-JS store commits ×1.8–2.0,
native FFmpeg ×2.3, with no code change). Many gates pass with little headroom on a fast host, and the guardrail rule
(×1.5 against an absolute baseline) is narrower than that host-to-host spread. Not caused by ReCut code: nothing in
`src`, `shared` or `electron` differs from the baseline commit.

### Suggested direction (for whoever works this)

- **Calibrate.** Run a short fixed CPU benchmark (pure JS, and one small FFmpeg encode) at the start of each run,
  store its result with the baseline, and report every guardrail ratio scaled by the calibration ratio. Then a slow
  host is not a regression and a fast host does not hide one.
- **Report the machine.** Print the current machine next to the baseline's, and the calibration ratio, at the top of
  the summary.
- **Decide what the gates promise.** Either budgets hold on a slow 4-core host (more headroom, as a fan editor's
  laptop may be slower than either container), or the claim names the reference machine and its calibration score.
  Owner's call.
- The one user-visible gap here is scrubbing the 3 h sequence at 1 px/frame: about 41 fps, not 59, sustained over
  both runs on an idle machine. `docs/LIMITATIONS.md:135` and `CHANGELOG.md:60` describe only a brief first-visit
  stutter "on a heavily loaded machine".

### Scope

- `docs/ROADMAP.md:15-17`: §1's "Why" still says "every edit still takes 80–120 ms … scrubbing at working zoom runs
  at 32–35 fps … opening the project freezes the window for about 3 s", above its "Status: done" line (`:32`). Reword
  as history or remove.
- Any future baseline re-seed inherits the same problem.
- Main has moved past 6b59577 (for example #42 changes `src/state/store.ts`); these measurements are for the 0.3.0
  code, not for later commits.

---

## Verification
<!-- Filled in by whoever works the bug. -->

| Field | Value |
|---|---|
| Verified by / date | |
| Verified on commit | |
| Verdict | |

---

## Resolution
<!-- Required before moving the file to bugs/closed/. -->

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
