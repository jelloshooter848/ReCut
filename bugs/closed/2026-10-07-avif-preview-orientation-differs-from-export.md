# A rotated AVIF (irot) drawn directly by Chromium previews rotated but exports unrotated

| Field | Value |
|---|---|
| Status | fixed |
| Severity | low (rotated AVIF stills only; the preview shows a different picture orientation from the export) |
| Area | playback · media/FFmpeg |
| Reported by / date | stills agent (Roadmap §2 B), 2026-10-07 |
| Found on commit | branch `claude/s2-stills` at 9d881e8 (AVIF had just been added to the directly drawn list; on 6b59577 AVIF did not preview at all) |
| Environment | Ubuntu 24.04, Linux 6.18, FFmpeg 6.1.1-3ubuntu5, Electron 33.4.11, source |

## Report

### Summary
Electron 33's Chromium decodes AVIF in an `<img>`, so the plan was to draw AVIF stills directly. Chromium applies the
AVIF `irot` (and `imir`) transform properties; FFmpeg 6.1's mov demuxer ignores them. A rotated AVIF would preview
rotated in the monitors and export unrotated.

### Steps to reproduce
1. Build a 320×240 AVIF with `irot` = 1 (90° counter-clockwise): `writeHeifFromMp4` in `tests/attack/stillfiles.ts`
   from `ffmpeg -i ref.png -frames:v 1 -c:v libaom-av1 -still-picture 1 x.mp4`.
2. Chromium (Electron 33, `new Image()` on the `recut-media://` URL): `naturalWidth × naturalHeight` = `240 × 320`.
3. FFmpeg 6.1: `ffmpeg -i rot.avif -frames:v 1 out.png` → `320 × 240`. ImageMagick (libheif 1.17.6): `240 × 320`.

### Expected
Preview and export show the same orientation.

### Actual
Preview 240×320 (Chromium), export 320×240 (FFmpeg 6.1).

### Evidence
Temporary Playwright check: `AVIF irot natural size in Chromium: [240,320]`; `ffprobe` of FFmpeg's decode:
`stream,320,240`.

### Suspected cause (hypothesis)
FFmpeg 6.1 parses HEIF/AVIF item properties only partly (no `irot`/`imir`); Chromium's AVIF decoder applies them.

### Scope
AVIF stills with `irot`/`imir`. HEIC is proxied anyway (Chromium cannot decode it). JPEG EXIF orientation agrees
(both apply it; see 2026-10-07-exif-rotated-still-probe-size.md).

---

## Verification

| Field | Value |
|---|---|
| Verified by / date | stills agent, 2026-10-07 |
| Verified on commit | 9d881e8 |
| Verdict | confirmed |

---

## Resolution

| Field | Value |
|---|---|
| Closed by / date | stills agent, 2026-10-07 |
| Fix | branch `claude/s2-stills` |
| Files changed | src/playback/mediaSource.ts (`DISPLAYABLE_IMAGE_EXTS` without `avif`) |
| Regression test | tests/attack/stills.test.ts › a rotated AVIF (irot): the preview proxy and the export come from the same FFmpeg decode; tests/unit/stills.test.ts › TIFF / TGA / EXR / PSD / JXL / HEIC / AVIF need a proxy; tests/e2e/stills.spec.ts › an AVIF is previewed through its PNG proxy |

### Root cause
Two decoders (Chromium for the preview, FFmpeg for the export) that disagree on AVIF transform properties.

### Fix
AVIF is previewed from the PNG still proxy like TIFF/HEIC: preview and export share FFmpeg's decode, whatever the
FFmpeg version does with `irot`. (`image/avif` stays in range.ts; harmless.)

### Before / after
Before (direct draw): preview 240×320, export 320×240. After: the proxy and the export are both 320×240 on FFmpeg 6.1
(both rotated on a build that applies `irot`); the attack test checks the export against the proxy either way.

### Regression test proof
The attack test logs `[avif irot] FFmpeg decodes 320x240 (ignores irot)` and checks the export against the proxy;
the unit test fails if `avif` is put back in the drawn list.

### Tests run
See the branch report.

### Changed existing assertions
None (the e2e AVIF test was written on this branch).

### Compatibility risks
AVIF stills now need a (cheap, automatic) PNG proxy on import; until it is built the monitors show "needs proxy".

### Follow-ups
FFmpeg ignoring `irot` means a rotated AVIF exports sideways on FFmpeg 6.1 (Linux CI); a newer FFmpeg is expected to
apply it (not verified here). Document under LIMITATIONS "Still images".
