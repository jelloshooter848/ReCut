# Export drops the first chapter break when the first Chapter marker is after the start; ROADMAP §7 is stale

| Field | Value |
|---|---|
| Status | fixed |
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
| Verified by / date | Claude (Claude Code session), 2026-10-06 |
| Verified on commit | a925af2 (`origin/main`) |
| Verdict | both confirmed |

**Finding 1, confirmed** with real exports through `runExport` and ffprobe, on FFmpeg 6.1.1-3ubuntu5, 8.1.3 and 9.0.2
(the regression tests below, run before the fix). A 48-frame 24 fps sequence with one Chapter marker "Late" at frame
12 exports one chapter, `[[0, 2, 'Late']]`, in a single-pass and in a chunked export; the break at 0.5 s is not in
the file. An In/Out export (In 30, Out 78) with Chapter markers at 42 and 60 and none at or before In exports
`[[0, 1.25, 'Inside A'], [1.25, 2, 'Inside B']]`: the "Inside A" break at 0.5 s is moved to 0. A marker one frame
after the start loses its break entirely (`['One frame in']` only, at 23.976, 24 and 30 fps). Same result on all
three FFmpeg versions. It is the documented rule in `exportChapters` ("The first chapter always starts at 0"), not an
FFmpeg effect.

**Finding 2, confirmed.** `docs/ROADMAP.md` §7 "Why deferred" said "Chapter markers are not written at all, and a
single-pass export copies the first source's chapters and title instead … Packaging depends on that fix." Chapter
markers have been exported as MP4 chapters, with no source metadata, since 0.2.0
([report](2026-10-05-export-ignores-chapter-markers-copies-source-metadata.md)).

---

## Resolution
<!-- Required before moving the file to bugs/closed/. -->

| Field | Value |
|---|---|
| Closed by / date | Claude (Claude Code session), 2026-10-06 |
| Fix | Untitled leading chapter from 0 to the first Chapter marker when no Chapter marker is at or before the range start; ROADMAP §7 rewritten |
| Files changed | `electron/export/renderGraph.ts`, `tests/unit/export-chapters.test.ts`, `docs/USER-GUIDE.md`, `docs/FORMATS.md`, `docs/ROADMAP.md`, this report |
| Regression test | `tests/unit/export-chapters.test.ts` (11 tests added, 1 removed: the one that encoded the bug) |

### Root cause

Finding 1: `exportChapters` must not leave a gap before the first chapter (an MP4 chapter text track cannot, and
FFmpeg reads such a file back with the first chapter at 0). It met that by giving the first chapter `start: 0`
whatever its marker's frame was, which moved the first marker's break to 0 when that marker was after the range
start. Finding 2: the roadmap was written before the chapter-export fix merged.

### Fix

Finding 1, `exportChapters` (`electron/export/renderGraph.ts`): after the marker chapters are collected, if the first
one starts after `startF`, an untitled chapter `{ f: startF, title: '' }` is put in front of it (one line). The rest
is unchanged: a Chapter marker at or before `startF` (the latest one) still covers the range start and becomes the
first chapter at 0, with no leading chapter; markers at or after `endF` are dropped; each chapter ends where the next
one starts, the last at the output duration; two markers on one frame, the later in the list wins; times are
sequence seconds, so an output frame-rate conversion does not move them; a range with no Chapter markers gets no
chapters (and no leading chapter). The chunked export joins the chunks with the same `chaptersContent`, so it is
identical to the single pass. MKV packaging (ROADMAP §7) will reuse `exportChapters`, so the fix carries over.

**Leading chapter title: empty.** Chosen over the sequence name because:

- It is exactly what the export already writes for a Chapter marker with an empty name, and it round-trips: ffprobe
  on FFmpeg 6.1, 8.1 and 9.0 reads it back as a chapter with an empty `title` tag (`tag:title=`, JSON
  `"title": ""`) and the right start and end.
- The sequence name names the whole edit (often still "Sequence 1"), not its opening; in an In/Out export it does
  not describe the start of the range at all. Writing it would label the opening with something the editor never
  put there.
- No concrete problem found with the empty title. GUI players are not available in this container (no mpv / VLC), so
  how a particular player labels an untitled chapter was not checked; that is the player's own default either way.

