# Perf gate: "media elements created during 10 s playback" reads 1–2 against a seed of 0

| Field | Value |
|---|---|
| Status | fixed |
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

---

## Verification

| Field | Value |
|---|---|
| Verified by / date | Claude (Claude Code session), 2026-10-09 |
| Verified on commit | 2494b6e (`claude/fix-multihour-scrub`) |
| Verdict | Confirmed: the count depends on the pool's state when the row starts, not on churn. The creations are first uses of (file, slot) pairs that the earlier rows happened to leave out of the pool. |

Two instruments, both on the unfixed build:

1. **The full bench, instrumented** (`mkprobe.mjs` in the session scratchpad; 16 runs, heavy lock held). It logged
   the live pooled elements before the row, and every element created or disposed during it with the playhead,
   the play state and the call stack. It also logged the player's lent audio slots and the pool's audio entries every
   200 ms.
   - The row read 2, 2, 2, 2, 2, 2, 2, 2, 0, 2, 1, 0, 1, 2, 2, 2 (median 2: the guardrail fails).
   - The created elements are always `<audio>` elements, for Galaxy Saga 1 and/or Station Eleven S01E03, created by
     `SequencePlayer.updateAudio → assignSlots → MediaElementPool.acquire` at playhead 275 (the end of the 10 s). Each
     creation evicted the least recently used unpinned element (`acquire → evict → dispose`), e.g. the audio
     elements of S01E01 and Galaxy Saga 3, which no clip in that range uses.
   - The pool held 16 elements before the row, most of them left over from the scrub rows: which (file, slot) pairs
     were among them varies with when the scrub rounds landed.
2. **A harness that plays the same 10 s three times in a row** (`pool.mjs`, scratchpad): the bench's playback driver
   on the same project, without and with a history of bench-like scrubs.
   - No history: the first playback created 6 elements (2 `<video>`, 4 `<audio>`) at frames 227–239 (the cross-fades at
     the 240 cut need a second element of a file). The 2nd and 3rd playbacks created **0**.
   - With bench-like scrubs first: the first playback created 2 (`<audio>`, frame 227); the replay created **0**.

**Not an app inefficiency.** No element was disposed and then needed again within one playback. Every creation is
the first use of a (file, kind, slot) pair since the pool last held it, and a replay of the same range reuses
everything. The pool holds 16 elements and the 10 s range needs about 14 pairs, so they all stay pooled.

---

## Resolution

| Field | Value |
|---|---|
| Closed by / date | Claude (Claude Code session), 2026-10-09 |
| Fix | branch `claude/fix-program-scrub-stall` (bench only) |
| Files changed | `tests/perf/electron-perf.mjs`, `docs/attack/performance.md`, this file |
| Regression test | The row itself, in `npm run perf:check` |

### Root cause

The row counted creations during the **first** playback of frames 0–275, whose starting pool is whatever the scrub
rows before it left behind. Some pairs that the range needs (second elements of a file, for the cross-fades) are or
are not still pooled, so a correct player created 0–2 elements. The zero-baseline rule (a median of 2 fails) then
failed the guardrail on unchanged code.

### Fix

Make the starting state explicit: option (a) of the report (steady state), which is also what the task asked for
(a defined pool, "warmed with exactly the elements playback will need"). The bench keeps the first playback exactly as it was, with its gates (`program fps @ 1 px/frame
timeline`, `long tasks @ 1 px/frame timeline`) measured on it. It then replays the same 10 s from frame 0
(`playFor(…, { record: false })`, which records no rows) and counts the pool row over the replay. The first playback
has just used, and so pooled, exactly the pairs the range needs. A correct player therefore creates 0, and per-clip or
per-frame churn (7,471 creations before the original fix) still shows in full. The first playback's count is kept in
the row's note.

Not changed: the row name, its budget (≤ 16), its tier, the baseline (median 0) and the zero-baseline tolerance. The
following rows ("since playback": zoom-to-fit playback + 20 switches) still start from `pd1`, now taken after the
replay, which is still "after the 10 s playback".

### Before / after

| | Before (2494b6e, first playback) | After (replay) |
|---|---|---|
| Instrumented bench, 16 runs | 2, 2, 2, 2, 2, 2, 2, 2, 0, 2, 1, 0, 1, 2, 2, 2 | — |
| Harness, no history / with bench-like scrubs | 6 / 2 | 0, 0 / 0 |
| `npm run perf:check -- --runs 2`, two sets | (9 October before this fix: 2, 2) | 0, 0 and 0, 0 (the first playback in the note: 1, 1) |

The pool row passes in all 4 runs. Both `--runs 2` sets otherwise passed every gate. Each set failed one to three
node-suite microbenchmark guardrails (different rows each time, all passing raw) after normalization. The median over
the 4 runs passes every gate and guardrail. Details: `docs/attack/performance.md` → "Program scrub stall and pool row".

### Regression test proof

The row is the test. Before: 0–2 across runs (8 October: 1, 2, 2, 2, 2, 1, 2, 1, 2, 0; 9 October: 2, 2, 1; the 16
probe runs above). After: 0 in all 4 runs of `perf:check` (Before / after).

### Tests run

See `bugs/closed/2026-10-09-program-scrub-stalls-on-unready-element.md` (same branch) and `docs/attack/performance.md`.

### Changed existing assertions

None. The row's measurement window moved from the first playback to a replay of it, as described above.

### Compatibility risks

None for the app. The Electron bench takes about 12 s longer.

### Follow-ups

- `docs/DEVELOPMENT.md` → "A count with a baseline of 0 tolerates 1" says that this row "measures 1 now and then on
  unchanged code". That no longer holds (not edited here: outside this task's files).
