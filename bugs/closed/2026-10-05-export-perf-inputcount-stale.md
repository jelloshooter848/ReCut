# export.perf asserts one FFmpeg input per clip segment, but linked A/V clips now share an input

| Field | Value |
|---|---|
| Status | fixed |
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
| Verified by / date | Claude (Claude Code session), 2026-10-05 |
| Verified on commit | db2ce17 (`origin/claude/roadmap-revisions`; `electron/` unchanged since e89fc8b) |
| Verdict | confirmed |

Read `electron/export/renderGraph.ts:430-458` (`addInput`): input args are keyed on `args.join('\u0000')`, and a
segment reuses an existing input with the same key when that input has not yet served its stream kind
(`same.find((e) => !e.kinds.has(kind))`). Video and audio use the same `lead`, so a linked V+A pair over the same
source range gets identical args and one input. Sharing landed in `2781bc0` (2026-10-04), after the assertion was
written. Ran the one test on db2ce17 with FFmpeg 6.1.1-3ubuntu5:

```
$ npx vitest run -c tests/perf/vitest.config.ts tests/perf/export.perf.test.ts -t "buildRenderGraph time"
 × tests/perf/export.perf.test.ts > export graph @ 2500 clips > buildRenderGraph time / size scaling and IPC payload 388ms
   → expected 1258 to be greater than or equal to 2400
 ❯ tests/perf/export.perf.test.ts:133:26
    133|     expect(g.inputCount).toBeGreaterThanOrEqual(2400);
 Test Files  1 failed (1)
      Tests  1 failed | 2 skipped (3)
```

The suspected cause is right. Why 1,258 and not 1,250: the fixture has 1,250 linked pairs, and 1,242 inputs are read
by one video and one audio segment. The other 16 segments have an input each because their video and audio input
args differ. This matches the fixture's transitions: 300 transitions over 8 tracks is 37 full rounds plus 4 more on
V1-V4 only, so 4 video cuts have no audio counterpart, and their 8 video segments get transition handles (different
`-ss` / `-t`) that their audio partners do not.

---

## Resolution
<!-- Required before moving the file to bugs/closed/. -->

| Field | Value |
|---|---|
| Closed by / date | Claude (Claude Code session), 2026-10-05 |
| Fix | branch `claude/quick-fixes`, the commit that moves this file to `bugs/closed/` |
| Files changed | `tests/perf/export.perf.test.ts` |
| Regression test | `tests/perf/export.perf.test.ts::export graph @ 2500 clips > buildRenderGraph time / size scaling and IPC payload` |

### Root cause

The assertion `expect(g.inputCount).toBeGreaterThanOrEqual(2400)` (from `ca13552`) encoded the old
one-input-per-clip-segment behaviour. `2781bc0` made a linked video + audio pair with identical input args share one
FFmpeg input (`addInput`), which is intended (P-01: FFmpeg memory grows per input). The test was not updated. Export
itself is correct.

### Fix

Replaced the magic-number check with `expectInputsMatchClips(seq, media, g)`, which derives the expected inputs from
the fixture and the graph:

1. The filter graph has exactly one video segment chain (`[N:v:0]...`) per enabled clip on the video tracks and one
   audio segment chain (`[N:a:0]` / `[N:<stream>]`) per enabled clip on the audio tracks (1,250 + 1,250). Catches a
   clip silently dropped or duplicated.
2. In track order then start order, each segment reads an input whose `-i` path is that clip's media path.
3. Every input is read by at most one video chain and at most one audio chain, and by at least one chain. Catches
   over-sharing (two video segments on one input) and unused inputs.
4. `max(video segments, audio segments) <= inputCount <= video segments + audio segments`.
5. `inputCount` equals the sum, over distinct input-arg tuples, of `max(video segments, audio segments)` using that
   tuple: the exact number of inputs when every video/audio pair with identical args shares one and nothing else
   shares. Catches sharing being disabled or reduced.

The fixture assumptions (no muted or solo tracks, every clip's media online, whole-sequence range) are those of the
big perf project; the helper asserts the track part. The metric row label now says a linked V+A pair with identical
input args shares one input, and a new report row records `video / audio segments, shared inputs`.

### Before / after

Before: the test fails, `expected 1258 to be greater than or equal to 2400`. After: it passes with 1,258 inputs for
1,250 video + 1,250 audio segments, 1,242 of them shared. `buildRenderGraph` output is unchanged (no source change).

### Regression test proof

Failing before: see Verification. Passing after:

```
graph      video / audio segments, shared inputs                      1250 / 1250, 1242        inputs = 1258    PASS
 ✓ tests/perf/export.perf.test.ts > export graph @ 2500 clips > buildRenderGraph time / size scaling and IPC payload 451ms
 Test Files  1 passed (1)
      Tests  1 passed | 2 skipped (3)
```

Mutation check: each mutation was applied to `electron/export/renderGraph.ts`, the one test run, and the file restored
(the committed tree has no change in `electron/`).

| Mutation | Result |
|---|---|
| Sharing disabled: `const shared = undefined` in `addInput` | fails: `AssertionError: expected 2500 to be 1258` (check 5) |
| One clip dropped: `&& c.id !== "clip_perf_14"` added to the clip filter in `collectTrackSegments` | fails: `AssertionError: expected 1249 to be 1250` (check 1) |
| Over-sharing: `const shared = same[0]` (reuse regardless of stream kind) | fails: `inputs read by 2+ video or 2+ audio chains, or unused: expected 22 to be +0` (check 3) |

The old assertion would not have caught the first mutation (2,500 >= 2,400).

### Tests run

Linux container, FFmpeg 6.1.1-3ubuntu5:

- `npm run typecheck`: clean (it does not cover `tests/perf`; vitest compiles the perf file).
- `NODE_OPTIONS=--expose-gc npx vitest run -c tests/perf/vitest.config.ts tests/perf/export.perf.test.ts`: 3/3 passed
  (502 s). Full chunked export 37,560 / 37,560 frames, 18 chunks, peak FFmpeg RSS 844 MB. The recorded-only row
  "ffmpeg exit @ 2500 clips (1258 inputs)" is still killed at 6 GB RSS, as the report says (not asserted; Export is
  chunked).
- `npm test`: 957/958 passed, 41/42 files. The one failure is `tests/unit/media-move-cache.test.ts:77`
  (`expected 1791231034921 to be 1791231034922`: `fs.utimesSync` loses a millisecond restoring the mtime). It is
  outside this change (this change touches only `tests/perf/` and docs), failed 4/4 runs here, and passed when it was
  added; it belongs to `bugs/open/2026-10-05-moved-media-cache-miss.md`'s test, not to this bug.

### Changed existing assertions

`tests/perf/export.perf.test.ts:133` `expect(g.inputCount).toBeGreaterThanOrEqual(2400)` was replaced by
`expectInputsMatchClips(seq, req.media, g)` (see Fix). The old assertion encoded the one-input-per-segment behaviour
that `2781bc0` intentionally removed. The new one is stricter: every clip must reach the graph from the right file,
and the input count must be exact, not a lower bound.

### Compatibility risks

None. Test-only change; no effect on projects or exports.

### Follow-ups

- `electron/export/renderGraph.ts:48`: the `RenderGraph.inputCount` doc comment still says "one per rendered clip
  segment". Not changed here (outside this task's files); it should say that a linked V+A pair with identical input
  args shares one input.
