# Scene detection rounds cut times past 10,000 s to 6 significant digits

| Field | Value |
|---|---|
| Status | fixed |
| Severity | medium (detected cuts land 1 to 3 frames off on media longer than 2 h 46 min, and are garbage beyond 1,000,000 s; the cuts can be moved by hand) |
| Area | media/FFmpeg |
| Reported by / date | Claude, OCR extraction work, 2026-10-07 |
| Found on commit | a515bb1 (origin/main) |
| Environment | Ubuntu 24.04, Linux 6.18, FFmpeg 6.1.1-3ubuntu5, source |

## Report

### Summary
`electron/media/sceneDetect.ts` takes each cut time from showinfo's `pts_time` text. FFmpeg 6.1 prints `pts_time`
with 6 significant digits, so from 10,000 s on the time is rounded to 0.1 s (up to 3 frames at 60 fps, 1 frame at
24/25/30 fps), from 100,000 s to whole seconds, and from 1,000,000 s it is printed in exponent form
(`4.32e+06`), which `parseShowinfoPts` reads as 4.32 s. Users splitting long sources (concerts, extended cuts,
stream VODs) get scene cuts on the wrong frame past 2:46:40.

### Steps to reproduce
1. Make a clip whose scene cut is far into the timeline without hours of video: 1 s red, then blue frames whose
   timestamps are shifted so the first blue frame is frame 296281 at 24 fps (12345.041667 s):
   ```
   ffmpeg -f lavfi -i color=c=red:size=64x64:rate=24:duration=1 -f lavfi -i color=c=blue:size=64x64:rate=24:duration=1 \
     -filter_complex "[0:v][1:v]concat=n=2:v=1:a=0,setpts='if(lt(N,24),N,N+296281-24)/(24*TB)'[v]" \
     -map '[v]' -fps_mode passthrough -c:v libx264 -preset ultrafast -pix_fmt yuv420p late24.mp4
   ```
2. Run the scene-detect command line from `runSceneDetect`:
   `ffmpeg -i late24.mp4 -map 0:v:0 -an -sn -dn -vf "scale=320:-2,select='gt(scene,0.3)',showinfo" -fps_mode passthrough -f null -`
3. Or run scene detection on the clip in the app / through `startSceneDetectJob`.

### Expected
One boundary at 12345.041667 s (frame 296281 at 24 fps).

### Actual
showinfo (FFmpeg 6.1.1), with the true cut time on the left:

| Clip | True cut | showinfo line | Boundary | Error |
|---|---|---|---|---|
| mp4, 24 fps, frame 296281 | 12345.041667 | `n:   0 pts:151695872 pts_time:12345` | 12345 | 1 frame early |
| mp4, 30 fps, frame 370354 | 12345.133333 | `n:   0 pts:189621248 pts_time:12345.1` | 12345.1 | 1 frame early |
| mp4, 60 fps, frame 740703 | 12345.05 | `n:   0 pts:189619968 pts_time:12345` | 12345 | 3 frames early |
| mkv, 25 fps, frame 308627 | 12345.08 | `n:   0 pts:12345080 pts_time:12345.1` | 12345.1 | 0.5 frame (rounds right) |
| mkv, 24 fps, frame 2962812 | 123450.5 | `n:   0 pts:123450500 pts_time:123450` | 123450 | 12 frames early |
| mkv, 24 fps, frame 103680012 | 4320000.5 | `n:   0 pts:4320000500 pts_time:4.32e+06` | 4.32 | parsed as 4.32 s |

(The last two need `-dts_error_threshold 1e9` on the input: the ffmpeg CLI treats a demuxed timestamp jump larger
than 108,000 s as an error, so the synthetic gap is rewritten. A continuous file of that length has no jump.)

### Evidence
The integer `pts` field in the same lines is exact (stream time base); with `settb=AVTB` before showinfo it is
microseconds: `pts:12345041667 pts_time:12345`, `pts:4320000500000 pts_time:4.32e+06`.

### Suspected cause (hypothesis)
`parseShowinfoPts` (`electron/media/sceneDetect.ts`) parses `pts_time:`, which FFmpeg 6.1 formats with
`av_ts2timestr` (`%.6g`). Its regex `-?\d+(?:\.\d+)?` also stops at the `e+06` exponent.

### Scope
Only scene detection parses showinfo in main. The OCR extraction branch (`electron/ocr/bitmapEvents.ts` on
`claude/ocr-integration`) already uses `settb=AVTB` and the integer `pts`.

---

## Verification

| Field | Value |
|---|---|
| Verified by / date | Claude, 2026-10-07 |
| Verified on commit | a515bb1 (origin/main) |
| Verdict | confirmed |

