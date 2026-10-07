# Export: a single-sided fade to black (transition with no incoming clip) darkens faster than the preview

| Field | Value |
|---|---|
| Status | open |
| Severity | low |
| Area | export |
| Reported by / date | agent claude/keyframes, 2026-10-07 |
| Found on commit | b63b602 (claude/keyframes; the code path is unchanged from claude/mkv-export) |
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
