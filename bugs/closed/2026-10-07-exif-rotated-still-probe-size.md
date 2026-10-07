# An EXIF-rotated JPEG is probed with its stored (sideways) size

| Field | Value |
|---|---|
| Status | fixed |
| Severity | low (wrong size badge and 100% / 50% zoom in the Source monitor, wrong crop offset in the export, for rotated phone photos; the picture itself is upright everywhere) |
| Area | media/FFmpeg · export · UI |
| Reported by / date | stills agent (Roadmap §2 B), 2026-10-07 |
| Found on commit | 6b59577 (origin/main) |
| Environment | Ubuntu 24.04, Linux 6.18, FFmpeg 6.1.1-3ubuntu5, Electron 33.4.11, source |

## Report

### Summary
A JPEG with EXIF Orientation 6 or 8 (a phone photo taken upright) is drawn upright by Chromium (`<img>` applies EXIF
orientation) and by FFmpeg (the mjpeg decoder exports the orientation as a frame display matrix and the CLI
autorotates: export, thumbnails, still proxy). But ffprobe's stream size is the stored size and carries no rotation,
so the probe says 320×240 for a 240×320 picture. Users see a landscape size badge, the Source monitor's 100% / 50%
zoom draws the picture into a landscape box (object-fit: contain, so too small), and the export's crop offsets
(`transformFilters` → `fitInputSize`) use the wrong axes.

### Steps to reproduce
Regression tests: `tests/attack/stills.test.ts` › "a JPEG with Orientation=6 (rotate 90 CW) is upright everywhere"
(probe size), `tests/unit/stills.test.ts` › "a still whose first frame carries a display matrix…", e2e
`tests/e2e/stills.spec.ts` › "an EXIF-rotated JPEG…". The test JPEG gets its EXIF segment from
`tests/attack/stillfiles.ts` (`writeJpegWithOrientation`).

### Expected
The probe reports 240×320 (rotation recorded), like a rotated phone video.

### Actual
```
AssertionError: expected [ 320, 240 ] to deeply equal [ 240, 320 ]
```

### Evidence
`ffprobe -show_streams rot6.jpg`: width=320 height=240, no side data. `ffprobe -show_frames`: frame side data
`3x3 displaymatrix`, rotation=-90. `ffmpeg -i rot6.jpg out.png` writes 240×320 (with and without `-loop 1`).

### Suspected cause (hypothesis)
probe.ts reads rotation from stream side data / the `rotate` tag only; EXIF orientation is per frame.

### Scope
Stills only (videos carry the display matrix on the stream).

---

## Verification

| Field | Value |
|---|---|
| Verified by / date | stills agent, 2026-10-07 |
| Verified on commit | 6b59577 |
| Verdict | confirmed |

Preview (Chromium), export, thumbnail and still proxy are all upright and agree (attack + e2e tests); only the probed
size is wrong.

---

## Resolution

| Field | Value |
|---|---|
| Closed by / date | stills agent, 2026-10-07 |
| Fix | branch `claude/s2-stills` |
| Files changed | electron/media/probe.ts |
| Regression test | tests/attack/stills.test.ts › EXIF orientation…; tests/unit/stills.test.ts › a still whose first frame carries a display matrix… |

### Root cause
EXIF orientation is decoded per frame; the probe looked at the stream only.

### Fix
`probeMedia`: for a still with no stream rotation, one more ffprobe call reads the first frame's side data
(`-read_intervals %+#1 -show_entries frame_side_data=rotation`); `applyStillOrientation` records the quarter turn and
swaps the display axes (coded size kept). A failure of that call leaves the probe as before.

### Before / after
Before: probe 320×240 for the upright 240×320 picture. After: 240×320, rotation 270 (streamRotation's quarter turn,
as for rotated videos). Preview, export, thumbnail and proxy: upright before and after.

### Regression test proof
Without the fix: `1 failed` (`expected [ 320, 240 ] to deeply equal [ 240, 320 ]`). With it: 9/9 (attack), 31/31
(unit), 5/5 (e2e stills).

### Tests run
See the branch report.

### Changed existing assertions
None.

### Compatibility risks
One extra ffprobe per imported still (decodes one picture). Saved projects keep the old size until re-probed.

### Follow-ups
Not covered (FFmpeg-version dependent, document): HEIC/AVIF `irot`/`imir` rotation. FFmpeg 6.1 cannot demux HEIF at
all and ignores AVIF `irot`; Chromium applies it, so AVIF is previewed through the PNG proxy
(2026-10-07-avif-preview-orientation-differs-from-export.md): preview and export agree, both unrotated on 6.1.
EXIF orientation inside PNG / WebP (drawn directly by Chromium) was not tested against FFmpeg.
