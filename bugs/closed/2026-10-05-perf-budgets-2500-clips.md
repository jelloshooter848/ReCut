# 2,500-clip project still misses edit, scrub, open/save and serialization budgets

| Field | Value |
|---|---|
| Status | fixed |
| Severity | medium (no wrong output; on a franchise-scale project every edit lags 80–120 ms, scrubbing at working zoom runs at 32–35 fps, and opening freezes the window for about 3 s) |
| Area | performance (store / renderer / project I/O) |
| Reported by / date | Claude (Claude Code session, working bugs/closed/2026-10-05-roadmap-revisions.md), 2026-10-05 |
| Found on commit | e89fc8b (no source changes since 92eb1f1) |
| Environment | Shared Linux cloud container, 4 cores, xvfb + software GL, FFmpeg 6.1.1-3ubuntu5, built app (`npm run build`). The suites ran one at a time, but other agents may have used the machine; the 2026-10-04 report estimates ±30 % noise. |

## Report

### Summary

The performance attack of 2026-10-04 (`docs/attack/performance.md`, commit d13dd2b) was re-measured on e89fc8b.
Most of its P1/P2 findings are fixed: Program playback holds 24 fps (was 1.7–5 fps), scrubbing at zoom-to-fit runs at
59 fps (was 7.3), autosave takes 446 ms and no longer stalls playback (was 1.6 s / 6 s), and the chunked export of the
whole 2,500-clip sequence completes (was an FFmpeg OOM). The rows below still exceed the budgets the scripts assert.

### Steps to reproduce

```
NODE_OPTIONS=--expose-gc npx vitest run -c tests/perf/vitest.config.ts          # node benches, ~10 min
npm run build && xvfb-run -a -s "-screen 0 1920x1080x24" node tests/perf/electron-perf.mjs   # Electron, ~12 min
```

Both build the 2,500-clip / 60-media / 3,000-scene / 8,000-cue / 12-sequence project from `tests/perf/bigProject.mjs`
(27.3 MB compact JSON; the big sequence is 37,560 frames = 26 min at 24 fps).

### Expected

Edits ≤ 32 ms commit → paint, scrubbing ≥ 50 fps, ≤ 100 ms for "instant" UI, save ≤ 500 ms, open ≤ 1,000 ms (the
thresholds in the scripts, see `docs/attack/performance.md` → Measurements).

### Actual

Electron (`electron-perf.mjs`; 57 rows PASS, 28 FAIL). Over-budget rows, with the 2026-10-04 value in brackets:

| Metric | Value | Budget | 2026-10-04 |
|---|---|---|---|
| Edit commit → paint (median): insert overwrite / insert ripple / razor / move / ripple delete / undo / redo | 109 / 122 / 115 / 84 / 92 / 80 / 80 ms | ≤ 32 ms (ripple ≤ 50) | 309 / – / 297 / 431 / 819 / 280 / – |
| 300 mixed commits with UI mounted | 9.2 s, 31 long tasks (max 370 ms) | — | 25.3 s, max 1,579 ms |
| Scrub fps @ 1 px/frame (no selection / 50 selected) | 35.3 / 31.8 fps; 13 long tasks (max 67 ms) | ≥ 50 fps, 0 long tasks | 4.1 fps |
| ClipView renders / DOM mutations per scrub frame @ 1 px/frame | 20.8 / 44.6 | 0 | 20.5 / 43.9 |
| setView cost with 50 clips selected (median) | 1.2 ms (max 6.2) | ≤ 1 ms | — |
| Wheel scroll @ 1 px/frame, event → render (median) | 10.6 ms (p95 18.7); 58.8 fps | ≤ 8 ms | 57.6 ms, 16.2 fps |
| Switch to big sequence → first paint @ zoom-to-fit / 1 px/frame | 136.5 / 100.6 ms; 3 long tasks after the switch | ≤ 100 ms, ≤ 1 | 3,516 / 567 ms |
| Switch sequence ×20 → paint (median) | 115.9 ms (max 175) | ≤ 100 ms | 517 ms |
| Program playback long tasks @ zoom-to-fit | 3 (max 51 ms) | ≤ 2 | — |
| Program playback @ 1 px/frame | 24.1 fps (PASS) but one long task of 1,503 ms | — | 5.0 fps |
| saveProject round trip | 2,004 ms | ≤ 500 ms | 2,861 ms |
| openProject round trip / main-side handler | 4,348 ms (one 3,012 ms long task) / 735 ms | ≤ 1,000 / ≤ 500 ms | 3,174 ms (2,502 ms long task) |
| JSON.stringify / structuredClone(project) in renderer | 134 / 292 ms | ≤ 100 ms | 162 / 340 ms |

