# Negative container start: video.startTime is off by the negative start (thumbnails a frame early, first frame hidden)

| Field | Value |
|---|---|
| Status | open |
| Severity | medium (thumbnails / filmstrips one frame early, and a black first frame in the export of a clip that starts at the media's first frame, on a common kind of file; a workaround is to trim one frame) |
| Area | media/FFmpeg (electron/media/probe.ts streamStartOffset), thumbnails, export |
| Reported by / date | Claude (agent), found while fixing [2026-10-09-ts-late-video-export-early](../closed/2026-10-09-ts-late-video-export-early.md), 2026-10-09 |
| Found on commit | 0cf4266 plus the fix branch `claude/fix-ts-export-start-offset` (not changed by it) |
| Environment | Ubuntu 24.04.4 LTS container, FFmpeg 6.1.1-3ubuntu5, source checkout |

## Report

### Summary
An MKV made by FFmpeg with AAC (or Opus) audio has a negative container start: the audio priming starts at
-0.021 s, the video at 0. `probeMedia` clamps the container start to 0 (`MediaProbe.startTime = 0`, so source time t
is file time t, as Chromium plays it), but measures `video.startTime` from the unclamped start: 0 - (-0.021) =
0.021 s. Code that places the video with `video.startTime` then puts it 21 ms late.

### Steps to reproduce
1. ```
   G="(bitor(N,floor(N/2))-bitand(N,floor(N/2)))"
   ffmpeg -f lavfi -i "nullsrc=s=384x128:r=24,trim=end_frame=300,geq=lum='if(lt(Y,H/2),if(bitand($G,pow(2,floor(X*12/W))),235,16),128)':cb=128:cr=128" \
     -f lavfi -i sine=f=440:r=48000:d=12 -map 0:v -map 1:a -c:v libx264 -preset veryfast -crf 8 -g 12 -pix_fmt yuv420p -c:a aac neg24.mkv
   ffprobe -v error -show_entries format=start_time -of csv=p=0 neg24.mkv   # -0.021000
   ```
2. `probeMedia('neg24.mkv')`: `startTime: 0`, `video.startTime: 0.021`.
3. `getThumbnail({ path, time: (k + 0.5) / 24 })` for k = 10, 48, 101 and decode the gray code.
4. Export a video-only clip of that file from source 0 (5 frames, 24 fps) and look at the first frame.

### Expected
Thumbnails show frames 10, 48, 101: source time t is file time t (Chromium presents frame N of this file at media
time N / 24, `requestVideoFrameCallback` mediaTime: frame 48 at 2.0, 108 at 4.5, 204 at 8.5). The export's first
frame is frame 0.

### Actual
Thumbnails show frames 9, 47, 100. The export's first frame is black (mean luma 0); frames 1-4 are right.

### Evidence
`thumbs.ts` `frameGrid` takes the grid start from `video.startTime` (0.021), so `frameSeekTime` seeks a quarter frame
before the previous frame. `renderGraph.ts` `videoSegment` hides output frames before `video.startTime` (M-04
`lut=a=0:enable='lt(t,…)'`), which for in-point 0 covers the first frame.

### Suspected cause (hypothesis)
`streamStartOffset` (electron/media/probe.ts) subtracts `format.start_time` as is; it should measure from the clamped
start (`max(0, format.start_time)`), the zero `MediaProbe.startTime` and the preview use. Stored probes would need a
repair (shared/project.ts) or a re-probe.

### Scope
Every reader of `VideoStreamInfo.startTime`: thumbnails (`frameGrid`), the export's late-video hiding
(`videoStreamStart`), anything that shows the video's start offset.
