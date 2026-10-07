# Performance gate fails 15 of 98 gates on unchanged code on the same class of machine as its baseline

| Field | Value |
|---|---|
| Status | fixed |
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

| Field | Value |
|---|---|
| Verified by / date | Claude (Claude Code session, branch `claude/perf-calibration`), 2026-10-07 |
| Verified on commit | 196c4b1 (main, 0.4.1) + the perf tooling of this branch, which does not change measured app code |
| Verdict | confirmed |

The gate's verdict depended on the host, not the code. Reproduced three ways on one 4-core container (Intel Xeon @
2.10GHz, the same model string as the 0.3.0 baseline host), all scratch output kept under the session scratchpad
(`calib/seed.log`, `calib/seed2.log`, `calib/evidence-{a,b,c1,c2,c3}.txt`):

- **Same host, different load.** Two runs of identical code minutes apart: the first, started while the load of an
  earlier job was still decaying (5-minute load 2.0), measured `ffmpeg wall time @ 100 clips` 2,972 ms against
  1,452 ms in the second, and scrubbed the 3 h sequence at 1 px/frame at 48.1 against 56.5 fps (FAIL / PASS).
- **Simulated slow host.** The whole perf-check process tree duty-cycled with SIGSTOP / SIGCONT (stopped 4 of every
  10 ms; Xvfb keeps real time), about 1.7–2.1× slower: raw 66 of 98 gates and 88 of 130 guardrails pass on identical
  code (3 h scrub at 1 px/frame 30.7 fps, open 1,458 ms, switch ×20 136 ms, project search keystroke 88 ms, store
  razor ×2.21 and FFmpeg ×1.92 "regressions").
- The suspected cause was right: nothing in `perf-check.mjs` knew how fast the host was; `machine` was written to the
  baseline and never read. Busy neighbours also showed the categories differ: with a busy loop on every core, Node
  work slowed 2× but the Electron renderer, which Chromium runs at nice -8 as root, 1.1×.

---

## Resolution

| Field | Value |
|---|---|
| Closed by / date | Claude (Claude Code session), 2026-10-07 |
| Fix | branch `claude/perf-calibration` (614c2ef, 49c5222, ada2657 and the commit that closes this file) |
| Files changed | `tests/perf/calibrate.mjs` (new), `tests/perf/_gate.mjs` + `_gate.d.mts` (new), `tests/perf/perf-check.mjs`, `tests/perf/perf-compare.mjs` (new), `tests/perf/electron-perf.mjs`, `tests/perf/vitest.config.ts`, `tests/perf/baseline.json`, `package.json` (script `perf:compare`), `tests/unit/perf-gate.test.ts` (new), `docs/DEVELOPMENT.md`, `docs/LIMITATIONS.md`, `docs/ROADMAP.md` §1 |
| Regression test | `tests/unit/perf-gate.test.ts` → "verdicts › the same code on a slower host: raw FAIL, normalized PASS (the bug)" and "a fast host does not hide a regression" (22 tests in the file) |

### Root cause
The gate compared raw measurements with absolute budgets and with a baseline from one host, and had no model of the
host's speed. Cloud hosts of one nominal class differ 1.5–2.3× in real speed (and one host differs with its load),
which is more than the guardrails' ×1.5 rule and more than the headroom of many gates.

### Fix
- **Calibration** (`tests/perf/calibrate.mjs`): before each run, three fixed workloads, each a median of 9–11 repeats
  after a warm-up, with min–max and interquartile spread (`NOISY` over 15 %): `js` (store/timeline-shaped pure JS),
  `ffmpeg` (a fixed one-thread 720p x264 encode), `render` (style + layout + canvas raster inside Electron with
  software GL). Written to `<run dir>/calibration.json`; repeats within about ±5 % on a quiet host.
- **Reference machine**: `baseline.json` (format 2) records the calibration of the machine it was seeded on. Each run
  computes `k = this host / reference` per category (median over the runs); each row uses one category (FFmpeg media
  work → ffmpeg, other Electron rows → render, Node suites → js).
- **Verdicts**: within ±10 % every row is judged raw; beyond it, time rows are judged at `value / k`, rates at
  `min(cap, value × k)` (cap 60, or 24 for playback; a capped rate on a faster host stays raw), long-task counts by
  re-counting the recorded task durations against `50 ms × k` (`electron-perf.mjs` now records them), and counts /
  structural rows never. Gates keep their budgets; guardrails get the regression rule on the normalized value. The
  summary prints the machine next to the baseline's, the calibration and `k`, the load average, "VERDICTS NORMALIZED
  TO THE REFERENCE MACHINE (calibration …)", and the raw verdicts and counts beside the normalized ones.
- **Same-host A/B**: `npm run perf:compare -- <refA> <refB>` (or `perf-check.mjs --ab <dirA> <dirB>`) runs two
  checkouts interleaved and flags rows where B is worse than A beyond a noise band in every run pair; no baseline
  needed.