Node (`tests/perf/*.perf.test.ts`; 15 passed, 1 failed, 1 skipped; the failure is
`bugs/open/2026-10-05-export-perf-inputcount-stale.md`). Over-budget recorded rows:

| Metric | Value | Budget | 2026-10-04 |
|---|---|---|---|
| insertFromSource insert/ripple commit (median) | 25.1 ms | ≤ 16 ms | 101.7 ms |
| razor all tracks commit (median) | 25.7 ms | ≤ 16 ms | 22.7 ms |
| moveClips 1 clip insert/ripple commit (median) | 16.3 ms | ≤ 16 ms | 146.0 ms |
| serializeProject (pretty JSON, median of 3) | 704 ms (344 ms on 92eb1f1 earlier the same day) | ≤ 100 ms | 319 ms |
| JSON.parse (median of 3) | 168 ms | ≤ 100 ms | 181 ms |
| normalizeProject (median of 3) | 122 ms | ≤ 100 ms | 91.5 ms |
| structuredClone(project) (median of 3) | 292 ms | ≤ 100 ms | 340 ms |
| sequenceDuration (mean) | 0.28 ms | ≤ 0.2 ms | — |
| filmstrip 48 frames cold (node, 20-min file) | 4,557 ms | ≤ 3,000 ms | 1,510 ms (via IPC) |

The Electron run measured the same filmstrip at 1,094 ms (PASS), so the node row may be load or file dependent.

### Evidence

Raw output of both runs is in the session scratchpad. The JSON results are written to `test-results/perf/`
(`store.json`, `main.json`, `export.json`, `panels.json`, `electron.json`) on each run.

Also recorded, without a budget:
- `<video>` elements created: 7,471 after 10 s of playback, 10,213 after 20 sequence switches (16 live). Audio
  `GainNode`s 1,718 → 1,875 and `MediaElementSource`s 3,798 → 5,169 after 20 switches (P-12 of the 2026-10-04 report:
  `trackGains` is still not pruned).
- Single-graph FFmpeg parse at 2,500 clips (1,258 inputs) is still killed at 6 GB RSS. Export does not use that path
  (it is chunked: 18 chunks, 37,560 / 37,560 frames, peak RSS 844 MB, 469 s at 1280×720 ultrafast).

### Suspected cause (hypothesis)

- Edit latency: a full TimelineBody pass plus derived data per commit; store commits that ripple still cost
  16–26 ms in node (`reconcileTransitions` / `reconcileAll` were sped up but still visit every track).
- Scrub at 1 px/frame: ~21 ClipView renders and ~45 DOM mutations per frame where 0 is expected, so the in-place
  playhead path still re-renders mounted clips at working zoom.
- Open / save / clone: whole-project JSON and structured clone of a 27 MB project on the main thread; normalize runs
  in main and again in the renderer (P-06, P-13).
- The serializeProject number doubled between two runs on the same code, so treat it as noisy until re-run alone.

### Scope

- Multi-hour sequences are not covered: the big sequence is 26 min. Add a 2–4 h sequence to `bigProject.mjs` before
  calling the target scale met.
- `docs/ROADMAP.md` §1 (Performance at franchise scale) tracks this as a gate before the next large feature.

---

## Baseline (2026-10-06)

Roadmap §1 Phase 0: a repeatable baseline and one pass/fail gate. Measured by Claude (Claude Code session) on
`main` at 53f619c (no source change to the store, timeline, renderer or project I/O since e89fc8b; only
`electron/export/*`). Same container class as the report: `nproc` 4, FFmpeg 6.1.1-3ubuntu5, Node 22.22.0, xvfb +
software GL. Each suite ran alone, one at a time; the 1-min load average before each run was 0.3–3.2 (it stays
around 2 on this VM even with nothing of ours running, so treat it as a rough signal only).

### Gate

```
npm run perf:check                 # node suite, build, electron-perf.mjs, one PASS/FAIL table; exit 1 on any FAIL
npm run perf:check -- --runs 2     # median of 2 runs; a row passes only if it passed in more than half of them
npm run perf:check -- --from <dir> [<dir> …]   # aggregate earlier result folders without running
```

