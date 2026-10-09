# MPEG-TS thumbnails show the next keyframe instead of the frame at the time (long GOP)

| Field | Value |
|---|---|
| Status | open |
| Severity | low (thumbnails and filmstrip frames of a TS source are up to one GOP late; the preview and the export are right) |
| Area | media/FFmpeg (electron/media/thumbs.ts extractOne / extractBatch) |
| Reported by / date | Claude (agent), found while fixing [2026-10-09-ts-late-video-export-early](../closed/2026-10-09-ts-late-video-export-early.md), 2026-10-09 |
| Found on commit | 0cf4266, and the fix branch `claude/fix-ts-export-start-offset` (`-copyts` does not change it) |
| Environment | Ubuntu 24.04.4 LTS container, FFmpeg 6.1.1-3ubuntu5, source checkout |

## Report

### Summary
Thumbnails seek with `-ss T -i file` and take the first decoded frame, with no pre-roll. On an MPEG-TS with an
H.264 GOP of 25 frames (1 s), FFmpeg's input seek lands after the target and the decoder starts at the next IDR
frame, so the thumbnail is that keyframe. An all-intra TS gives the right frame, so the seek, not the timestamps, is
the problem. The export is not affected (it keeps 1 s of pre-roll for non-exact containers, renderGraph.ts
`inputPreroll`).

### Steps to reproduce
1. ```
   G="(bitor(N,floor(N/2))-bitand(N,floor(N/2)))"
   ffmpeg -f lavfi -i "nullsrc=s=320x240:r=25,trim=end_frame=250,geq=lum='if(lt(Y,H/2),if(bitand($G,pow(2,floor(X*12/W))),235,16),128)':cb=128:cr=128" \
     -f lavfi -i sine=frequency=440:sample_rate=48000:duration=10.5 -map 0:v -map 1:a \
     -c:v libx264 -bf 0 -g 25 -pix_fmt yuv420p -c:a aac -f mpegts g0.ts
   ```
   (video starts 0.021 s after the container start; keyframes every 25 frames)
2. `getThumbnail({ path: 'g0.ts', time: t, width: 192 })` for t = 2.3, 2.95, 5.5 and decode the gray code.

### Expected
Frames 56, 73, 136 (the frames covering those times).

### Actual
Frames 75, 75, 150 (the next keyframes).

### Suspected cause (hypothesis)
MPEG-TS input seeking is not keyframe-exact. A pre-roll for non-exact containers (seek earlier, then drop frames up to
the time, as the export does) would fix it, at some cost per thumbnail.

### Scope
`extractOne`, `extractBatch` (filmstrips). Possibly MPEG-PS (`.mpg`, `.vob`) too.
