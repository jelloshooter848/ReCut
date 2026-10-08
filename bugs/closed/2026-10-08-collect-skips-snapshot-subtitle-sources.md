# Collect Project skips subtitle files only a sequence snapshot names

| Field | Value |
|---|---|
| Status | fixed |
| Severity | low |
| Area | project I/O (Collect Project) |
| Reported by / date | Claude (Collect round trips, 1.0 RC work), 2026-10-08 |
| Found on commit | 888c4d2 |
| Environment | Linux 6.18 (container), Node 22; source checkout (unit test) |

## Report

### Summary
With **Include subtitle files**, Collect copies the files listed in sequence subtitle tracks' `sourcePaths` of the
live sequences only. A snapshot whose subtitle track names a file the live sequence no longer has (the track was
removed or re-imported from another file after the snapshot) keeps the original path in the collected project, so
the copy references a file outside the collected folder. The rewrite step already handles snapshots; only the
selection missed them.

### Steps to reproduce
1. Import `fan v1.srt` into a sequence subtitle track; take a snapshot; re-import the track from `fan v2.srt`.
2. Collect Project with **Include subtitle files**.
3. In the collected `.recut`, the snapshot's track still lists `/original/folder/fan v1.srt`; `Subtitles/` holds only
   `fan v2.srt`.

Automated: `tests/unit/collect-plan.test.ts` › "subtitle sources only a sequence snapshot still names are collected
and rewritten too", and the snapshot of the 0.8.0 fixture in `tests/unit/collect-roundtrip.test.ts`.

### Expected
Both files are copied to `Subtitles/`, and the live track and the snapshot's track point at their copies.

### Actual
```
 × selection > subtitle sources only a sequence snapshot still names are collected and rewritten too
   → expected [ '/subs/fan v2.srt' ] to deeply equal [ '/subs/fan v2.srt', …(1) ]
```
and in the round trip, `Subtitles/Episode V.en.srt` (named only by the snapshot) was missing.

### Evidence
See above.

### Suspected cause (hypothesis)
`collectSources` (shared/collect.ts) walks `seq.subtitleTracks` but not `seq.snapshots[*].data.subtitleTracks`,
while `mediaUsedInSequences` and `rewriteCollectedProject` both include snapshots.

### Scope
Media used only by snapshots were already collected (`mediaUsedInSequences`). No other snapshot-only references exist.

---

## Verification

| Field | Value |
|---|---|
| Verified by / date | Claude, 2026-10-08 |
| Verified on commit | 888c4d2 |
| Verdict | confirmed |

Reproduced with the unit test above on 888c4d2. The suspected cause was right.

---

## Resolution

| Field | Value |
|---|---|
| Closed by / date | Claude, 2026-10-08 |
| Fix | branch `claude/collect-tests-080` (this commit) |
| Files changed | `shared/collect.ts` |
| Regression test | `tests/unit/collect-plan.test.ts` › "subtitle sources only a sequence snapshot still names are collected and rewritten too"; `tests/unit/collect-roundtrip.test.ts` |

### Root cause
The selection and the rewrite disagreed about snapshots: the rewrite remapped snapshot sources, the selection never
added them.

### Fix
`collectSources` adds the `sourcePaths` of snapshot subtitle tracks too (the same helper as for live tracks), so the
selection matches the rewrite. Restoring a snapshot brings those tracks back, so they are the project's files.

### Before / after
Before: the snapshot kept `/…/old timing/Episode V.en.srt`. After: it names `<folder>/Subtitles/Episode V.en.srt`,
a byte-identical copy.

### Regression test proof
Failing output on 888c4d2 under Actual. After the fix: `collect-plan.test.ts` 18/18, `collect-roundtrip.test.ts` 4/4.

### Tests run
`npm run typecheck`: clean. `npm test`: 114 files, 1989 passed, 3 skipped.

### Changed existing assertions
None.

### Compatibility risks
None. A collect may copy a few more (small) subtitle files.

### Follow-ups
None.