`tests/perf/perf-check.mjs` reads `test-results/perf/{store,panels,main,export,electron}.json` and gates on every row
that carries a threshold. The thresholds are only the ones the benches already pass to `ms()` / `record()` / `rec()`
(no budget was changed or loosened). One run takes about 15 min here (node 9 min, build 15 s, Electron 4.5 min).
See `docs/DEVELOPMENT.md` → Performance gate. On the branch that adds it (2 runs): **223 budgeted rows, 167 PASS,
56 FAIL → RESULT: FAIL** (exit 1). That is the expected Phase 0 result: the gate is red until Phase 1 lands.

### Noise: per-metric median and spread on 53f619c

Three node runs (`NODE_OPTIONS=--expose-gc npx vitest run -c tests/perf/vitest.config.ts`, 8.7–9.0 min each, 16
passed / 1 skipped every time) and three Electron runs (`electron-perf.mjs`, 3.6–3.9 min each). Value = median of
the 3 runs, spread = min–max. "Reliable" = failed in 3/3 runs; "flaky" = failed in 1 or 2 of 3. Every other
budgeted row passed in 3/3 runs.

Node (`tests/perf/*.perf.test.ts`, 96 budgeted rows):

| Metric | Median (min–max) | Budget | Verdict |
|---|---|---|---|
| insertFromSource insert/ripple commit (median) | 23.3 ms (23.0–23.9) | ≤ 16 ms | reliable FAIL |
| razor all tracks commit (median) | 25.4 ms (25.1–26.0) | ≤ 16 ms | reliable FAIL |
| moveClips 1 clip insert/ripple commit (median) | 16.2 ms (14.0–16.5) | ≤ 16 ms | flaky (2/3 FAIL) |
| serializeProject (pretty JSON, median of 3) | 326 ms (325–335) | ≤ 100 ms | reliable FAIL |
| JSON.parse (median of 3) | 158 ms (154–164) | ≤ 100 ms | reliable FAIL |
| normalizeProject (median of 3) | 110 ms (107–126) | ≤ 100 ms | reliable FAIL |
| structuredClone(project) (median of 3) | 234 ms (232–248) | ≤ 100 ms | reliable FAIL |
| filmstrip 48 frames cold (node, 20-min file) | 2,799 ms (2,642–3,053) | ≤ 3,000 ms | flaky (1/3 FAIL) |
| ffmpeg single-graph parse @ 2,500 clips: exit / peak RSS | killed at 6,156 MB (6,152–6,159) | exit 0, ≤ 4,096 MB | reliable FAIL (not the export path: export is chunked) |
| setClipSpeed ripple (median) | 11.2 ms (10.6–15.6) | ≤ 16 ms | PASS, closest to budget |
| sequenceDuration (mean) | 0.11 ms (0.11–0.12) | ≤ 0.2 ms | PASS (0.28 ms FAIL in the report was noise) |

Electron (`electron-perf.mjs`, 87 budgeted rows on 53f619c):

