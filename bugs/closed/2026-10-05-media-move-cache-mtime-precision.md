# media-move-cache test fails about half the time: copying the mtime through a Date drifts it by 1 ms

| Field | Value |
|---|---|
| Status | fixed |
| Severity | medium (test defect with no effect on users, but `npm test` on main fails about half the runs) |
| Area | tests / media (derived-media cache) |
| Reported by / date | Claude (Claude Code session, working the export-perf and INSTALL reports), 2026-10-05 |
| Found on commit | 0469137 (`claude/quick-fixes`; the test is unchanged since db2ce17, which is on main) |
| Environment | Linux container, ext2/ext3 `/tmp`, Node 22.22.0, vitest 2.1.9, FFmpeg 6.1.1-3ubuntu5 |

## Report

### Summary

`tests/unit/media-move-cache.test.ts` fails intermittently at line 77, so `npm test` on main is red about half the
time. The test simulates a cross-drive move and needs the moved copy to keep the source's mtime; the way it copies
the mtime loses sub-millisecond precision.

### Steps to reproduce

1. `npx vitest run tests/unit/media-move-cache.test.ts`, several times.

### Expected

The test passes every time: it copies the file, restores the mtime and checks that size and `Math.floor(mtimeMs)`
(what `cacheKeyForFile` hashes) are unchanged.

### Actual

```
AssertionError: expected 1791231034921 to be 1791231034922 // Object.is equality
 ❯ tests/unit/media-move-cache.test.ts:77:39
     77|     expect(Math.floor(moved.mtimeMs)).toBe(Math.floor(st.mtimeMs));
```

Seen in `npm test` (957/958) and in 4 of 4 single runs earlier, then 3 of 6 runs (`expected 1791231657499 to be
1791231657498`, `…659743 to be …659742`, `…665111 to be …665110`): the error goes both ways.

### Evidence

A standalone script (copy + `fs.utimesSync(copy, st.atime, st.mtime)`, 200 files on the same file system):

```
src mtimeMs 1791231685216.6855 Date 1791231685217 -> copy mtimeMs 1791231685217
src mtimeMs 1791231685224.4946 Date 1791231685224 -> copy mtimeMs 1791231685223.999
utimes(copy, st.atime, st.mtime): floor(mtimeMs) differs in 100/200
whole-second utimes on both: differs in 0/200
```

### Suspected cause (hypothesis)

`st.mtime` is a `Date`, which rounds the nanosecond mtime to the nearest millisecond (up for .5-.99), and
`fs.utimesSync` converts the Date to seconds as a double, which can land just below the millisecond
(…224 → …223.999). Either way `Math.floor(mtimeMs)` differs by 1 ms.

### Scope

Only this test. The product code is not affected: `cacheKeyForFile` floors whatever mtime the file system reports,
and a real move keeps the mtime the OS copy tool sets.

---

## Verification

| Field | Value |
|---|---|
| Verified by / date | Claude (Claude Code session), 2026-10-05 |
| Verified on commit | 0469137 |
| Verdict | confirmed |

Reproduced 3 of 6 runs of the single test (outputs above) and 1 failure in the full `npm test` (957/958). The script
above confirms the cause: half of 200 copies drift by 1 ms with a Date-based `utimesSync`, both rounding up (Date)
and down (seconds-as-double); none drift when both files get the same whole-second mtime.

---

## Resolution

| Field | Value |
|---|---|
| Closed by / date | Claude (Claude Code session), 2026-10-05 |
| Fix | branch `claude/quick-fixes`, the commit that moves this file to `bugs/closed/` |
| Files changed | `tests/unit/media-move-cache.test.ts` (also, in the same commit and unrelated: one doc comment in `electron/export/renderGraph.ts`) |
| Regression test | `tests/unit/media-move-cache.test.ts::derived media after moving a source file (same bytes, same mtime) > hits the cache at the same path, and misses (regenerates) at the new path` |

### Root cause

The test restored the moved copy's mtime from `fs.statSync(old).mtime` (a millisecond-rounded `Date`) through
`fs.utimesSync`, which is lossy for a sub-millisecond mtime, so the copy's `Math.floor(mtimeMs)` was 1 ms off about
half the time.

### Fix

- `MTIME = new Date(1_700_000_000_000)`: a whole (and even, for 2 s FAT resolution) second, exactly representable as
  seconds in a double and on every file system.
- `beforeAll` sets the source file's mtime to `MTIME` right after FFmpeg writes it, before any cache entry exists,
  and the test asserts `Math.floor(mtimeMs) === MTIME` before generating derived media.
- The move sets the copy's mtime to the same `MTIME` instead of copying the Date.
- Kept: the size and `Math.floor(mtimeMs)` equality checks between the two files, the same-path cache-hit control, and
  every moved-path miss assertion (new key, new thumbnail, waveform decoded again, proxy `cached: false`, cache files
  doubled).
- Added, so the miss is shown to come from the path alone: `cacheKeyForFile(oldPath, moved.size, moved.mtimeMs)`
  equals `keyA`, and `cacheKeyForFile(newPath, st.size, st.mtimeMs)` equals `keyB`.

The test still pins the behaviour described in `bugs/open/2026-10-05-moved-media-cache-miss.md`.

### Before / after

Before: 3 of 6 runs failed (`expected …499 to be …498` and similar). After: 10 of 10 runs passed, and `npm test`
passes 958/958.

### Regression test proof

Before (unchanged test, 6 runs):

```
      Tests  1 passed (1)
AssertionError: expected 1791231657499 to be 1791231657498 // Object.is equality
AssertionError: expected 1791231659743 to be 1791231659742 // Object.is equality
      Tests  1 passed (1)
AssertionError: expected 1791231665111 to be 1791231665110 // Object.is equality
      Tests  1 passed (1)
```

After (10 runs in a row):

```
run 1:  Tests 1 passed (1)
run 2:  Tests 1 passed (1)
run 3:  Tests 1 passed (1)
run 4:  Tests 1 passed (1)
run 5:  Tests 1 passed (1)
run 6:  Tests 1 passed (1)
run 7:  Tests 1 passed (1)
run 8:  Tests 1 passed (1)
run 9:  Tests 1 passed (1)
run 10:  Tests 1 passed (1)
```

### Tests run

- `npm run typecheck`: clean.
- `npm test`: 958/958 passed, 42/42 files.
- `npx vitest run tests/unit/media-move-cache.test.ts`: 10/10 runs passed.

### Changed existing assertions

None removed or loosened. The mtime used by the test changed (a fixed whole second for both files, instead of the
source's own mtime copied through a Date); the equality checks on size and floored mtime are unchanged. Three
assertions were added (source mtime is `MTIME`; each key is reproduced from its own path with the other file's size
and mtime).

### Compatibility risks

None. Test-only change.

### Follow-ups

- `bugs/closed/2026-10-05-export-perf-inputcount-stale.md` and `bugs/closed/2026-10-05-install-packaging-contradiction.md`
  record `npm test` at 957/958 because of this bug; with this fix the suite is 958/958.
