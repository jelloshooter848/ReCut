# Export: a single-sided fade to black (transition with no incoming clip) darkens faster than the preview

| Field | Value |
|---|---|
| Status | fixed |
| Severity | low |
| Area | export |
| Reported by / date | agent claude/keyframes, 2026-10-07 |
| Found on commit | b63b602 (claude/keyframes). Not caused by keyframes: the `fade=t=out` line dates from fdd0d4b (the first export pipeline) and is identical on main (dfe8a1e) |
| Environment | Linux, FFmpeg 6.1.1-3ubuntu5, from source (vitest) |

## Report

### Summary
A Cross Dissolve at a clip's end with no clip after it (`inClipId: null`, a fade to black over D frames inside the
clip) is rendered by the export with `fade=t=out:st=(N-D)*fd:d=D*fd`. Its level falls faster than the preview's
`(end - frame) / D` ramp: in its last frames the exported picture is noticeably darker than the Program monitor.
Found while measuring keyframed opacity (Roadmap §11); it happens with or without keyframes.

### Steps to reproduce
1. Sequence 320×180 at 24 fps, one 36-frame clip of a white source on V1 (static opacity 1).
2. Add `{ type: 'crossDissolve', duration: 6, outClipId: <clip>, inClipId: null }` to the track's transitions.
3. Export (MP4, crf 0) and read the mean luma of frames 30–35 (as `tests/unit/keyframes-export.test.ts` does).

### Expected
The preview's weights (planner `contribute`): frame 30 → 1, 31 → 5/6, …, 35 → 1/6, i.e. mean luma
16 + 219 × weight: 235, 198.5, 162, 125.5, 89, 52.5.

### Actual
Measured mean luma 235 (frame 30), 196, 157, 118, 78, 39 — the effective level is 0.82, 0.64, 0.47, 0.28, 0.11
instead of 0.83, 0.67, 0.5, 0.33, 0.17 (up to 13.5 luma levels darker at the last frame). With opacity 0.3 the same
frames are off by up to 4 levels.

### Evidence
Debug output of the opacity case in `tests/unit/keyframes-export.test.ts` (static opacity 1, frames 31–35):
`196 vs 198.5`, `157 vs 162`, `118 vs 125.5`, `78 vs 89`, `39 vs 52.5`.

### Suspected cause (hypothesis)
`electron/export/renderGraph.ts` videoSegment: `fade=t=out` with time-based `st` / `d` computes its factor from the
frame timestamp in a way that does not match `(end - frame) / D` per frame (possibly an off-by-part-of-a-frame start
or a non-linear luma mapping in vf_fade). A frame-based form (`fade=t=out:s=<N-D>:n=<D>`) or an alpha / `lut` ramp
evaluated per frame (as keyframed opacity now does) would match the preview exactly.

### Scope
`fade=t=in` of the from-black case (`outClipId: null`) likely has the mirror-image error; audio `afade` was not
checked. Dip to Black uses `xfade=fadeblack` and was not checked.

---

## Verification

| Field | Value |
|---|---|
| Verified by / date | agent claude/fix-fade-to-black, 2026-10-08 |
| Verified on commit | 3b4c127 (main) |
| Verdict | confirmed, wider than reported: fade-in too, and the fade darkened the colour instead of the alpha |

Reproduced with `tests/unit/export-fade.test.ts` (real FFmpeg 6.1.1, 320×180 at 24 fps, flat white and grey sources,
lossless x264). Each exported frame's mean luma is compared with the preview's picture built from
`src/playback/planner.ts` `planFrame`: every layer at its alpha over what is below it, on black (luma 16), the way
`SequencePlayer.paint` draws them. The reported numbers came back exactly: frames 31–35 of the fade-out were 196,
157, 118, 78, 39 against 198.5, 162, 125.5, 89, 52.5.

The suspected timing error was not the cause. vf_fade's time-based factor is `(t − st) / d`, which on frame
`st + k·fd` is `k / D`: the same as the planner's `(frame − start) / D` and `(end − frame) / D`. The measured values
are exactly `235 × weight`, a ramp from white to luma **0**, where the preview ramps to luma 16:

```
ffmpeg -f lavfi -i color=c=white:s=64x64:r=24:d=1 -vf "format=yuv420p,fade=t=in:st=0:d=1,format=yuv420p"  -frames:v 1 -f rawvideo - | od -An -tu1 -N4   → 16 16 16 16
ffmpeg -f lavfi -i color=c=white:s=64x64:r=24:d=1 -vf "format=yuva420p,fade=t=in:st=0:d=1,format=yuv420p" -frames:v 1 -f rawvideo - | od -An -tu1 -N4   →  0  0  0  0
```

