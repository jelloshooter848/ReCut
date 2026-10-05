# export.perf asserts one FFmpeg input per clip segment, but linked A/V clips now share an input

| Field | Value |
|---|---|
| Status | open |
| Severity | low (a stale test assertion; the perf suite reports a failure although export behaves as intended) |
| Area | tests / export |
| Reported by / date | Claude (Claude Code session, working bugs/closed/2026-10-05-roadmap-revisions.md), 2026-10-05 |
| Found on commit | e89fc8b (no source changes since 92eb1f1, where it fails identically) |
| Environment | Linux container, Node + vitest 2.1.9, FFmpeg 6.1.1-3ubuntu5 |

## Report

### Summary

`tests/perf/export.perf.test.ts` fails on every run because it expects at least 2,400 FFmpeg inputs for the
2,500-clip sequence. The render graph now opens one input per linked video + audio pair with the same range, so it
produces 1,258 inputs. The assertion encodes the old one-input-per-segment behaviour (the P-01 root cause), not a
requirement.

### Steps to reproduce

1. `NODE_OPTIONS=--expose-gc npx vitest run -c tests/perf/vitest.config.ts tests/perf/export.perf.test.ts`

### Expected

The suite passes when the graph is built correctly. Fewer inputs is the desired direction (P-01 in
`docs/attack/performance.md`: FFmpeg memory grows about 6.5 MB per input).

### Actual

```
 × tests/perf/export.perf.test.ts > export graph @ 2500 clips > buildRenderGraph time / size scaling and IPC payload
   → expected 1258 to be greater than or equal to 2400
 ❯ tests/perf/export.perf.test.ts:133:26
    133|     expect(g.inputCount).toBeGreaterThanOrEqual(2400);
```

Full perf run on e89fc8b: 15 passed, 1 failed (this one), 1 skipped. The same failure was seen on 92eb1f1 earlier
on 2026-10-05.

### Evidence

- `electron/export/renderGraph.ts:428-458` (`addInput`): "A linked video+audio pair with the same range shares one
  input." The video and audio of a linked pair use the same `lead`, build identical input args and reuse the input.
- The metric row on the line above the assertion is still labelled "ffmpeg inputs (one per clip segment)"
  (`tests/perf/export.perf.test.ts:118`).
- The other export rows pass: buildRenderGraph 25.3 ms (≤ 200 ms); the chunked export of the whole sequence writes
  37,560 / 37,560 frames in 18 chunks with peak FFmpeg RSS 844 MB (≤ 1,536 MB).

### Suspected cause (hypothesis)

The assertion was written (`ca13552`) as a sanity check that every clip segment reached the graph, before input
sharing was added to `addInput`. It was not updated when sharing landed.

### Scope

- Only the assertion at `tests/perf/export.perf.test.ts:133` and the row label at `:118`. A better check: inputs ≥ the
  number of distinct (media, range) segments, or ≤ 2,500 and > 0, or count segments in the filter graph instead.
- The single-graph `-t 0.5` row "ffmpeg exit @ 2500 clips (1258 inputs)" is still killed at 6 GB RSS. That path is
  not what Export uses (Export is chunked), so it is recorded, not asserted.

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
