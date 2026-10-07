# Scene detection rounds cut times past 10,000 s to 6 significant digits

| Field | Value |
|---|---|
| Status | open |
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
| Verified by / date | |
| Verified on commit | |
| Verdict | |

---

## Resolution

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