| Metric | Median (min–max) | Budget | Verdict |
|---|---|---|---|
| Edit commit → paint (median): insert overwrite | 91.4 ms (90.3–96.8) | ≤ 32 ms | reliable FAIL |
| … insert ripple | 123.7 ms (116.2–128.0) | ≤ 50 ms | reliable FAIL |
| … razor all tracks | 101.8 ms (101.3–105.8) | ≤ 32 ms | reliable FAIL |
| … moveClips overwrite | 80.3 ms (79.3–80.4) | ≤ 32 ms | reliable FAIL |
| … rippleDeleteSelected | 82.2 ms (81.1–98.1) | ≤ 32 ms | reliable FAIL |
| … undo / redo | 76.2 (74.9–76.4) / 76.6 (75.3–79.8) ms | ≤ 32 ms | reliable FAIL |
| 300 mixed commits with UI mounted (no budget) | 8.8 s (8.7–9.0), 31–32 long tasks, max 322–347 ms | — | — |
| Scrub fps @ 1 px/frame, no selection / 50 selected | 39.2 (38.9–40.1) / 34.0 (33.2–34.7) fps | ≥ 50 | reliable FAIL |
| ClipView renders per scrub frame @ 1 px/frame, no sel. / 50 sel. | 20.5 (20.2–21.1) / 22.4 (22.1–22.7) | == 0 | reliable FAIL |
| DOM mutations in clips content per scrub frame @ 1 px/frame | 38.6–39.7 / 50.6–52.6 | == 0 | reliable FAIL |
| Long tasks during scrub @ 1 px/frame, no sel. / 50 sel. | 9 (6–10) / 10 (9–11) | == 0 | reliable FAIL |
| setView call cost, 50 selected @ zoom-to-fit / @ 1 px/frame | 1.1 (1.1–1.2) / 1.2 (1.1–1.2) ms | ≤ 1 ms | reliable FAIL |
| Wheel ×100 @ 1 px/frame, event → render (median) | 10.3 ms (8.9–10.9) | ≤ 8 ms | reliable FAIL |
| Wheel ×100 @ 1 px/frame, long tasks | 1 (0–1) | == 0 | flaky (2/3 FAIL) |
| Switch to big sequence → first paint @ zoom-to-fit | 106.9 ms (93.1–165.9) | ≤ 100 ms | flaky (2/3 FAIL) |
| Long tasks in 2.5 s after that switch @ zoom-to-fit | 3 (1–3) | ≤ 1 | flaky (2/3 FAIL) |
| Switch to big sequence → first paint @ 1 px/frame | 101.5 ms (100.2–102.2) | ≤ 100 ms | reliable FAIL (by 1–2 %) |
| Switch sequence ×20 → paint (median) | 111.8 ms (108.9–113.0) | ≤ 100 ms | reliable FAIL |
| JSON.stringify / structuredClone(project) in renderer | 131 (130–165) / 275 (261–277) ms | ≤ 100 ms | reliable FAIL |
| saveProject round trip | 1,916 ms (1,872–1,956) | ≤ 500 ms | reliable FAIL |
| openProject round trip | 2,785 ms (2,704–2,821), one 2.1–2.2 s long task | ≤ 1,000 ms | reliable FAIL |
| Project search keystroke → paint (worst) | 48 ms (48–56) | ≤ 50 ms | flaky (1/3 FAIL) |
| Program playback long tasks after 20 switches + 10 maximize cycles | 2 (1–3) | ≤ 2 | flaky (1/3 FAIL) |

Now passing in 3/3 runs (were over budget in the report): Program playback long tasks @ zoom-to-fit (0),
openProject main-side handler (392 ms, 390–414; was 735), autosave round trip (346 ms, 325–421), sequenceDuration.
Still worth watching without a budget: Program playback @ 1 px/frame had one 1.48–1.54 s long task in 2 of 3 runs
(right after play starts); `<video>` elements created reach 10,327–10,391 after 20 switches (16 live).

**Noise verdict.** On an idle machine the three runs agree within about ±5 % for most timing rows and ±10–15 % for
a few (normalizeProject, filmstrip, the switch at zoom-to-fit). The rows that fail fail by a wide margin, except
the four flaky rows and `switch @ 1 px/frame` (1–2 % over). Contention from other jobs on the shared VM can still
double a row (see the bisect below), so the gate documentation says: treat ±30 % as noise and compare medians of
at least two runs.

### serializeProject 704 ms vs 344 ms: noise, not a regression

There is nothing to bisect. `git diff --stat 92eb1f1 e89fc8b` touches only docs, bugs, CI and three test files;
`shared/project.ts` (`serializeProject` = `JSON.stringify(p, null, 2)`), the store and `bigProject.mjs` are
identical, and e89fc8b → 53f619c changes only `electron/export/*`. Measured in isolation (a scratch vitest file that
builds the big project and times `serializeProject` 7× without and 7× with a forced GC before each call; 3 fresh
processes per commit, interleaved good / bad / main, same `node_modules`):

| Commit | Without GC: medians of the 3 processes (all 21 samples min–max) | With GC: medians (min–max) | Output |
|---|---|---|---|
| 92eb1f1 (good) | 318.6 / 311.8 / 316.8 ms (304–353) | 302.6 / 306.6 / 306.7 ms (298–318) | 68,390,062 chars |
| e89fc8b (bad) | 306.9 / 320.0 / 312.0 ms (302–338) | 301.2 / 319.9 / 305.2 ms (296–348) | 68,390,062 chars |
| 53f619c (main) | 317.1 / 322.6 / 311.2 ms (304–347) | 310.5 / 314.8 / 308.2 ms (302–343) | 68,390,062 chars |

All three commits serialize the same 68.4 M-character string in 296–353 ms; the full-suite row reads 325–335 ms in
the three node runs above. The 704 ms of the report was a contended run (other agents on the machine), not a code
change. The row still fails its 100 ms budget by 3×; that is Phase 1 C (project I/O), not a regression.

### Multi-hour sequence