---

## Resolution

| Field | Value |
|---|---|
| Closed by / date | agent claude/fix-fade-to-black, 2026-10-08 |
| Fix | 4cadd66 on branch `claude/fix-fade-to-black` |
| Files changed | `electron/export/renderGraph.ts`, `tests/unit/export-fade.test.ts` (new), `docs/export-pipeline.md` |
| Regression test | `tests/unit/export-fade.test.ts` › "fade to / from black: export matches the preview per frame" (7 tests) |

### Root cause
Two defects in the `fade=t=in` / `fade=t=out` filters that `videoSegment` appended for single-sided transitions:
1. **Black level.** vf_fade uses the studio black level (16) only for planar YUV formats without alpha. The segment
   chain runs in `yuva420p`, which vf_fade treats as full range, so the colour faded to luma 0, below video black:
   up to 16 levels darker than the preview (0 instead of 16 on the first frame of a fade-in).
2. **Alpha vs black blend.** `fade` darkened the colour and left the alpha opaque. The preview draws the clip at
   `alpha = opacity × weight` over what is below it, so on V2 and above a fade shows the lower track; the export
   showed black there (126 levels off over a grey V1).

The timing (`st` / `d` rounding, frame vs time, the last frame) was right.

### Fix
`videoSegment` no longer emits `fade`. A new `fadeWeights(seg)` gives the planner's weight on each frame of the
segment (`(n − extBefore) / fadeIn` at the start, `(end − n) / fadeOut` at the end, multiplied and clamped). The
existing per-frame opacity path (`opacityFilters`: a `lut` on the alpha whose factor `sendcmd` sets per frame from
values computed in TypeScript) now takes a value function, `opacity(n) × fade(n)`. A static opacity on a fading clip
moves into that same per-frame factor (one 8-bit quantisation, not two). Clips with no fade and no opacity keyframes
keep the static chain unchanged. Fades and keyframed opacity multiply exactly as in the planner.

### Before / after
Largest |export − preview| mean luma (levels of 219), per case of `tests/unit/export-fade.test.ts`:

| Case | Before | After |
|---|---|---|
| fade out, 6 frames (the reported case) | 13.5 | 1.0 |
| fade in, 8 frames | 16 | 0.75 |
| single-sided Dip to Black at both ends of a clip; a clip at 200 % speed with fades | 16 | 1.2 |
| fade × static opacity 0.5; fade × keyframed opacity | 12.7 | 1.13 |
| fading clip on V2 over grey V1 | 126 | 0.5 |
| chunked export (several chunks, fades at every clip edge); In/Out range starting inside a fade | 16 | 1.2 |

The remaining error comes from the alpha `lut` truncating to 8 bits plus 4:2:0 / x264 rounding.

### Regression test proof
Before the fix (excerpt; all six export cases failed):
```
× fade out at the end of a clip with nothing after it (the reported case)
  → fade out: frame 31 luma 196.00 vs preview 198.50: expected 2.5 to be less than 1.5
  → fade out: frame 35 luma 39.00 vs preview 52.50: expected 13.5 to be less than 1.5
× fade in at the start of a clip with nothing before it
  → fade in: frame 0 luma 0.00 vs preview 16.00: expected 16 to be less than 1.5
× a fading clip over a lower track reveals that track, as in the preview
  → over V1: frame 0 luma 0.00 vs preview 126.00: expected 126 to be less than 1.5
```
After: `✓ tests/unit/export-fade.test.ts (8 tests | 1 skipped)`. The skipped one is the opt-in repro of the
follow-up below (`RECUT_FADE_LOG=1`).

### Tests run
After merging main with #73 (nested sequences): `npm run typecheck` clean; `npm test` 110 files, 1911 passed,
3 skipped (one is the opt-in repro above); e2e `export.spec.ts`, `export-intermediates.spec.ts`, `export-mkv.spec.ts`,
`keyframes.spec.ts` and `nest.spec.ts`: 15/15 passed (Linux, xvfb). Windows and macOS were not run.

### Changed existing assertions
None.

### Compatibility risks
Exports with a fade to / from black change: the fade now ends at video black (16) instead of below it, and on upper
tracks it reveals the track below, as the preview always showed. Project files are unchanged.

### Follow-ups
- Two-sided transitions (Cross Dissolve and Dip to Black between two clips) also differ from the preview, by up to
  146 levels: `bugs/open/2026-10-08-two-sided-transition-preview-mismatch.md`.
- Audio `afade` of the single-sided case was not measured here (this bug is about the picture).
