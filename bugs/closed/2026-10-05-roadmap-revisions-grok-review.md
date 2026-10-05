# Roadmap lacks MKV packaging and pre-export checks, and leaves keyframe v1 unscoped

> **Not a code defect.** At the project owner's direction, roadmap gaps are filed as bugs *in the roadmap*. The bugs
> folder is the channel for reporting to the orchestrating agent. "Fixing" this report means revising
> `docs/ROADMAP.md`, not changing code. The one real code defect found during this review is filed separately as
> `bugs/open/2026-10-05-export-ignores-chapter-markers-copies-source-metadata.md`.

| Field | Value |
|---|---|
| Status | fixed |
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
| Verified by / date | Claude (Claude Code session), 2026-10-05 |
| Verified on commit | ca555b5 (`origin/main`) |
| Verdict | Confirmed. Every file:line reference holds on ca555b5. One refinement: transition handles are already computed before rendering, in `buildRenderGraph`, not only detected as a clip running past its media. |

Each claim was checked by reading the cited lines and searching the code for the detection signals.

| # | Claim | Verdict |
|---|---|---|
| 1 | Export settings force `.mp4` (`src/panels/export/settings.ts:46`) | Confirmed. `withMp4` (`:43`) returns `name.replace(/\.(mov\|mkv\|m4v\|avi)$/i, '') + '.mp4'` at `:46`; `:62` applies it to the output path. The audio graph also mixes every track into one `[aout]` (`electron/export/renderGraph.ts:1056`, `-map [aout]` at `:1081`), so one audio track is all export can write today. |
| 1 | MKV packaging depends on the chapter defect | Confirmed. Chapter markers exist (`MarkerKind` `'chapter'`, `shared/model.ts:215`) and nothing writes them; see `bugs/open/2026-10-05-export-ignores-chapter-markers-copies-source-metadata.md` (being fixed in a parallel branch). |
| 2 | Existing checklist at `settings.ts:347-363` covers empty sequence, missing / offline / unanalysed media, invalid frame rate, upmixed 5.1, no subtitle tracks | Confirmed. `exportChecklist` starts at `:344`; items at `:347` (empty), `:352` (missing), `:353` (offline), `:354` / `:356` (analysis failed / pending), `:357` (In/Out unset, not listed in the report), `:359` (invalid fps), `:360` (upmix), `:361` (no subtitles), `:363` (proxies info, not listed). Called from `src/panels/export/ExportDialog.tsx:251`. |
| 2a | Source fps differing from the sequence is not checked at export | Confirmed. No general check exists. The only comparison is `conformTargetFor` (`src/panels/source/insert.ts:57`), the conform prompt on the first edit into an *empty* sequence, using `fpsEquals` (`shared/time.ts:63`). Source rate is in `probe.video.fps`. |
| 2b | VFR is already detected and flagged in the Media Inspector | Confirmed. Set in `electron/media/probe.ts:222` (`isVfr`, nominal vs average rate differ by more than 0.5%), stored in `shared/model.ts:43`, flagged in `src/panels/inspector/MediaInspector.tsx:124` (VFR badge), `src/panels/project/InfoFooter.tsx:33` and `src/panels/project/format.ts:42`. Not used by export. |
| 2c | Out-of-sync linked clips already detected for the timeline badge | Confirmed. `linkedSyncOffsets` (`src/panels/timeline/clipBadges.ts:19`), computed in `src/panels/timeline/TimelinePanel.tsx:122`, badge in `src/panels/timeline/ClipView.tsx:176-177`. Renderer-side, same layer as `exportChecklist`. |
| 2d | Transition length limited by clip length only (`shared/timeline.ts:202`) | Confirmed. `transitionLimit` uses `clip.duration` minus the other edge's transition; no source media check. |
| 2d | Renderer detects a clip past its media and holds the last frame (`renderGraph.ts:278`), warning only after export | Confirmed, with a refinement. `:278` is the past-the-end warning. In addition, `buildRenderGraph` already computes source handles per transition (`handleOut` / `handleIn`, `renderGraph.ts:309-310`) and warns when a transition is dropped (`:316`, "not enough source handles") or shortened (`:318`). All these warnings travel in the export result and are shown only as a toast when the job finishes (`src/app/jobsRouter.ts:114`). The roadmap plan therefore moves the existing handle calculation into `shared/` rather than writing a new one. |
| 2 | Leave out level jumps and subtitle drift | Agreed (owner decision); recorded in §3. |
| 3 | Keyframes v1 scope | Adopted as stated (§11). |
| 4 | Move §8 and §7 ahead of nesting | Owner decided: intermediate / audio-only (now §6) and the new MKV entry (§7) go before nesting (§8); interchange (now §10) stays after nesting. |
| R1 | Match Frame on F (`src/keyboard/commands.ts:51`, `src/keyboard/shortcuts.ts:48`) | Confirmed. |
| R1 | Scenes panel "New scene from clip" / "from Source In/Out" (`src/panels/scenes/ScenesPanel.tsx:371`) | Confirmed (the `NamePromptDialog` title at `:371`). |
| R2 | 2,500-clip project misses budgets | Confirmed: `bugs/open/2026-10-05-perf-budgets-2500-clips.md` is still open; ROADMAP §1 states the numbers. |
| R3 | Nesting not ahead of OCR | Agreed; recorded. |
| R4 | FFmpeg bundled only on Windows (`docs/LIMITATIONS.md:91`) | Confirmed. |

