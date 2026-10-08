# Two-sided Cross Dissolve and Dip to Black: the export's picture differs from the preview's

| Field | Value |
|---|---|
| Status | fixed |
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

---

## Verification

| Field | Value |
|---|---|
| Verified by / date | agent claude/fix-transitions, 2026-10-08 |
| Verified on commit | 94bb18e (claude/fix-fade-to-black) |
| Verdict | confirmed, wider than reported: odd lengths, upper tracks, transparency and dips without handles differ too |

The opt-in repro (`RECUT_FADE_LOG=1 npx vitest run tests/unit/export-fade.test.ts -t two-sided`) printed the
reported table exactly. Both hypotheses were right:

- **Dip to Black:** `xfade=transition=fadeblack` over `2h` frames with handles is not the preview's dip. It is at
  black a frame after the window opens (measured down to luma 7, below video black at 16), comes back on a
  smoothstep, and shows the outgoing clip's handle frames past the cut. The preview fades each clip linearly over
  `D/2` frames inside the clip, without handles.
- **Cross Dissolve:** the export's `xfade=fade` is the linear mix; the preview drew the outgoing layer at `1 − t`
  over black, then the incoming at `t` over that, giving `t·B + (1 − t)²·A`: 27 levels dark at the cut.

The new tests found three more differences:

- **Odd lengths:** the export renders `2⌊D/2⌋` frames (documented: "an odd length renders one frame less"), the
  preview rendered `D` frames with weights `(k + ½)/D`: 54 levels apart on a 3-frame dissolve, and the Audio
  Crossfade's gain up to 0.071 apart on a 7-frame one.
- **Transparency:** `xfade` mixes straight-alpha frames, so where the two clips' alphas differ (opacity, a
  pillarboxed or scaled picture, fades) the colour is mixed towards the transparent clip's black. Neither side was
  the mix of the two pictures over the track below.
- **Dip to Black without handles:** the export dropped the dip ("not enough source handles", a hard cut) where the
  preview, which needs none, dipped.

### Decision (orchestrator, 2026-10-08)
Standard NLE behaviour:

- **Cross Dissolve** is the linear mix `out·(1 − t) + in·t`, no dimming. The export was right; the preview changes.
  Over transparent areas or lower tracks it is defined as `(1 − t)·(out over below) + t·(in over below)` (the mix of
  the two pictures as each would look on its own), which is the premultiplied mix of the two layers laid over what is
  below.
- **Dip to Black** fades the outgoing clip linearly to black over the first half, then the incoming one up from black
  over the second half, each on frames it shows anyway. The preview was right; the export changes.
- **Odd lengths** (decided while fixing, following the export plan's documented rule and the Export dialog's
  checklist): a centred Cross Dissolve / Audio Crossfade covers `2⌊D/2⌋` frames in the preview too. A Dip to Black
  keeps `D/2` (half frames included) on each side, as the preview did.
- **Audio crossfade:** measure it; fix only if it clearly differs. Measured: the same law (see below); only the
  odd-length window changed, with the dissolve's.

---

## Resolution

| Field | Value |
|---|---|
| Closed by / date | agent claude/fix-transitions, 2026-10-08 |
| Fix | branch `claude/fix-transitions` (from `claude/fix-fade-to-black` 94bb18e) |
| Files changed | `src/playback/planner.ts`, `src/playback/sequencePlayer.ts` (paint only), `shared/exportPlan.ts`, `electron/export/renderGraph.ts`; tests `tests/unit/export-fade.test.ts`, `tests/unit/program-dissolve.test.ts` (new), `tests/unit/playback.test.ts`, `tests/unit/export.test.ts`, `tests/unit/export-warnings.test.ts`, `tests/e2e/program-transitions.spec.ts` (new); `docs/export-pipeline.md`, `docs/LIMITATIONS.md` |
| Regression test | `tests/unit/export-fade.test.ts` › "two-sided transitions: export matches the preview per frame" (9 tests) and "audio crossfade: the export's gain law is the preview's"; `tests/unit/program-dissolve.test.ts`; `tests/e2e/program-transitions.spec.ts` |