`buildLongSequence(store, { hours: 3 })` in `tests/perf/bigProject.mjs` adds a 3 h sequence at 23.976 fps
(258,941 frames) to the big project, not activated, after every existing row has been measured, so the 2,500-clip
sequence and all earlier rows are unchanged. Content (deterministic, seeded): V1 a continuous cut of 3,084 shots
1.5–9.5 s long (skewed short, mean ~4 s) with linked A1 audio; every 18th shot a linked 2–5 s insert on V2/A2 (171
pairs); unlinked music beds on A3 (157 in node, 215 with the shorter real media in Electron); 480 transitions (240
V1 dissolves / dips + matching A1 crossfades); 119 markers (beats every 2 min, chapters every 15 min, continuity
notes every 10 min). 6,667 clips in node (6,725 in Electron); 3.04 MB compact. New rows (section `long`), two runs on
this branch, median (min–max):

| Metric | Value | Budget | |
|---|---|---|---|
| planFrame median / max (240 frames) | 0.01 / 1.25 ms (1.23–1.27) | ≤ 2 / ≤ 4 ms | PASS |
| sequenceDuration (mean) | 0.12 ms (0.11–0.13) | ≤ 0.2 ms | PASS |
| Commit insert/ripple / razor / ripple delete (node) | 55.0 (53.6–56.3) / 30.9 (30.1–31.6) / 21.7 (21.2–22.3) ms | ≤ 16 ms | FAIL |
| Commit moveClips overwrite / undo (node) | 15.8 (15.7–15.8) / 0.34 ms | ≤ 16 ms | PASS (move by 1 %) |
| serializeProject / JSON.parse / structuredClone incl. multi-hour | 369 / 179 / 506 ms | ≤ 100 ms | FAIL |
| Project JSON incl. multi-hour, pretty / compact | 75.8 / 30.7 MB (was 68.4 / 27.3) | — | |
| Switch → first paint @ zoom-to-fit / @ 1 px/frame | 50.3 (49.7–50.8) / 57.8 (54.3–61.2) ms | ≤ 100 ms | PASS |
| Switch big ↔ multi-hour ×10 → paint (median) | 54.9 ms (54.8–55.0) | ≤ 100 ms | PASS |
| Scrub @ zoom-to-fit (LOD lane, 0 clips mounted) | 58.2 fps, 0 ClipView renders, 0 long tasks | ≥ 50 | PASS |
| Scrub @ 1 px/frame, no sel. / 50 sel. | 27.9 (27.1–28.7) / 24.9 (24.0–25.7) fps; 56 ClipView renders and ~91 clip DOM mutations per frame | ≥ 50, == 0 | FAIL |
| Edit commit → paint: insert ripple / razor / move / undo | 87.2 / 49.3 / 35.9 / 33.2 ms | ≤ 50 / 32 / 32 / 32 | FAIL |
| Program playback @ 1 px/frame | 24.0 fps, 0 long tasks | ≥ 23, ≤ 2 | PASS |
| saveProject / openProject round trip incl. multi-hour | 3,179 (3,152–3,206) / 3,001 (2,907–3,095) ms | ≤ 500 / ≤ 1,000 ms | FAIL |
| openProject main-side handler incl. multi-hour | 425 ms | ≤ 500 ms | PASS |

Reading: per-frame work (planFrame, sequenceDuration, playback, LOD at fit) scales fine to 3 h. Store commits that
ripple scale with the clips after the edit point (insert ripple 23 → 55 ms). The scrub driver steps `duration / 240`
frames per animation frame; on the 3 h sequence that is 1,079 frames, close to the whole ~1,400-frame viewport at
1 px/frame, so the Playhead page-flips the view on almost every frame and every mounted clip re-renders (56 per
frame, against 20.5 on the 26-min sequence where a flip comes every ~6 frames). See "Phase 1 notes".

### Rows changed in tests/perf (no budget changed)

- `electron-perf.mjs`: the IPC wrapper did not wrap `project:autosaveJson`, which the renderer now uses for
  autosave, so "autosave main-side handler time" read 0 ms and passed vacuously. It now wraps both channels, reports
  the one used (176 ms, ≤ 300 ms, PASS), and records a FAIL "not captured" if neither is seen. The metric name says
  "(write; serialize too on the legacy channel)".
- `electron-perf.mjs`: the transcript / project / scenes keystroke rows put the varying "N events over 16 ms" count
  in the metric name, so the same row had a different name in every run. The count moved to the note.
- `export.perf.test.ts` already asserts the real input-count invariant (bugs/closed/2026-10-05-export-perf-inputcount-stale.md):
  16 passed / 1 skipped (the opt-in CPU profile) in all node runs.

