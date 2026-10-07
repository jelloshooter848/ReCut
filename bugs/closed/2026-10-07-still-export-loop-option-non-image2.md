# Export fails for AVIF and single-frame GIF stills ("Option loop not found")

| Field | Value |
|---|---|
| Status | fixed |
| Severity | high (the whole export fails as soon as one such still is on the timeline; workaround: convert the image) |
| Area | export · media/FFmpeg |
| Reported by / date | stills agent (Roadmap §2 B), 2026-10-07 |
| Found on commit | 6b59577 (origin/main) |
| Environment | Ubuntu 24.04, Linux 6.18, FFmpeg 6.1.1-3ubuntu5, source (vitest attack suite) |

## Report

### Summary
`addInput` (electron/export/renderGraph.ts) opens every still with `-loop 1 -framerate <fps> -t <len> -i <file>`.
`-loop` is an option of the image2 demuxer family (`image2`, `*_pipe`) only. A still that FFmpeg demuxes with another
demuxer makes ffmpeg refuse the input, so the export fails: AVIF (and HEIC on FFmpeg 7+) demux as `mov`, a GIF as
`gif`. Every user with an AVIF or GIF on the timeline loses the export.

### Steps to reproduce
Regression tests: `tests/attack/stills.test.ts` › "still export matches the preview proxy" (a sequence with TIFF,
TGA, JPEG XL, AVIF, EXR, PSD and DPX stills) and "a one-frame GIF (gif demuxer, no -loop option) exports as a still".

By hand:
```
ffmpeg -f lavfi -i testsrc2=size=320x240:rate=1 -frames:v 1 x.avif
ffmpeg -v error -loop 1 -framerate 24 -t 1 -i x.avif -f null -
```
The same for a `.gif`. TIFF, TGA, EXR, PSD, DPX, JPEG XL, PNG, JPEG, WebP, BMP (image2 / `*_pipe`) accept `-loop`.

### Expected
The still is held for the clip's length in the export, like a PNG.

### Actual
```
Error: ffmpeg exited with code 8:
Option loop not found.
Error opening input file file:/…/stills/pattern.avif.
Error opening input files: Option not found
```
and the same for `one.gif`.

### Evidence
Test output above (the stills attack test with the old `renderGraph.ts`).

### Suspected cause (hypothesis)
`renderGraph.ts:443-445` (addInput) applies `-loop 1` whatever the demuxer.

### Scope
Every still whose probe container is not `image2` / `*_pipe`: AVIF, single-frame GIF (in the app a GIF was always
kind `image`, see 2026-10-07-still-classifier-mismatch.md), HEIC/HEIF on FFmpeg 7+.

---

## Verification

| Field | Value |
|---|---|
| Verified by / date | stills agent, 2026-10-07 |
| Verified on commit | 6b59577 |
| Verdict | confirmed |

The probe of an AVIF reports `format_name=mov,mp4,m4a,3gp,3g2,mj2`, of a GIF `gif`; `ffmpeg -loop 1 -i` fails with
"Option loop not found" for both, and succeeds for bmp/dpx/exr/hdr/jp2/jpg/jxl/pcx/png/ppm/qoi/sgi/tga/tiff/webp.
In the app the AVIF was kind `video` (renderer classifier) but `isImageMedia` treats a picture with duration 0 and no
audio as a still, so it took the same `-loop` path.

---

## Resolution

| Field | Value |
|---|---|
| Closed by / date | stills agent, 2026-10-07 |
| Fix | branch `claude/s2-stills` |
| Files changed | electron/export/renderGraph.ts |
| Regression test | tests/attack/stills.test.ts › still export matches the preview proxy (both tests) |

### Root cause
`-loop` is a private option of the image2 demuxer, passed to whatever demuxer opens the file.

### Fix
`loopableStill(m)`: a still keeps the `-loop 1 -framerate -t` input when its probed container is `image2` or `*_pipe`
(or unknown); any other still opens with a plain `-i <file>`, decodes its one picture, and the segment's existing
`tpad=stop=<frames>:stop_mode=clone` holds it for the clip's length (the image chain already ends in tpad + trim).
The smallest change: the tested image2 path is untouched, and no intermediate file is needed.

### Before / after
Before: export fails (ffmpeg exit 8). After: the sequence exports with the exact frame count (6 per still), and every
clip matches the PNG preview proxy of the same file: mean |export − proxy| per channel tiff 0.40, tga 1.67, jxl 0.39,
avif 0.39, exr 0.56, psd 0.40, dpx 0.40 (0–255). The one-frame GIF exports 12 frames with the right colours.

### Regression test proof
Old renderGraph: `2 failed` (`Option loop not found` for pattern.avif and one.gif). New: `9 passed`.

### Tests run
`npm test`, `npm run typecheck`, attack: `tests/attack/stills.test.ts` 9/9, `exportgraph`, `codecs`, `proxy` (see
the branch report).

### Changed existing assertions
None.

### Compatibility risks
None for image2-family stills (unchanged args). AVIF / GIF exports that used to fail now succeed.

### Follow-ups
An animated GIF is now a video (2026-10-07-still-classifier-mismatch.md); an animated WebP is still a still (FFmpeg
6.1 cannot decode animated WebP).