One thing that does matter, found while checking this: the FFMETADATA file must keep an explicit `title=` line for
the untitled chapter. With the line left out, FFmpeg 6.1, 8.1 and 9.0 all write a chapter track that reads back as
`0–1.5 "Late"`, `0.5–2 "Late"` instead of `0–0.5 ""`, `0.5–2 "Late"`. `ffmetadataChapters` always writes `title=`
(pinned by the existing `ffmetadataEscape / ffmetadataChapters` test), and the new real-export tests would fail if
it stopped.

Finding 2: `docs/ROADMAP.md` §7 "Why deferred" now says chapters are no longer the blocker (Chapter markers exported
as MP4 chapters since 0.2.0, linking both closed reports; MKV would reuse `exportChapters`) and lists only what
packaging still needs: a container option (the export settings force `.mp4`, `withMp4` in
`src/panels/export/settings.ts`), more than one audio track (export mixes to one track today), and soft subtitle
tracks. The Plan says "Chapters as in MP4 export" and that the file extension follows the container. Nothing is
renumbered.

Docs: `docs/USER-GUIDE.md` §15 (Chapters) and `docs/FORMATS.md` (export, Chapters) describe the new rule.
`CHANGELOG.md` is not touched: `docs/RELEASING.md` says feature and bug PRs never touch it (the release PR builds the
section from the closed reports); the only exception it allows is a line in a version section whose release failed
to publish, and 0.2.1 is published.

### Before / after

Real exports, ffprobe chapters as `[start, end, title]` (times rounded to ms):

| Case | Before (a925af2) | After |
|---|---|---|
| One Chapter marker "Late" at frame 12 of 48 (24 fps), single and chunked | `[0, 2, 'Late']` | `[0, 0.5, '']`, `[0.5, 2, 'Late']` |
| In 30 / Out 78, markers at 42, 60 (none at or before In), single and chunked | `[0, 1.25, 'Inside A']`, `[1.25, 2, 'Inside B']` | `[0, 0.5, '']`, `[0.5, 1.25, 'Inside A']`, `[1.25, 2, 'Inside B']` |
| Markers "First" @6, "Second" @30 of 48 | `[0, 1.25, 'First']`, `[1.25, 2, 'Second']` | `[0, 0.25, '']`, `[0.25, 1.25, 'First']`, `[1.25, 2, 'Second']`; chunked identical |
| First marker exactly at In (30), single and chunked | `[0, 1, 'At In']`, `[1, 2, 'Next']` | unchanged |
| First marker at frame 0 (whole sequence) | "Opening" at 0 | unchanged |
| Marker before In still current at In | first chapter at 0 | unchanged |

**One-frame leading chapter** (first Chapter marker at start + 1 frame), ReCut export, ffprobe after the fix:

| FFmpeg | 23.976 fps | 24 fps | 30 fps |
|---|---|---|---|
| 6.1.1 | `0–0.042 ''`, `0.042–2.002 'One frame in'` | `0–0.042 ''`, `0.042–2 'One frame in'` | `0–0.033 ''`, `0.033–1.6 'One frame in'` |
| 8.1.3 | `0–0.042 ''`, `0.042–2.002 'One frame in'` | `0–0.042 ''`, `0.042–2 'One frame in'` | `0–0.033 ''`, `0.033–1.6 'One frame in'` |
| 9.0.2 | `0–0.041708 ''`, `0.041708–2.002 'One frame in'` | `0–0.041667 ''`, `0.041667–2 'One frame in'` | `0–0.033333 ''`, `0.033333–1.6 'One frame in'` |

The one-frame chapter survives on every version and frame rate: it is neither dropped nor merged into the next. 6.1
and 8.1 read MP4 chapter times back in milliseconds (time base 1/1000), so the break lands within 0.5 ms of the frame
boundary; 9.0 reads it back at full precision. No special handling is needed, so a one-frame leading chapter is
written like any other.

### Regression test proof

`tests/unit/export-chapters.test.ts` before the fix (code at a925af2, new tests), identical on FFmpeg 6.1.1, 8.1.3
and 9.0.2:

```
   × export chapters > a single chapter marker mid-sequence (single): an untitled leading chapter, then the marker's chapter
   × export chapters > In/Out range, no chapter marker at or before In (single): untitled leading chapter from In
   × export chapters > a single chapter marker mid-sequence (chunked): an untitled leading chapter, then the marker's chapter
   × export chapters > In/Out range, no chapter marker at or before In (chunked): untitled leading chapter from In
   × export chapters > an untitled leading chapter: single pass and chunked export write identical chapters
   × export chapters > first chapter marker one frame after the start at 23.976 fps: a one-frame leading chapter
   × export chapters > first chapter marker one frame after the start at 24 fps: a one-frame leading chapter
   × export chapters > first chapter marker one frame after the start at 30 fps: a one-frame leading chapter
   × graph and FFMETADATA (pure) > exportChapters: an untitled leading chapter only when no chapter marker is at or before the range start
AssertionError: expected [ [ +0, 2, 'Late' ] ] to deeply equal [ [ +0, 0.5, '' ], [ 0.5, 2, 'Late' ] ]
AssertionError: expected [ [ +0, 1.25, 'Inside A' ], …(1) ] to deeply equal [ [ +0, 0.5, '' ], …(2) ]
AssertionError: expected [ [ +0, 1.25, 'First' ], …(1) ] to deeply equal [ [ +0, 0.25, '' ], …(2) ]
AssertionError: expected [ 'One frame in' ] to deeply equal [ '', 'One frame in' ]
AssertionError: expected [ Array(1) ] to deeply equal [ …(2) ]
      Tests  9 failed | 19 passed (28)
```

The new "first chapter marker exactly at In" tests (single and chunked) pass before and after: they pin a case that
must not change. After the fix: `Tests  28 passed (28)` on FFmpeg 6.1.1, 8.1.3 and 9.0.2.

### Tests run

- `npm run typecheck`: clean.
- `npm test` (FFmpeg 6.1.1): 44 files, 988 tests passed (978 on a925af2: 11 tests added, 1 removed).
- `tests/unit/export-chapters.test.ts` with `RECUT_FFMPEG` / `RECUT_FFPROBE` set to FFmpeg 8.1.3 and 9.0.2: 28 passed
  each.
- `npx vitest run -c tests/attack/vitest.config.ts tests/attack/exportgraph.test.ts`: 12 passed.

### Changed existing assertions

- `tests/unit/export-chapters.test.ts`, "a first chapter marker after the start: the first chapter starts at 0"
  (single pass) asserted `[[0, 2, 'Late']]`, which is the bug. Replaced by "a single chapter marker mid-sequence
  (single / chunked): an untitled leading chapter, then the marker's chapter", asserting
  `[[0, 0.5, ''], [0.5, 2, 'Late']]` (the sequence is now two clips so that the chunked variant really chunks).
- `seqWith` in the same file takes an optional sequence frame rate (default 24, so existing tests are unchanged).

No other assertion changed: the whole-sequence, In/Out ("Covers In" at 0), frame-rate-conversion, escaping,
single-vs-chunked, no-markers and graph/args tests pass unmodified.

### Compatibility risks

- **Visible change in exported files:** a range with no Chapter marker at or before its start now has one more
  chapter (untitled, first), so player chapter numbering for such files shifts by one. This is the intended
  behaviour. Ranges whose first Chapter marker is at the start are unchanged, as are ranges with no Chapter markers
  (still no chapters).
- Project files: unchanged (`formatVersion` 1); nothing is stored.
- The untitled chapter relies on `ffmetadataChapters` writing an explicit `title=` line (see Fix); already the case
  and covered by tests.

### Follow-ups

- `docs/export-pipeline.md:199-204` (not in this task's file list, so not edited) still describes the rule only as
  "The first chapter starts at 0, because an MP4 chapter track cannot leave a gap before it". Still true, but it
  should add: "When no chapter marker is at or before `startF`, an untitled leading chapter runs from 0 to the first
  marker, so that break is kept."
- Not worked here; already rows in [the perf budgets report](2026-10-05-perf-budgets-2500-clips.md), flagged
  by this report for whoever works that one:
  - `serializeProject` measured 704 ms against 344 ms on `92eb1f1` earlier the same day: possibly a regression
    rather than noise; bisect before working the save budget.
  - Program playback at 1 px/frame holds 24 fps but has one 1,503 ms long task, a visible freeze.