### Phase 1 notes (from these measurements; hypotheses with pointers)

- **Edit latency is mostly render, not store.** Node commits cost 4–25 ms; the same edits cost 76–124 ms commit →
  paint in the app, including undo / redo whose store cost is 0.4 ms. So ≥ 70 ms per edit is React work after the
  commit (TimelineBody pass and panels deriving from `project.sequences`, `src/panels/timeline/TimelinePanel.tsx`
  ~:560–630). Store side, a CPU profile of razor / insert ripple (`RECUT_PERF_PROFILE=1`,
  `profile-commit.perf.test.ts`, now with `insertRipple` and `moveInsert`) puts ~40 % in immer draft proxies
  (`isDraftable` / `get` / `finalize`) created by scans over drafted clip arrays: `linkedClips`
  (`shared/timeline.ts:72`, 11 % of razor), `findClip` (:41), `sortTrack` sorting the drafted array (:65),
  `razorAt` / `splitTracksAt` `track.clips.find` (:555, :534), `rippleShift` `track.clips.filter` (:277).
- **Scrub at working zoom is page-flip remounting.** `Playhead.tsx` page-flips the scroll when the playhead leaves
  the view; every flip changes `visFrom` / `visTo` for every mounted `ClipView` (`TimelinePanel.tsx:612–615`), so
  all of them re-render. On the 26-min sequence TimelineBody renders 18–19 times in ~119 scrub frames (a flip every
  ~6 frames) and each pass re-renders ~130 clips: 20.5 per frame on average. On the 3 h sequence it renders 79–88
  times in ~85 frames (a flip every frame), ~55 clips each: 56 per frame. Without a flip a playhead step renders 0
  clips (the zoom-to-fit rows, where the whole sequence is in view). Either make a flip cheap (clip props in absolute coordinates inside a translated container,
  `visFrom` / `visTo` quantized to filmstrip tiles) or add a realistic in-view drag row next to the page-flip row.
- **Open / save is serialization on the main threads.** Save: `src/state/mediaActions.ts:330` structured-clones the
  whole project (275 ms in the renderer), main pretty-prints it (`electron/project/io.ts:147`, 326 ms) and writes
  68 MB. Open: main parse + normalize (392 ms), clone back, renderer `normalizeProject` again
  (`mediaActions.ts:365`) and load + render in one 2.1–2.2 s long task. Autosave already sends compact JSON
  (`mediaActions.ts:398`) and passes.

---

## Gate policy (2026-10-06)

The project owner re-scoped the gate on 6 October 2026. No row was deleted, hidden or loosened; every budgeted row
now carries a tier where it is recorded (`tier` on the row in `tests/perf/_report.ts` and `electron-perf.mjs`; an
unclassified budgeted row is a gate), and `npm run perf:check` prints three sections. The policy, the regression
rule and the full row-by-row table are in `docs/DEVELOPMENT.md` → Performance gate.

- **Gates (86 rows)**: user-facing, strict pass/fail on the existing budget: save and open round trips (including
  the 3 h project, which still fails), edit commit → paint, scrub fps / re-renders / long tasks, sequence switch →
  paint, wheel scroll, zoom → paint, playback fps and long tasks, keystroke → paint, panel interactions, export
  completion and graph correctness, previewExportCommand.