### Root cause
The two renderers implemented different transitions. The export joined two segments with `xfade` (`fadeblack` for a
dip, `fade` for a dissolve) over `2⌊D/2⌋` frames of handles; the preview's planner gave each clip a weight and the
compositor drew every layer at its alpha over the one below. For a dip the planner was the intended picture and
`fadeblack` is not it; for a dissolve the export's mix was intended and alpha over alpha is not it. They also
disagreed on odd lengths, and the export's straight-alpha `xfade` is not a mix of two pictures where alphas differ.

### Fix
- **Preview, dissolve** (`planner.ts`, `sequencePlayer.ts`): the planner spans a dissolve over `2h = 2⌊D/2⌋` frames,
  `t = k/2h`, and marks the incoming layer with `mixWith` (the outgoing clip's id; `mixesWith(prev, next)` tells the
  compositor). `paint` draws such a pair into a scratch canvas (`OffscreenCanvas`, made on first use): the outgoing
  layer at its alpha, the incoming one with `globalCompositeOperation = 'lighter'` (a premultiplied add), then the
  sum over the canvas. Alphas `(1 − t)·a` and `t·b` give `(1 − t)·(out over below) + t·(in over below)`. Only frames
  with a dissolve on screen use the scratch canvas; every other draw is unchanged (`drawLayer` is the old loop body).
  Without a scratch canvas the pair is drawn as before. The paused-draw logic is not touched.
- **Export, dip** (`exportPlan.ts`, `renderGraph.ts`): `planTrackSegments` no longer gives a dip handles; it sets the
  outgoing segment's `dipOut` and the incoming one's `dipIn` to `D/2`, and the planner's weights go on the alpha: a
  half of a whole number of frames `H` is `fade=t=in|out:start_frame:nb_frames=H:alpha=1` (`dipFilters`; counting
  frames it gives exactly `k/H`, touches only the ramp's frames and is two short filters); a half-frame half (odd
  `D`) goes through `fadeWeights` into the fade fix's per-frame alpha `lut` + `sendcmd` (`fade`'s time options
  mishandle half frames: a ramp starting at a half frame was not applied at all on FFmpeg 6.1). A dip always renders
  in full (`TransitionOutcome.to = D`, no "shortened / dropped" warning for handles). Its segments still open their
  inputs over the handles a centred transition would take (`readBefore` / `readAfter`, not shown), so a clip and its
  linked audio crossfading on the same cut keep sharing one input: without that, the perf bench's 2,500-clip export
  opened 1,376 inputs instead of 1,258.
- **Export, dissolve** (`renderGraph.ts` `videoTrack`, `dissolveWindow`, `windowAlpha`): no more `xfade` chained over
  whole segments. A segment with a dissolve at an edge is `split` and `trim`med into its head window, body and tail
  window; each pair of windows is mixed and the track is one `concat` of bodies, mixes and gaps. The mix is
  premultiplied (`format=yuva444p16le,premultiply=inplace=1` → `xfade=fade:offset=0` →
  `unpremultiply=inplace=1,format=yuva420p`) unless both windows provably have the same alpha (`windowAlpha`: no
  alpha in the source, no motion, the same static opacity, no ramp over the window, the same coverage; the usual
  full-frame clips at opacity 1), where a plain `xfade` is already the same mix. A track without dissolves builds the
  graph it built before (no `split`, `premultiply` or `xfade`).

### Before / after
Largest |export − preview| mean luma (levels of 219), per case of `tests/unit/export-fade.test.ts` (FFmpeg 6.1.1,
320×180 at 24 fps, lossless x264). "Before" is 94bb18e with the same tests (the old compositor: every layer over the
one below).

