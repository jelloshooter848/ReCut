# Export drops the first chapter break when the first Chapter marker is after the start; ROADMAP §7 is stale

| Field | Value |
|---|---|
| Status | open |
| Severity | low |
| Area | export (chapters) · docs |
| Reported by / date | Claude (Claude Code session), from a review of 0.2.1 at the project owner's request, 2026-10-06 |
| Found on commit | b5237b5 |
| Environment | Linux container, FFmpeg 6.1.1, source checkout |

## Report

### Summary

Two small findings from reviewing the latest main (0.2.1), alongside reviews of the release by ChatGPT and Grok.

1. **The first chapter break is lost.** When the first Chapter marker in the export range is after the range start,
   export moves that chapter to 0:00. A sequence whose only Chapter marker is "Act Two" at 30:00 exports one chapter,
   "Act Two", from 0:00 to the end. The break at 30:00 is gone and the opening is mislabelled. Editors commonly mark
   only act breaks, not the very start.
2. **ROADMAP §7 (MKV packaging) is stale.** Its "Why deferred" still says chapter markers "are not written at all"
   and that packaging "depends on that fix". The fix landed in 0.2.0 (`bugs/closed/2026-10-05-export-ignores-chapter-markers-copies-source-metadata.md`).

### Steps to reproduce

Finding 1: the existing test `tests/unit/export-chapters.test.ts:232` ("a first chapter marker after the start: the
first chapter starts at 0") encodes it. A 48-frame sequence at 24 fps with one Chapter marker "Late" at frame 12
exports `[[0, 2, 'Late']]`: one chapter, so the break at 0.5 s is not in the file.

Finding 2: read `docs/ROADMAP.md:105-107`.

### Expected

1. The chapter break at the marker survives. Proposed: when the first chapter marker is after the range start, write
   an extra leading chapter from 0 to that marker (empty title, or the sequence name), then the marker's chapter.
   This keeps the MP4 rule the current code relies on (no gap before the first chapter) and keeps every break.
2. ROADMAP §7 says chapter markers are exported (since 0.2.0) and lists only what MKV packaging still needs.

### Actual

1. `[[0, 2, 'Late']]` instead of `[[0, 0.5, ''], [0.5, 2, 'Late']]`.
2. `docs/ROADMAP.md:105`: "Chapter markers are not written at all, and a single-pass export copies the first
   source's chapters and title instead … Packaging depends on that fix."

### Evidence

- The rule is deliberate and documented: `exportChapters` (`electron/export/renderGraph.ts:765`, comment at
  `:760-761`) and `docs/USER-GUIDE.md:243` ("the first chapter always starts at the beginning of the file").
- The proposed leading chapter round-trips through MP4. FFmpeg 6.1.1, an FFMETADATA input with an untitled chapter
  0–30 s and "Act Two" 30–60 s, written with the same flags the export uses
  (`-map_metadata:g -1 -map_metadata:s -1 -map_chapters 1`, `-movflags +faststart`, MP4):

  ```
  chapter|id=0|start_time=0.000000|end_time=30.000000|tag:title=
  chapter|id=1|start_time=30.000000|end_time=60.000000|tag:title=Act Two
  ```

### Suspected cause (hypothesis)

Finding 1: the "no gap before the first chapter" constraint was satisfied by moving the first chapter to 0 instead
of inserting a leading chapter. Finding 2: PR #7 (roadmap) was written before PR #8 (chapter fix) merged.

### Scope

- The In/Out case is unaffected when a chapter marker before In is still current at In (it rightly becomes the first
  chapter at 0). Only a range with no chapter marker at or before its start is affected.
- `tests/unit/export-chapters.test.ts:232` asserts the current behaviour and must change with the fix (an existing
  assertion that encodes the bug). `docs/USER-GUIDE.md:243` and `docs/FORMATS.md` need the new rule.
- MKV packaging (ROADMAP §7) will reuse `exportChapters`, so the fix carries over.

### Already tracked, not filed again

Two other review findings are already rows in `bugs/open/2026-10-05-perf-budgets-2500-clips.md`; flagging them for
whoever works that report:
- `serializeProject` measured 704 ms, against 344 ms on `92eb1f1` earlier the same day (row at line 64). That may be a
  regression rather than noise; bisect before working the save budget.
- Program playback at 1 px/frame holds 24 fps but has one 1,503 ms long task (line 51), a visible freeze.

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
