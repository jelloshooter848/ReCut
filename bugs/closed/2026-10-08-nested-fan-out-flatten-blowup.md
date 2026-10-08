# Nested sequences: fan-out within the depth limit makes flattening exponential (stall, then RangeError)

| Field | Value |
|---|---|
| Status | fixed |
| Severity | medium |
| Area | timeline / nested sequences (preview and export) |
| Reported by / date | Claude (agent, attack-suite re-run), 2026-10-08 |
| Found on commit | 888c4d2 (main, 0.8.0) |
| Environment | Linux 6.18, Node 22.22.0, source build. No media decoding involved (pure `shared/nest.ts`). |

## Report

### Summary
`flattenSequence` (shared/nest.ts) turns every active inner track of every nested clip into its own flattened track,
so the flattened track count multiplies by the inner track count at every level. The load-time rules only bound the
**depth** (MAX_NEST_DEPTH = 8) and cycles, not the fan-out. A project of 9 small sequences in which each one nests
the next on K video tracks flattens to about K^8 tracks: K = 4 gives 349,524 tracks and 262,145 clips in ~2.2 s;
K = 5 throws `RangeError: Maximum call stack size exceeded` in `buildFlat`. Preview (planner) and export both go
through `flattenSequence`, so such a project cannot be previewed or exported. It is a few KB of JSON (40 nested
clips), and it can also be built in the UI, since every nest passes `nestProblem` (depth ≤ 8, no cycle).

### Steps to reproduce
Test: `tests/attack-qa/hostile-080.test.ts` › "fan-out within the depth limit … stays bounded" (marked `it.fails`
while this is open).

```
npx vitest run -c tests/attack-qa/vitest.config.ts tests/attack-qa/hostile-080.test.ts -t fan-out
FANOUT_K=5 npx vitest run -c tests/attack-qa/vitest.config.ts tests/attack-qa/hostile-080.test.ts -t fan-out
```

1. Sequences L0..L8, each with K video tracks.
2. For i < 8, put on every track k of Li a nested clip of L(i+1) at 0..48; L8 holds one media clip per track at 0..48.
3. Open the project (it loads with no repairs) and flatten L0 (`flattenSequence`), or export it.

### Expected
Either the loader / `nestProblem` bound the expanded size (for example a cap on the flattened track or clip count,
cutting or refusing references past it the way depth is cut), or flattening collapses copies so its output grows
with the visible content, not exponentially. Opening and exporting never stalls or throws.

### Actual
```
K=4: [fan-out 4^8] flatten 2241 ms, 349524 video tracks, 262145 clips
K=5: RangeError: Maximum call stack size exceeded
 ❯ buildFlat shared/nest.ts:374:48   videoTracks.push(...flattenTrack(seq, t, 'video', ctx))
```

### Evidence
Output above, from the test on 888c4d2.

### Suspected cause (hypothesis)
- `mapNested` returns one entry per active inner track for each nested clip and `flattenTrack` turns each into a
  track; nothing merges or caps them across levels, and `nestingRepairs` only measures depth.
- The RangeError is the spread in `videoTracks.push(...flattenTrack(...))` with more arguments than the stack allows
  (around 120k); replacing the spread with a loop only moves the failure to memory and time.

### Scope
Audio tracks behave the same way (same code path). Fixing it needs a policy decision (a size cap and what happens
to references past it, repair report text), so it is not fixed in the attack-suite re-run.

---

## Verification

| Field | Value |
|---|---|
| Verified by / date | Claude (agent), 2026-10-08 |
| Verified on commit | 3b9ffdf (origin/main) |
| Verdict | Reproduced: K=4 flattens to 349,524 video tracks / 262,145 clips in 1,970 ms; K=5 still fails (the `it.fails` case passes, i.e. its body throws). |

---

## Resolution