- The node suite's timeouts scale with `k` (the full export took over 15 minutes on the simulated slow host).
- Rules in `tests/perf/_gate.mjs` (pure, unit-tested); prose in `docs/DEVELOPMENT.md` → Performance gate.
- **Baseline re-seeded** (format change): two quiet full runs on this branch on the container above; calibration
  js 80.16 ms, ffmpeg 451.81 ms, render 241.6 ms.

### Before / after
- (a) This host as-is, against the new baseline (the two runs of "same host, different load" above): calibration
  `k` js 0.98, ffmpeg 1.08, render 1.06, within ±10 %, so every verdict is raw; gates 95 of 98 (the 3 h scrub at
  1 px/frame and two long-task rows failed in the loaded run only), guardrails 127 of 130. The two quiet seed runs:
  98 of 98 gates.
- (b) Simulated slow host (k js 1.84, ffmpeg 1.68, render 2.08), unchanged code: gates raw 66 → **normalized 97 of
  98**, guardrails raw 88 → **normalized 126 of 130**. Examples: 3 h scrub 30.7 fps → 60 (cap), open 1,458 → 701 ms,
  switch ×20 136 → 66 ms, razor commit → paint 34.3 → 16.5 ms, store razor guardrail ×2.21 → ×1.20, FFmpeg @ 100
  clips ×1.92 → ×1.14. Still failing normalized: `switch to big sequence -> first paint @ zoom-to-fit` (1 of 2 runs
  at 100.1 ms; the SIGSTOP simulation stretches vsync-bound rows more than a slower CPU would), two sub-5 ms tail
  rows (p95 / max, inflated by the 4 ms stops themselves), and two rows that also fail on the reference machine
  (`filmstrip 48 frames cold` over its 3,000 ms budget, `media elements created during 10 s playback` 0 → 1, see
  Follow-ups).
- (c) A real regression (a 12 ms busy loop in the store's `commit`, scratch copy only): the calibrated gate (k ≈ 1)
  fails it (`project search keystroke -> paint` 172 ms against a 50 ms budget, 0 of 2 runs; commit → paint rose
  9–13 ms but stays under its 32 / 50 ms budgets); the node suite (`--node-only --runs 2`) fails 19 store-commit
  guardrails (regression ×2.3–×77, e.g. razor 3.74 → 15.99 ms, moveClips 0.79 → 12.93 ms; undo / redo unaffected); the
  A/B (`npm run perf:compare -- HEAD <copy> --electron-only`, 2 runs each, 23 min) flags 11 gates WORSE (every
  commit → paint row ×1.42–1.75, first edit after open ×1.22–1.52, project search ×1.70) and leaves undo / redo (no
  `commit`) "same".

### Regression test proof
`tests/unit/perf-gate.test.ts` encodes the report's failing rows (3 h scrub 37.7–44.2 fps, switch 128.7–139.7 ms,
open 782–1,349 ms, a 64–71 ms long task, store razor 7.24 ms against 3.65, FFmpeg 3,390 ms against 1,453) with
`k` js 1.98, ffmpeg 2.33, render 1.9: raw, 4 gates and 2 guardrails fail (what the old gate printed); normalized,
all pass. On the old `perf-check.mjs` there was no normalization, so the raw verdicts were the verdicts.

### Tests run
Linux 6.18 container (xvfb): `npm run typecheck` clean; `npm test` 1264/1264 (68 files; 22 new in
`tests/unit/perf-gate.test.ts`, 12 new in `tests/unit/prefs-concurrency.test.ts` for the prefs follow-ups on the same
branch); full e2e suite 62/62 (`main.ts` changed for the prefs follow-up). Performance: `npm run perf:check -- --runs 2`
four times (2 seed + 2 to re-seed), twice more under the slow-host simulation, `--electron-only --runs 2` and
`--node-only --runs 2` on the regressed copy, and `npm run perf:compare -- HEAD <copy> --electron-only` (2 runs
each). Not run: a real slower host, Windows, macOS.

### Changed existing assertions
None. `perf-check.mjs`'s aggregation and verdict code moved to `tests/perf/_gate.mjs` unchanged in behaviour for
`k = 1`.

### Compatibility risks
None for the app. Old result folders without `calibration.json`, and a baseline without calibration, are judged raw
as before. `baseline.json` now has `format: 2` and `calibration`.

### Follow-ups
- Re-seeding moved three guardrails against the 0.3.0 seed (main changed since): panels search keystroke → rows
  rebuilt (max) 6.29 → 10.52 ms, autosave main-side handler 44.9 → 83.6 ms, filmstrip 48 frames cold 2,772 → 2,984 ms
  (over its 3,000 ms budget in about half the runs, on the reference machine too). Worth a look by the owner.
- `media elements (<video> + <audio>) created during 10 s playback` is 0 in the new baseline and 1 in some runs of
  identical code; counts have no regression floor, so 0 → 1 fails as `x∞`. A floor of 1 for count rows, or a
  re-seed that sees the 1, would stop the flip; owner's call (it changes the regression rule).
- Budgets are unchanged (owner's call): on the reference machine the 3 h scrub at 1 px/frame (54–57 fps quiet, 48 fps
  loaded) and its long-task rows have little headroom.