| Case | Before | After |
|---|---|---|
| the reported case: Dip to Black, Cross Dissolve, 6 frames | 146.0 | 0.83 |
| Cross Dissolve of 1–8 frames | 54.3 | 0.88 |
| Dip to Black of 1–8 and 12 frames | 146.0 | 1.20 |
| Dip to Black where the media has no handles | dropped (hard cut) | 0.40 |
| on V2 over V1: opacity 0.6 → a pillarboxed 4:3 clip, then a dip; centre / pillar | 81.3 / 113.0 | 0.40 / 0.40 |
| keyframed and static opacity, dissolve and dip | 52.6 | 0.49 |
| nested: dissolve and dip inside, dissolve and dip at the nested clip's edges | 70.4 | 1.20 |
| chunked export (dissolves and dips, several chunks) / In/Out starting inside a dissolve | 118.5 / 70.4 | 1.20 / 1.20 |

The remaining error is the 8-bit rounding of the alpha `lut`, plus 4:2:0 / x264 rounding (the export reads about 1
level low). The same numbers come out on FFmpeg 6.1.1 and on the CI build (BtbN n9.0.2, `scripts/linux/get-ffmpeg.sh`).

**FFmpeg 9 (CI run #160):** the premultiplied mix first ran in 8 bits and failed the nested case on CI (frame 41:
197.0 vs 198.67). FFmpeg 9's 8-bit `premultiply` is not the identity at alpha 255 (luma 235 → 234, 6.1 keeps 235)
and `unpremultiply` does not restore it, so opaque pixels of a premultiplied window came back a level dark. The mix
now runs in `yuva444p16le`, whose round trip returns the 8-bit values exactly on both versions (and lowered the V2
case from 1.35 to 0.40).

The Program monitor itself, in Electron (`tests/e2e/program-transitions.spec.ts`, flat stills, canvas RGB): white →
gray dissolve at the cut 192.0 (expected 191.5; drawn one over the other it would be 127.8), at a quarter 223.0
(223.3); dip 64.0 / 0.0 / 32.0 (64 / 0 / 32); on V2 at opacity 0.6 into a half-size dark still over gray V1: centre
134.0 (134.1; one over the other: 115.1), corner 166.0 (166.1).

**Audio crossfade** (`acrossfade c1=tri:c2=tri` against the planner's gains; tone → silence over 12 frames,
silence → tone over 7): the same linear law, gains `1 − t` and `t` summing to 1. At the first sample of each frame
the export's gain equals the preview's within 0.005; within a frame the export ramps per sample where the preview
holds the frame's gain (Web Audio `setTargetAtTime`, 10 ms), so the per-frame RMS is up to one step (`1/2h`) apart.
Before, only an odd length differed: on the 7-frame crossfade the preview's gain was 0.929 on frame 51 where the
export was already at 1.0. Nothing else changed for audio.

### Regression test proof
On 94bb18e (an archive of that commit with the new test file copied in and `mixesWith` stubbed to `false`, i.e. the
old compositor):
```
× the reported case: a Dip to Black and a Cross Dissolve of 6 frames
× Cross Dissolve of 1 to 8 frames (an odd length renders one frame less, in both)
× Dip to Black of 1 to 8 and 12 frames
× Dip to Black needs no source handles: it renders in full where a dissolve would be dropped
× on V2 over V1: opacity and a pillarboxed picture mix over the track below
× with keyframed and static opacity
× inside a nested sequence, and at the nested clip's edges (ramps, #73)
× in a chunked export, and an In/Out range that starts inside a dissolve
× the graph: a dissolve mixes premultiplied pictures over its window only; no fadeblack; nothing extra without one
× linear (1 − t, t) on both sides; at the start of every frame the export's gain is the preview's
Tests  10 failed | 7 passed (17)
```
After: `✓ tests/unit/export-fade.test.ts (17 tests)`.

