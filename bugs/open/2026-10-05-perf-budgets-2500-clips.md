# 2,500-clip project still misses edit, scrub, open/save and serialization budgets

| Field | Value |
|---|---|
| Status | open |
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