---

## Resolution
<!-- Required before moving the file to bugs/closed/. -->

| Field | Value |
|---|---|
| Closed by / date | Claude (Claude Code session), 2026-10-05 |
| Fix | Branch `claude/roadmap-grok` (see the commit that moves this file) |
| Files changed | `docs/ROADMAP.md`, this file (moved to `bugs/closed/`) |
| Regression test | None: documentation-only change. Verification evidence is the per-claim table above and the cross-reference check below. |

### Root cause

The roadmap was organised by editor capability. Delivery (MKV packaging) and pre-flight checks fell between its
entries, and keyframes had no first-version scope.

### Fix

`docs/ROADMAP.md` rewritten in the same style (Why / Why deferred / Plan, rough priority order), renumbered 1–18 in
the order the project owner set:

1. Performance at franchise scale (gate), unchanged.
2. Fix the remaining preview gaps (gate), unchanged.
3. **Pre-export warnings (new).** Extends `exportChecklist`: source fps differs from sequence, VFR media, out-of-sync
   linked clips, transitions without enough source handles. Names where each signal is computed today. Excludes
   abrupt level jumps and subtitle timing drift from v1.
4. Bitmap subtitle OCR (was §3), unchanged.
5. Local speech-to-text / Whisper (was §4), unchanged.
6. Intermediate and audio-only export (was §8), unchanged content.
7. **MKV packaging export (new).** Container option, chapters from chapter markers, one audio track per mix, soft
   subtitle tracks, FFmpeg's Matroska muxer (no `mkvmerge`), must work with a user-installed FFmpeg; notes that
   `withMp4` forces `.mp4` today; depends on the chapter / metadata fix (linked at its `bugs/closed/` path).
8. Nested sequences and compound clips (was §5), plus a note that interchange must be extended for nesting.
9. Surround mixing incl. centre-channel extraction (was §6).
10. Interchange (was §7), plus why it stays after nesting.
11. Keyframes (was §9), plus v1 scope: opacity, volume, position, scale; linear and ease; rotation, crop, audio
    level curves and a graph editor later.
12. Stem separation (was §10).
13. Colour tools (was §11). 14. GPU decode (was §12). 15. Multi-language subtitles (was §13). 16. Collect /
    Consolidate Project (was §14). 17. Cloud-free collaboration (was §15). 18. Smaller items (was §16).

Added an **Ordering decisions** section at the end (linked from the intro): delivery work (§6, §7) before nesting by
owner decision on 2026-10-05; interchange after nesting; and the rejected suggestions (Match Frame / promote to scene
library already built; 5,000+ clip gate premature; nesting not ahead of OCR).

Cross-references inside ROADMAP updated: OCR → Whisper §4→§5; Whisper → OCR §3→§4; intermediate export →
interchange §7→§10 and stems §10→§12; nesting → interchange §7→§10; surround → stems §10→§12; stems → mixer §6→§9,
keyframes §9→§11, Whisper §4→§5 (preview gaps §2 unchanged); Collect → relative media roots §15→§17.

### Before / after

- Before: 16 sections; no MKV or pre-export entry; keyframes unscoped; nesting (§5) ahead of interchange and
  intermediate export.
- After: 18 sections in the owner's order; every `§N` in ROADMAP resolves to the intended section (checked with
  `grep -no "§[0-9]*\|^## .*" docs/ROADMAP.md`).

### Regression test proof

Not applicable (docs only). Evidence: the Verification table (each file:line re-read on ca555b5) and the
cross-reference grep above.

### Tests run

Run on the branch to confirm nothing else changed:
- `npm run typecheck`: passes (both `tsconfig.json` and `tsconfig.electron.json`).
- `npm test`: 42 test files, 958 tests, all passed.

### Changed existing assertions

None.

### Compatibility risks

None for code. Section numbers changed; references elsewhere that use the old numbers are listed under Follow-ups.

### Follow-ups

Not edited here (outside this task's files):
- `bugs/open/2026-10-05-moved-media-cache-miss.md:70` cites "`docs/ROADMAP.md` §14, §15" for Collect Project and
  relative media roots. These are now §16 and §17.
- `bugs/open/2026-10-05-export-ignores-chapter-markers-copies-source-metadata.md:135` links this report at its
  `bugs/open/` path; it is now `bugs/closed/2026-10-05-roadmap-revisions-grok-review.md`, and the MKV entry is
  ROADMAP §7.
- `bugs/open/2026-10-05-perf-budgets-2500-clips.md:99` cites §1, still correct.
- `README.md:120` and `docs/LIMITATIONS.md:4` link the file, not a section; no change needed. No document links a
  ROADMAP section anchor.
- Closed reports (`bugs/closed/2026-10-05-roadmap-revisions.md`, `bugs/closed/2026-10-05-install-packaging-contradiction.md:82`)
  cite the old numbering and ROADMAP line numbers as historical records of that time; left as is.
- Implementing §3 will need `src/panels/export/settings.ts` plus a new pure handle function in `shared/` shared with
  `electron/export/renderGraph.ts`.
