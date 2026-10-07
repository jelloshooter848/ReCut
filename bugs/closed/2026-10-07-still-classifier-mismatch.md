# Main and renderer disagree on which files are stills (TGA/EXR/PSD/JXL become zero-length videos, AVIF a playable video)

| Field | Value |
|---|---|
| Status | fixed |
| Severity | medium (TGA, EXR, PSD, JPEG XL, DPX and AVIF stills cannot be previewed or inserted as stills; workaround: convert to PNG) |
| Area | media/FFmpeg · playback |
| Reported by / date | stills agent (Roadmap §2 B), 2026-10-07 |
| Found on commit | 6b59577 (origin/main) |
| Environment | Ubuntu 24.04, Linux 6.18, FFmpeg 6.1.1-3ubuntu5, source (vitest) |

## Report

### Summary
Two classifiers decide whether a file is a still: `classifyKind` (electron/media/probe.ts, used by the attack
helpers) and `kindFromProbe` (src/state/store.ts, which sets `MediaItem.kind` in the app). They disagree, and the
probe itself only marks image2 / `*_pipe` files as stills:
- TGA, EXR, PSD, JPEG XL, DPX (image2 / `*_pipe`, marked `still image`): the renderer says `video`, so the item is a
  zero-length video (not insertable as a still, Source monitor tries a `<video>`).
- AVIF (`mov` + `av1`, no duration): the probe marks it `browserPlayable: true` with no reason; the renderer says
  `video`, so the Program monitor tries a `<video>` that cannot play it; the export took the still path and failed
  (2026-10-07-still-export-loop-option-non-image2.md).
- GIF: main says `video` (duration > 0), the renderer says `image`, even for an animated GIF.

### Steps to reproduce
Regression test: `tests/unit/stills.test.ts` › "still classification (main and renderer agree)": ffprobe output as
FFmpeg 6.1 reports it for each format, through `probeFromFfprobe`, then both classifiers.

### Expected
Both classifiers return the same kind; every single picture (any image demuxer, or one frame without duration in an
image file such as AVIF / HEIC / a one-frame GIF) is a still with `browserPlayable: false`, reason `still image`.

### Actual
With origin/main's probe.ts and store.ts, 14 of the 20 classification tests fail, e.g.
```
a.tga -> image:   AssertionError: expected 'video' to be 'image'   (kindFromProbe)
a.avif -> image:  AssertionError: expected 'video' to be 'image'   (kindFromProbe)
one.gif -> image: AssertionError: expected 'video' to be 'image'   (classifyKind)
anim.gif -> video: AssertionError: expected 'image' to be 'video'  (kindFromProbe)
```
and the AVIF probe has `browserPlayable: true`.

### Evidence
Failing output above; ffprobe of the files in the attack scratch (`pattern.tga`: `image2`/`targa`; `pattern.avif`:
`mov,mp4,…`/`av1`, `nb_frames=1`, no duration; `one.gif`: `gif`, `nb_frames=1`, duration 0.04).

### Suspected cause (hypothesis)
`kindFromProbe` (store.ts:96-104) only knows png/jpg/gif/bmp/webp/tiff extensions and a short codec list;
`classifyKind` (probe.ts:327-338) excludes `.gif`; `probeFromFfprobe` only checks `isImageContainer`.

### Scope
Every still outside the png/jpg/gif/bmp/webp/tiff set, AVIF/HEIC/HEIF items, and GIFs.

---

## Verification

| Field | Value |
|---|---|
| Verified by / date | stills agent, 2026-10-07 |
| Verified on commit | 6b59577 |
| Verdict | confirmed |

Reproduced with the unit test above on origin/main's probe.ts + store.ts (14 failed, 6 passed).

---

## Resolution

| Field | Value |
|---|---|
| Closed by / date | stills agent, 2026-10-07 |
| Fix | branch `claude/s2-stills` |
| Files changed | electron/media/probe.ts, src/state/store.ts, src/playback/mediaSource.ts |
| Regression test | tests/unit/stills.test.ts › still classification (main and renderer agree) |

### Root cause
Two hand-kept lists with different contents, and still detection by container only.

### Fix
- probe.ts: `isStillSource` marks a still when the demuxer is an image demuxer, or (no audio) the file is a single
  picture (`nb_frames` 1, or no duration) with an image extension or (no duration) an image codec. A still gets
  duration 0, `browserPlayable: false`, reason `still image`. `IMAGE_EXT` adds apng, jpe, jfif, heif, tga, exr, psd,
  dpx, sgi, pcx, ppm/pgm/pbm/pam, qoi, hdr, jp2/j2k.
- `classifyKind` and `kindFromProbe` use the same rule: the `still image` mark or an image demuxer means image; a
  probe without the mark (saved by an older version) is a still when it has a picture, no duration and no audio, from
  an image extension or codec. The extension lists are equal (`IMAGE_EXT` = `STILL_IMAGE_EXTS`, asserted by a test).
- An animated GIF (several frames, a duration) is a video: it gets an mp4 proxy and exports its frames.
- mediaSource.ts `isStillImage` also accepts an older AVIF probe (picture, no duration, image extension), so it
  asks for its PNG proxy instead of trying a `<video>`.

### Before / after
Before: TGA → kind `video`, AVIF → kind `video` + browser-playable, GIF → main `video` / renderer `image`. After: all
stills are `image` in both, AVIF is not browser-playable, an animated GIF is `video` in both.

### Regression test proof
origin/main probe.ts + store.ts: `Tests 14 failed | 6 passed | 10 skipped`. Fixed: 31/31 in stills.test.ts.

### Tests run
- `npm run typecheck`: clean. `npm test`: 62 files, 1181/1181 passed.
- Attack (`ATTACK_SCRATCH=…/s2b/attack npx vitest run -c tests/attack/vitest.config.ts`): codecs, proxy, exportgraph,
  stills: 43/43 passed (HEIC cases skip on FFmpeg 6.1: no HEIF demuxer).
- Attack-QA `tests/attack-qa/media-proxy-export.spec.ts`: 10/10. E2E program, source, project, stills: 22/22.

### Changed existing assertions
- tests/unit/playback.test.ts: "an image Chromium cannot show reports a conversion hint" became "…needs a PNG proxy, and
  draws it once ready": the old assertion encoded the missing preview.
- tests/attack/proxy.test.ts and tests/attack-qa/media-proxy-export.spec.ts expected a proxy job for an image to fail
  ("neither video nor audio"); it now writes the PNG still proxy, and the tests assert that.
(tests/unit/store.test.ts' hand-made `png_pipe` probe with duration 0.04 still classifies as image: an image
demuxer is a still in both classifiers.)

### Compatibility risks
Saved projects keep their stored `kind` and probe until the media is re-probed (relink). An AVIF saved as kind `video`
is treated as a still by the monitors (`isStillImage` fallback: "needs proxy", then its PNG), but its source length
in the Source monitor / insert comes from the stored kind (0 s) until it is re-probed. Animated GIFs imported from now on are videos with the GIF's duration instead of endless stills.

### Follow-ups
src/state/parseIdentity.ts `IMAGE_EXTS` (import dialog filter, default bin) still lists only png/jpg/jpeg/gif/webp/
bmp/tif/tiff: the new formats import through "All files" and land in no bin. Not owned by this change; reported.
