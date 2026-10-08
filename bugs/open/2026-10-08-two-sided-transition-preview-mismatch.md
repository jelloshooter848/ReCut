# Two-sided Cross Dissolve and Dip to Black: the export's picture differs from the preview's

| Field | Value |
|---|---|
| Status | open |
| Severity | medium |
| Area | export / playback |
| Reported by / date | agent claude/fix-fade-to-black, 2026-10-08 |
| Found on commit | 4cadd66 (claude/fix-fade-to-black; the two-sided paths are unchanged from main 3b4c127) |
| Environment | Linux, FFmpeg 6.1.1-3ubuntu5, from source (vitest) |

## Report

### Summary
Transitions between two clips render differently in the export and in the Program monitor. Dip to Black is off by up
to 146 luma levels (the export is already near black where the preview still shows two thirds of the outgoing
clip); Cross Dissolve is off by up to 27 levels (the preview dims towards black mid-dissolve, the export mixes
linearly). Found while fixing the single-sided case (`bugs/closed/2026-10-07-export-fade-to-black-ends-early.md`),
which this does not cover.

### Steps to reproduce
`RECUT_FADE_LOG=1 npx vitest run tests/unit/export-fade.test.ts -t "two-sided"` (the opt-in test "Dip to Black and
Cross Dissolve between two clips"; it fails today and prints every frame):
1. Sequence 320×180 at 24 fps, V1: white 0–12, grey (0x808080) 12–24, white 24–36, each with source handles
   (`sourceIn` 1 s).
2. A `dipToBlack` of 6 frames on the first cut, a `crossDissolve` of 6 frames on the second.
3. Export (MP4, crf 0) and compare each frame's mean luma with the preview's picture: `planFrame` layers drawn at
   their alpha over black, as `SequencePlayer.paint` does.

### Expected
The same picture in both.

### Actual
Mean luma, export vs preview:

| Frame | 9 | 10 | 11 | 12 | 13 | 14 | 15 |
|---|---|---|---|---|---|---|---|
| Dip to Black: export | 235 | 16 | 15 | 43 | 77 | 105 | 126 |
| Dip to Black: preview | 235 | 162 | 89 | 16 | 52.7 | 89.3 | 126 |

| Frame | 21 | 22 | 23 | 24 | 25 | 26 | 27 |
|---|---|---|---|---|---|---|---|
| Cross Dissolve: export | 126 | 144 | 162 | 180 | 198 | 216 | 235 |
| Cross Dissolve: preview | 126 | 128.9 | 137.9 | 153 | 174.2 | 201.6 | 235 |

### Evidence
The table above is the test's `RECUT_FADE_LOG` output.

### Suspected cause (hypothesis)
- **Dip to Black:** the export uses `xfade=transition=fadeblack` over `2h` frames with source handles
  (`electron/export/renderGraph.ts` videoTrack). fadeblack is not linear (it reaches black early and uses a
  smoothstep), and xfade's black for YUV may be luma 0. The planner (`src/playback/planner.ts` contribute) has no
  handles: the outgoing clip falls linearly over D/2 frames before the cut and the incoming rises over D/2 after.
  A fix in the spirit of the single-sided one: render the two halves as per-frame alpha ramps on each segment
  (`fadeWeights` / `opacityFilters`) and join them without `xfade` and without handles.
- **Cross Dissolve:** the export's `xfade=fade` is the linear mix `(1 − t)·A + t·B`. The preview draws A at alpha
  `1 − t` over black, then B at alpha `t` over that, which gives `t·B + (1 − t)·((1 − t)·A + t·black)`: darker in
  the middle. Which one is intended is a product decision; the linear mix is the usual dissolve, so the preview may
  be the side to change (for example, draw the outgoing clip at its own opacity and only the incoming one at `t`).

### Scope
Audio crossfades were not checked. With clips on upper tracks, the alpha model also decides what shows through
during a dissolve.
