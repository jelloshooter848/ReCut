# Nested sequences: fan-out within the depth limit makes flattening exponential (stall, then RangeError)

| Field | Value |
|---|---|
| Status | open |
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
