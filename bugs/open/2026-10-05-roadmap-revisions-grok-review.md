# Roadmap lacks MKV packaging and pre-export checks, and leaves keyframe v1 unscoped

> **Not a code defect.** At the project owner's direction, roadmap gaps are filed as bugs *in the roadmap*. The bugs
> folder is the channel for reporting to the orchestrating agent. "Fixing" this report means revising
> `docs/ROADMAP.md`, not changing code. The one real code defect found during this review is filed separately as
> `bugs/open/2026-10-05-export-ignores-chapter-markers-copies-source-metadata.md`.

| Field | Value |
|---|---|
| Status | open |
| Severity | medium (roadmap, not runtime: the plan omits the step most fan edits finish with, MKV packaging) |
| Area | roadmap / docs |
| Reported by / date | Claude (Claude Code session), at the project owner's request, 2026-10-05 |
| Found on commit | b62f1fe |
| Environment | n/a (documentation review) |

## Report

### Summary

A roadmap proposal from Grok ("Suggested Changes to the ReCut Roadmap") was reviewed against the revised
`docs/ROADMAP.md` on main (after `bugs/closed/2026-10-05-roadmap-revisions.md`) and against the code. Most of it
repeats what the revised roadmap already says. The revisions below are the ones that survived review: two new entries,
one scoping change, and one ordering change to consider. The review also records which suggestions were rejected and
why, so they are not re-proposed.

### Steps to reproduce

1. Read `docs/ROADMAP.md` on commit b62f1fe.
2. Compare with the requested revisions below.

### Expected

The roadmap covers how fan edits are actually delivered (a muxed MKV with chapters, several audio tracks and
subtitles), catches common fan-edit mistakes before a long export, and scopes large features so a first version can
ship.

### Actual

#### Revisions requested

1. **Add MKV packaging export (new entry).**
   Export is MP4 only, and the export settings force the file name to `.mp4` (`src/panels/export/settings.ts:46`).
   Fan edits are usually delivered as MKV with chapters, more than one audio track (for example 5.1 plus a stereo
   downmix, or a commentary) and soft subtitle tracks. Today that means a second pass in MKVToolNix. FFmpeg's Matroska
   muxer can write all of this, so `mkvmerge` is not required. Plan: an MKV container option, chapter markers written
   as chapters, one audio track per selected mix, and subtitle tracks muxed as soft subtitles instead of only burned in
   or written as a sidecar. Depends on the chapter defect above. Fits beside §8 (intermediate and audio-only export).

2. **Extend the export dialog's pre-export warnings (new entry, small).**
   The export dialog already lists problems before export (`src/panels/export/settings.ts:347-363`: empty sequence,
   missing or offline media, unanalysed media, invalid frame rate, upmixed 5.1, no subtitle tracks). Extend that list
   instead of building a new panel:
   - a source whose frame rate differs from the sequence's;
   - VFR media used in the sequence (already detected and flagged in the Media Inspector);
   - linked clips that are out of sync (already detected for the timeline badge);
   - transitions without enough source frames for their handles. Transition length is limited by clip length only
     (`shared/timeline.ts:202`), not by the media past the clip's ends. The renderer already detects a clip that
     runs past its media and holds the last frame (`electron/export/renderGraph.ts:278`), but that warning only
     comes back after the export finishes.
   "Abrupt level jumps at cuts" and "subtitle timing drift", also proposed, are vague and need analysis passes.
   Leave them out of the first version.

3. **Scope keyframes v1 (§9).**
   Limit the first version to opacity, volume, position and scale, with linear and ease interpolation. That covers
   ducking under dialogue and Ken Burns moves on stills (§9's own reasons) without a curve editor or keyframes on
   every property. Rotation, crop, audio level curves and a graph editor can follow.

4. **Consider moving intermediate / audio-only export (§8) and EDL / OTIO export (§7) ahead of nested sequences
   (§5).**
   Both are export-side and fairly self-contained. Nesting touches the preview, export, sync, Compare and
   interchange. Grok proposes this order. It is reasonable but not required: the cost is that interchange would then
   have to be extended for nesting later, which §5's plan already anticipates (OTIO stacks, flatten for EDL).
   Owner's call.

#### Suggestions reviewed and rejected

- **Match Frame and "promote a range to the scene library".** Already built. Match Frame is a command on the F key
  (`src/keyboard/commands.ts:51`, `src/keyboard/shortcuts.ts:48`). The Scenes panel has "New scene from clip" and
  "New scene from Source In/Out" (`src/panels/scenes/ScenesPanel.tsx:371`).
- **Raise the performance gate to 5,000+ clips now.** Premature. The 2,500-clip project still misses its edit, scrub
  and open budgets (`bugs/open/2026-10-05-perf-budgets-2500-clips.md`). Meet those first. A multi-hour sequence is
  already planned in §1.
- **Nested sequences ahead of OCR (§3).** OCR is cheap and self-contained and unblocks transcript search on most
  Blu-ray and DVD rips. Nesting is the most invasive feature on the list. Keep OCR first.
- **"Uses the already-bundled FFmpeg."** FFmpeg is bundled only in the Windows builds (`docs/LIMITATIONS.md:91`).
  Any packaging feature must handle a user-installed FFmpeg.
- **Already on the roadmap, no change:** performance and preview gates (§1, §2), OCR before Whisper (§3, §4),
  centre-channel extraction as an early utility (§6), stem separation after keyframes with no bundled Python (§10),
  Collect Project (§14), titles (§16). Reverse speed and ASS styling, which Grok suggests de-prioritising, are not
  scheduled anyway.
- **Stem separation before the full surround mixer.** A judgment call, not adopted here. Stems mostly need volume
  automation, which keyframes v1 (item 3) provides, so the current order (§6 mixer, §9 keyframes, §10 stems) works
  either way.

### Evidence

- Source proposal: "Suggested Changes to the ReCut Roadmap" (Grok), supplied by the project owner on 2026-10-05.
- `docs/ROADMAP.md` §1–§16, `src/panels/export/settings.ts:46` and `:347-363`, `shared/timeline.ts:202`,
  `electron/export/renderGraph.ts:278`, `src/keyboard/commands.ts:51`,
  `src/panels/scenes/ScenesPanel.tsx:371`, `docs/LIMITATIONS.md:91`,
  `bugs/open/2026-10-05-perf-budgets-2500-clips.md`.

### Suspected cause (hypothesis)

The roadmap is organised by editor capability. Delivery (packaging) and pre-flight checks fall between its entries.

### Scope

- Item 1 depends on `bugs/open/2026-10-05-export-ignores-chapter-markers-copies-source-metadata.md`. That defect
  should be fixed whether or not MKV export is scheduled.

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