Reproduced with the clips in the Report (FFmpeg 6.1.1-3ubuntu5): the current filter chain prints `pts_time:12345`
for a cut at 12345.041667 s (24 fps) and `pts_time:12345` for 12345.05 s (60 fps), and `startSceneDetectJob` returns
those rounded values (see the failing test output below). The suspected cause is right. At 1,000–9,999 s the
resolution is 0.01 s, under half a frame up to 50 fps, so the effect starts at 10,000 s.

---

## Resolution

| Field | Value |
|---|---|
| Closed by / date | Claude, 2026-10-07 |
| Fix | 9923ad4 (branch `claude/scene-pts-precision`) |
| Files changed | `electron/media/sceneDetect.ts`, `tests/unit/sceneDetect.test.ts` (new), `tests/unit/media.test.ts` (one assertion) |
| Regression test | `tests/unit/sceneDetect.test.ts` › "scene detection past 10,000 s" › "finds the cut at frame 296281 (24 fps) on the right frame" / "… 740703 (60 fps) …"; "parseShowinfoPts" › "reads the integer pts in AV_TIME_BASE units, not the 6-digit pts_time" |

### Root cause
Boundaries were parsed from showinfo's `pts_time`, a display string FFmpeg 6.1 formats with `%.6g`. Six
significant digits are not enough for frame accuracy past 10,000 s, and `%.6g` switches to exponent form at 1e6,
which the regex cut at the `e`.

### Fix
`sceneFilter()` builds the chain `scale=320:-2,select='gt(scene,T)',settb=AVTB,showinfo`: `settb=AVTB` rescales the
selected frames' timestamps to 1/1000000 s, so showinfo's integer `pts:` field is microseconds. `parseShowinfoPts`
now reads that integer (`(?:^|\s)pts:\s*(-?\d+)\s+pts_time:`) and divides by the time base (default AV_TIME_BASE,
or an explicit `{ num, den }`); `pts:NOPTS`, config lines and progress lines give null. Cached results are written
with `version: SCENE_VERSION` (2) and a cache entry without that version is recomputed and overwritten at the same
path, so no stale rounded cuts are served and no orphan files are left. Same approach as `parseShowinfoFrame` on the
OCR branch, without depending on it.

### Before / after
| Clip | True cut | Before | After |
|---|---|---|---|
| 24 fps, frame 296281 | 12345.041667 | 12345 (frame 296280) | 12345.041667 (frame 296281) |
| 60 fps, frame 740703 | 12345.05 | 12345 (frame 740700) | 12345.05 (frame 740703) |
| 24 fps, frame 103680012 (showinfo line) | 4320000.5 | 4.32 | 4320000.5 |

Short media is unaffected beyond sub-millisecond differences (`media.test.ts` › "scene detection finds the cut"
still finds 3.0 s).

### Regression test proof
On a515bb1 (old `sceneDetect.ts`, the new test file without the tests that use the new exports):
```
 × parseShowinfoPts > reads the integer pts in AV_TIME_BASE units, not the 6-digit pts_time
   → expected 12345 to be 12345.041667 // Object.is equality
 × scene detection past 10,000 s > finds the cut at frame 296281 (24 fps) on the right frame
   → expected 0.04166666666606034 to be less than 0.001
 × scene detection past 10,000 s > finds the cut at frame 740703 (60 fps) on the right frame
   → expected 0.049999999999272404 to be less than 0.001
 Tests  3 failed | 1 passed | 3 skipped (7)
```
With the fix: `tests/unit/sceneDetect.test.ts` 7/7 passed.

### Tests run
`npm run typecheck`: clean. `npm test`: 70 files, 1303/1303 passed (FFmpeg 6.1.1-3ubuntu5). e2e not run (no UI
change; scene detection's e2e path in `tests/e2e/project.spec.ts` only waits for status `done`).

### Changed existing assertions
`tests/unit/media.test.ts` › "scene helpers": the line `pts:  73728 pts_time:3.00000` asserted 3 s by reading
`pts_time`. The parser now reads the integer pts (default time base 1/1000000), so the assertion passes that line's
time base `{ num: 1, den: 24576 }` explicitly; it still expects 3.

### Compatibility risks
- FFmpeg versions: `settb` and its `AVTB` constant exist in every supported release (6.1 tested; present unchanged
  in 7.x and 8.x sources). showinfo's `n: … pts:<int|NOPTS> pts_time:…` prefix is unchanged through 8.x. Only
  FFmpeg 6.1.1 was run here; a newer static build could not be downloaded in this environment.
- Cache: entries written before this fix (no `version`) are recomputed once per file and threshold.
- Projects: scenes already stored in a project (`media.detectedScenes`) are not recomputed; re-running scene
  detection on that media picks up the corrected times.

### Follow-ups
None.