### Performance
Same-host A/B against 94bb18e (Linux container shared with other agents, so wall times are noisy):
- 1080p export, 20 clips of 3 s, a 24-frame transition at every cut (libx264 veryfast), interleaved runs: no
  transitions 19.85 / 19.85 s (old / new); Cross Dissolve, full-frame clips (plain `xfade`) 31.61 / 31.65 s; Dip to
  Black 36.10 / 24.83 s (no `xfade`, no 4:4:4). A dissolve whose windows' alphas differ takes the premultiplied
  path; with it on every cut the export took about 40 % longer (36.9 / 50.3 s, measured before `windowAlpha` sent
  equal alphas to the plain `xfade`).
- Perf bench export rows (graph build and FFmpeg init of the 2,500-clip project), measured before the last two
  commits: FFmpeg inputs 1,258 / 1,258, peak RSS and init time within run-to-run noise; `buildRenderGraph` @ 1,000
  clips 6.4–7.5 / 7.5–9.9 ms (more chains per dissolve: split, three trims). Not re-run after `windowAlpha`, which
  removes chains. The full `npm run perf:check` was not run (about 1.5 h with the A/B, on a shared machine).
- Frames outside transitions get no new work: a track without dissolves has the old graph, and the preview uses the
  scratch canvas only while a dissolve is on screen.

### Tests run
Linux, FFmpeg 6.1.1, at b164c79: `npm run typecheck` clean; `npm test` 111 files, 1929 passed, 2 skipped; e2e under
xvfb (`export`, `export-intermediates`, `export-mkv`, `keyframes`, `nest`, `program`, `program-transitions` (new),
`timeline`): 24/24 passed. Windows and macOS were not run. After the 16-bit change: `tests/unit/export-fade.test.ts`
18/18 on FFmpeg 6.1.1 and on the CI build n9.0.2, `export.test.ts` "(c) cross dissolve" passed; the full suites were
not re-run then (a perf comparison held the machine).

### Changed existing assertions
- `tests/unit/export.test.ts` "(c) a cross dissolve mixes both clips at the cut": asserted the old graph string
  `xfade=transition=fade:duration=0.5:offset=1.75`; now the two 12-frame window trims and the premultiplied `xfade`
  with `offset=0`. Its picture checks are unchanged.
- `tests/unit/export-warnings.test.ts` "random sequences: the checklist predicts every transition": read every
  rendered transition's length from `xfade` durations; a dip has no `xfade` now, so dips are checked separately
  (always `to = D`, no reason).
- `tests/unit/playback.test.ts` "contributionsAt index (P-08)": its linear-scan reference spanned a dissolve over
  `D/2` on each side; now `⌊D/2⌋`, the new window.

### Compatibility risks
Exports change: every two-sided Dip to Black (now the preview's linear halves, at video black, never shortened or
dropped for lack of handles) and Cross Dissolves where the clips' alphas differ (now the mix of the two pictures over
the tracks below). The preview changes for every Cross Dissolve (no dip in brightness mid-way) and for odd-length
dissolves and audio crossfades (one frame shorter). Project files are unchanged. The Export dialog no longer warns
about dips for handles. The export graph has more chains per dissolve (split, three trims, the mix); a track without
dissolves gets the same graph as before.

### Follow-ups
- A Cross Dissolve at a nested clip's edge stays two alpha ramps on different tracks (shared/nest.ts envelopes), so
  it still dims mid-way, identically in the preview and the export (measured above); documented in LIMITATIONS.
  Mixing it would need the nested side composited as one picture in both renderers.
- The preview does not shorten a Cross Dissolve that the media has no handles for (the export does, and warns); it
  holds the clip's first or last frame. Documented in LIMITATIONS.
- `docs/USER-GUIDE.md` §9 says transitions use handles and are shortened without them; a Dip to Black no longer
  does. `docs/ARCHITECTURE.md` (the playback data flow, "Centred transitions") still describes `xfade` over extended
  segments and drawing bottom to top. Not changed here (outside this task's files).