- **Moved to guardrail (122 rows)**: fail on a material regression (median of ≥ 2 runs > 1.5 × baseline and above
  a 2 ms / 8 MB noise floor) against `tests/perf/baseline.json`, and still on their budget, except
  `normalizeProject`, whose 100 ms target is now a reference only. These are all node store rows (commit, view,
  history, memory, `serializeForSave`, `loadProjectData`, frame, multi-hour commits and per-frame work), all
  `panels` rows, all `main` media-layer rows, `buildRenderGraph`, the ffmpeg single-graph rows at 100 clips (one
  chunk's size), the full-export peak RSS, and in Electron `setView call cost`, DOM node counts, IPC call counts,
  `history.past.length`, autosave round trips and handler, media-element / audio-node pool rows and the
  main-process media rows.
- **Moved to diagnostic (18 rows)**: reported with trend, never blocking; old thresholds kept as reference:
  node `serializeProject`, `JSON.parse`, `structuredClone(project)` (2,500-clip and incl. multi-hour), Electron
  `JSON.stringify(project)` and `structuredClone(project)` in the renderer, `openProject main-side handler time`
  (and incl. multi-hour), `ExportRequest` `JSON.stringify` / `structuredClone`, and the ffmpeg single-graph rows at
  500 and 2,500 clips (export never builds a graph above 150 inputs; it chunks).

Baseline seeded from 2 node + 2 Electron runs on `main` 16f707a (workstreams B, C, D merged), alone under the
perf lock, same 4-core container (FFmpeg 6.1.1-3ubuntu5, Node 22.22.0). Result of
`node tests/perf/perf-check.mjs --from <both runs>`: gates 55 PASS / 31 FAIL, guardrails 118 PASS / 4 FAIL (all on
their budget: `setView call cost` with 50 clips selected at zoom-to-fit 1.45 ms, at 1 px/frame 1.3 ms, multi-hour
4.05 ms, all ≤ 1 ms; node `filmstrip 48 frames cold` 2,908 ms, passing 1 of 2 runs at ≤ 3,000 ms), 18 diagnostics
reported (11 above their old reference). The failing gates are scrub at 1 px/frame (2,500-clip and 3 h: 23–34 fps,
20–56 ClipView renders per frame), edit commit → paint (33–51 ms against 32 / 50 ms), wheel @ 1 px/frame (11.3 ms
against 8), the 3 h save round trip (552 ms against 500), and three flaky rows (long tasks after a switch @
zoom-to-fit, project search keystroke, long tasks after 20 switches + 10 maximize cycles). The 2,500-clip save
(389 ms) and open (820 ms) round trips now pass. **Status stays open**: Roadmap §1 is done only when every gate
passes and no guardrail shows an unexplained material regression.

---

## Verification

| Field | Value |
|---|---|
| Verified by / date | Claude (Claude Code session, Roadmap §1 Phase 0), 2026-10-06 |
| Verified on commit | 16f707a (baseline), re-measured through bd60227 |
| Verdict | confirmed |

Reproduced with `npm run perf:check` (both suites); see "Baseline (2026-10-06)" above. The hypotheses in "Suspected
cause" were right in direction (per-commit store work, mounting every visible clip, whole-project serialize / clone
on the renderer's main thread), but the profiles found more causes, listed under Root cause.

---

## Resolution

| Field | Value |
|---|---|
| Closed by / date | Claude (Claude Code session), 2026-10-07 |
| Fix | PRs #16–#36 (merged into main through bd60227) |
| Files changed | `src/state/*`, `src/panels/timeline/*`, `src/panels/project/*`, `src/panels/program/*`, `src/playback/*`, `src/app/project.ts`, `src/app/autosaveGate.ts`, `shared/timeline.ts`, `shared/projectWire.ts`, `electron/project/io.ts`, `electron/ipc.ts`, `electron/preload.ts`, `electron/media/{protocol,thumbs}.ts`, `tests/perf/*` (see each PR) |
| Regression test | `npm run perf:check` (98 gates, 130 guardrails against `tests/perf/baseline.json`), plus the unit tests named in each PR (e.g. `tests/unit/save-stream.test.ts`, `autosave-stream.test.ts`, `open-freeze.test.ts`, `program-scrub.test.ts`, `timeline-render-perf.test.ts`, `timeline-waveBars.test.ts`, `timeline-playhead.test.ts`) |

### Root cause

No single cause. Per area:
- **Store:** every commit copied and re-froze large parts of the project; an opened project was deep-frozen in one
  task by the first edit (~370 ms).
- **Timeline:** every lane re-rendered on every playhead step, all clips in a 200 px margin were mounted, page flips
  unmounted and remounted whole pages, the scrollbar sync forced synchronous layouts, and the playhead's per-frame move
  re-layerized the whole page.
- **Project I/O:** save, open and autosave serialized, sent and parsed the whole 28–31 MB project in single tasks; the
  project was normalized twice on open.
- **Program monitor:** seeked every pooled video element on every scrub step and redrew 42–55 times a second during
  playback instead of about 24.
- **Other panels:** the Project panel re-sorted all media and re-rendered every row on each edit.
- **Media:** thumbnails were served `no-cache` and reloaded on every first visit to a page; cancelled filmstrip jobs
  kept their ffmpeg running; edits started their own thumbnail ffmpeg jobs, which competed with the edit for CPU.
- **Bench:** the Electron bench crashed partway (a Playwright / V8 weak-promise race), measured edits with a two-frame
  floor above the 32 ms budget, and measured scrub fps with its own render counter on.

### Fix

Phase 1 and Phase 2 of Roadmap §1, one PR per workstream: store commit cost (#17), playback element pooling (#18),
project open/save (#19), the save race (#20), the three-tier gate (#21), timeline rendering (#22, #26, #30, #33,
#36), bench crash and measurement fixes (#23, #28, #29), streamed save (#24) and autosave (#32), idle freeze after
open (#25), Program monitor scrub and playback draws (#27, #31), Project panel re-renders (#34), thumbnail caching and
ffmpeg cancellation (#35). The owner approved two deliberate rendering trade-offs (#36): waveforms as device-pixel
bars and a composited playhead; see `docs/attack/performance.md` → Deliberate rendering trade-offs.

### Before / after

Final gate: `npm run perf:check -- --runs 2` on bd60227, 2026-10-07, quiet machine (load 0.7–2.8, no other perf
jobs). **98 of 98 gates and 130 of 130 guardrails pass in both runs.** Medians:

| Metric | 2026-10-05 (this report) | Final | Budget |
|---|---|---|---|
| Edit commit → paint: overwrite / insert ripple / razor / move / ripple delete / undo / redo | 109 / 122 / 115 / 84 / 92 / 80 / 80 ms | 17.3 / 22.6 / 18.5 / 16.8 / 16.8 / 16.9 / 17.0 ms | ≤ 32 (ripple ≤ 50) |
| Scrub fps @ 1 px/frame, no selection / 50 selected | 35.3 / 31.8 fps, 13 long tasks | 58.5 / 57.5 fps, 0 long tasks | ≥ 50, 0 |
| 3 h scrub fps @ 1 px/frame, no selection / 50 selected | (not measured; 26 fps on 6 Oct) | 59.2 / 58.9 fps, 0 long tasks | ≥ 50, 0 |
| Wheel scroll @ 1 px/frame, event → render | 10.6 ms | 5.9 ms | ≤ 8 |
| Switch to big sequence → paint @ zoom-to-fit / 1 px/frame | 136.5 / 100.6 ms | 49.0 / 52.2 ms | ≤ 100 |
| Switch sequence ×20 → paint | 115.9 ms | 70.7 ms | ≤ 100 |
| saveProject round trip (2,500 clips / with 3 h) | 2,004 ms / — | 214 / 249 ms | ≤ 500 |
| openProject round trip (2,500 clips / with 3 h) | 4,348 ms (3,012 ms long task) / — | 714 / 808 ms | ≤ 1,000 |
| First edit after open → paint (2,500 clips / 3 h) | ~340 / ~370 ms (long task) | 21.1 / 21.1 ms, 0 long tasks | ≤ 50 |
| autosaveProject round trip | 446 ms | 189 ms | ≤ 500 |

`JSON.stringify` / `structuredClone(project)` and the node serialize / parse / clone rows remain above their old
100 ms reference; they are diagnostics under the gate policy above, not user-facing.

### Regression test proof

The gate itself: on 16f707a (2026-10-06) `perf:check` reported 31 failing gates; on bd60227 it reports 0 in both
runs. Each PR records its own before/after runs and the unit tests that fail on the old code.

### Tests run

`npm run perf:check -- --runs 2` (above); `npm test` on bd60227: 1150 / 1150; e2e timeline, inspector, program,
project, lifecycle, source, compare and scenes specs in the PRs that touched them; gauntlet 4 / 4 (PR #22).

### Changed existing assertions

- Edit → paint gate rows now measure to the next painted frame (owner's decision, 6 October; #23); the old two-frame
  number is kept as a diagnostic.
- Scrub fps is measured with the render counter off (owner's decision, 7 October; #28); the combined number is kept
  as a diagnostic.
- Page-flip ClipView-render / DOM-mutation rows are reference guardrails; in-page rows are the 0 gates (owner's
  decision, 6–7 October; #28).
- `tests/unit/playback-pool.test.ts` redraw counts (#31): the old assertion required redundant redraws.
- No threshold was loosened and no row was removed.

### Compatibility risks

- The project file format is unchanged (`formatVersion` 1); saved and autosaved bytes are identical to before
  (tested).
- `.bak` is now a hard link to the previous version where the filesystem allows it, else a copy (#24).
- Waveforms and the playhead render slightly differently (approved trade-offs, #36).

### Follow-ups

- `tests/perf/baseline.json` re-seeded from this final gate (bd60227).
- Possible future work, not needed for the gate: an occasional 17–60 ms Program monitor `drawImage` spike (#31
  report); first-visit page-flip cost on the 3 h sequence on a loaded machine; the node-side filmstrip-cold
  guardrail sits close to its 3,000 ms budget.