| Field | Value |
|---|---|
| Closed by / date | Claude (agent), 2026-10-08 |
| Fix | A second nesting limit beside depth: no sequence may flatten to more than 1,000 tracks or 50,000 clips (`MAX_FLAT_TRACKS` / `MAX_FLAT_CLIPS`). The commands that create nested clips refuse edits past it and the loader cuts nested clips past it. `buildFlat` no longer spreads into `push()`. |
| Files changed | shared/nest.ts, shared/project.ts, src/state/store.ts, tests/unit/nest-size.test.ts (new), tests/attack-qa/hostile-080.test.ts, docs/USER-GUIDE.md, docs/LIMITATIONS.md, docs/ARCHITECTURE.md, docs/project-format.md, docs/attack/README.md |
| Regression test | tests/attack-qa/hostile-080.test.ts › "fan-out within the depth limit … (4 / 5 tracks, 8 levels) is cut to the size limit and stays bounded"; tests/unit/nest-size.test.ts |

### Root cause
The hypothesis held. `flattenSequence` turns every active inner track of every nested clip into its own flattened track,
so the size multiplies by the inner track count at every level. The only limits were depth (8) and cycles, which
leaves an exponential range: K^8 tracks from 9 small sequences. The RangeError at K=5 came from
`videoTracks.push(...flattenTrack(...))` passing more arguments than the stack can hold.

### Fix
- **Size computation** (`flattenedSize`, shared/nest.ts) computes what flattening makes without flattening. Per-sequence
  counts are memoised bottom-up: tracks come from the same first-fit grouping `flattenTrack` uses (through a segment
  tree, so it stays fast with many overlapping nested clips), and a nested clip counts only the inner clips its
  window (with transition handles) plays, found by prefix sums. A nested sequence cut into many pieces therefore counts
  about once. Every clip and track is counted as enabled and unmuted, so disabling or muting cannot be used to get
  past the limit. It is an upper bound of what flattening makes, and exact when nothing is disabled, muted or empty
  (tested on a fan-out at every level, a razored nested clip, and 60 random nested projects with transitions,
  mixed frame rates, disabled clips and mutes).
- **Limits** sit next to `MAX_NEST_DEPTH`: 1,000 tracks and 50,000 clips (video and audio together). A sequence
  is always allowed its own tracks and clips.
- **In the app:**
  - `nestProblem` has a new reason `'size'`: "nesting would expand to more than 1,000 tracks or 50,000 clips
    when flattened". It is checked on the host and every sequence that contains it.
  - `nestLimitProblem` checks an edited project for cycle, depth and size.
  - The store checks the size on a dry run of the edit for Nest Sequence (drag or menu), paste, snapshot restore,
    Make Compound Clip and Break Apart.
  - Make Compound Clip previously had no nesting check at all, so it could exceed the depth limit too; that is fixed.
- **On load:** `nestSizeRepairs` runs after the cycle/depth cuts in `repairNesting`.
  - It works bottom-up (by nesting depth, then sequence order).
  - In a sequence past the limit it cuts nested clips widest first (most inner tracks while the track count is over,
    then most clips while the clip count is over; the later one on the timeline among equals) until the sequence fits.
  - A linked picture + sound pair is cut as one.
  - Cut clips become clips of missing media, as with depth cuts, and are reported as "nested sequence that would
    expand to more than 1,000 tracks or 50,000 clips when flattened made offline (Nx)".
  - It is deterministic, and stable: a sequence's size depends only on the sequences below it, which are final
    before it is measured.
- **Defence in depth:** every `push(...spread)` and `Math.min/max(...spread)` call in shared/nest.ts is now a loop.

### Limits: measurements
Measured with `flattenSequence` on the development machine (Linux, Node 22), warm, median of 7 runs, heavy lock held:

| Shape | Flattened | Flatten |
|---|---|---|
| fan-out 9 tracks × 2 levels | 820 tracks / 738 clips | 1.9 ms |
| fan-out 31 tracks × 1 level | 993 tracks / 992 clips | 2.9 ms |
| fan-out 9 × 2, 34 clips per leaf track | 820 tracks / 24,795 clips | 78 ms |
| fan-out 9 × 2, 68 clips per leaf track | 820 tracks / 49,581 clips | 153 ms |
| fan-out 9 × 2, 130 clips per leaf track | 820 tracks / 94,779 clips | 299 ms |
| season 20 episodes × 5 scenes, 40 clips per track | 18 tracks / 24,040 clips | 104 ms |
| same, 80 clips per track | 18 tracks / 48,040 clips | 241 ms |
| same, 160 clips per track | 18 tracks / 96,040 clips | 621 ms |

- Tracks are cheap, so 1,000 stays. A realistic season (20 episodes of 6 tracks, each nesting 5 scenes of 6 tracks,
  with dissolves) counts 42 tracks.
- Clips cost about 3–6 µs each in flattening (two levels of nesting copy each clip twice). The realistic season
  already takes about 100 ms at roughly 24,000 clips. A clip limit that kept flattening at the limit well under
  100 ms would sit below real projects and cut them on load.
- 50,000 is a compromise: twice that season, flattening in about 150–250 ms at the limit. 100,000 would mean
  300–620 ms at the limit.
- Computing the size itself takes 0.2–2 ms for the fan-outs and 28–54 ms for the 24k–96k-clip seasons.

### Before / after
```
before (3b9ffdf): [fan-out 4^8] flatten 1970 ms, 349524 video tracks, 262145 clips; K=5 throws
after:  [fan-out 4^8] repaired: ... made offline (14x); flatten 45 ms, 700 video tracks, 527 clips
        [fan-out 5^8] repaired: ... made offline (20x); flatten 37 ms, 805 video tracks, 646 clips
```

### Regression test proof
- On 3b9ffdf the fan-out case is `it.fails`: its body fails for K=4 (1,970 ms) and throws for K=5.
- After the fix the K=4 and K=5 cases pass as plain `it`. Both load repaired with no clip lost, every sequence is
  within the limits, flattening takes under 50 ms, the render graph builds for every sequence, and the saved and
  reopened project needs no repairs.
- tests/unit/nest-size.test.ts covers:
  - the size computation, exact and as an upper bound;
  - the `'size'` reason (host, a sequence containing it, the clip limit, short pieces);
  - the store paths (Nest Sequence, paste, the Make Compound Clip depth gap);
  - the load repair: deterministic, stable, widest-then-later order, linked pairs, a sequence past the limit on its
    own tracks;
  - a realistic season that is not cut;
  - flatten time near both limits.

### Tests run
- `npm run typecheck`: clean.
- `npm test`: 119 files, 2,040 passed, 3 skipped.
- `npx vitest run -c tests/attack-qa/vitest.config.ts`: 6 files, 94 passed.
- `tests/e2e/nest.spec.ts` under xvfb: 3 passed.

### Changed existing assertions
The `it.fails` fan-out case in hostile-080 is now two plain cases (K=4, K=5) asserting the repaired, bounded result,
in place of the old "≤ 10,000 flattened tracks". No other assertion changed.

### Compatibility risks
- A project file past the limit opens with some nested clips made offline. It gets the usual repair warning and the
  `.pre-repair` backup is kept.
- Projects within the limit are unchanged, and `formatVersion` stays 1.
- `nestProblem` now also measures size, which costs O(clips) of the host and the sequences that contain it. That is
  milliseconds even for large projects.

### Follow-ups
- Edits that grow a sequence without creating a nested reference are not checked: adding clips or tracks inside a
  nested sequence, trims, razor, moves. A project can grow past the limit that way and is then cut the next time it
  is opened (documented in docs/LIMITATIONS.md).
- Flattening costs about 4 µs per flattened clip and runs again on every edit inside a nested sequence. Making it
  incremental, or faster per clip, would let the clip limit move closer to the ~100 ms target.
