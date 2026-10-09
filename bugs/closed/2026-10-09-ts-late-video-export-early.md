# MPEG-TS / MPEG-PS with late video: a video-only clip exports early by the video's start offset

| Field | Value |
|---|---|
| Status | fixed |
| Severity | high (wrong frames in the export, no warning; the preview shows the right ones) |
| Area | export (electron/export/renderGraph.ts addInput); also scene detection and channel proxies (media/FFmpeg) |
| Reported by / date | Claude (agent), found while scoping DVD / Blu-ray file import (Roadmap §20), 2026-10-09 |
| Found on commit | 0cf4266 (ReCut 0.8.1) |
| Environment | Ubuntu 24.04.4 LTS container, FFmpeg 6.1.1-3ubuntu5 (also 8.1.3-Jellyfin, the bundled build, and n9.0.2 BtbN), source checkout |

## Report

### Summary
In an MPEG-TS (`.ts`, `.m2ts`, `.mts`) or MPEG-PS (`.mpg`, `.vob`) file whose video stream starts after the
container start (the audio starts first, as in most broadcast and camcorder recordings), a clip whose video gets
its own FFmpeg input exports the wrong frames: it shows the picture from the video's start offset later in the
source, i.e. the picture arrives early by that offset. A video-only clip, or a video clip whose linked audio has a
different range, is affected. Linked picture + sound with the same range (one shared input) and the same streams
remuxed to MKV export the right frames.

### Steps to reproduce
1. Make a TS whose video starts 0.5 s after its audio, with the frame number burned in as a 12-bit gray code:
   ```
   G="(bitor(N,floor(N/2))-bitand(N,floor(N/2)))"
   ffmpeg -itsoffset 0.5 -f lavfi -i "nullsrc=s=192x64:r=25,trim=end_frame=300,geq=lum='if(lt(Y,H/2),if(bitand($G,pow(2,floor(X*12/W))),235,16),128)':cb=128:cr=128" \
     -f lavfi -i sine=frequency=440:sample_rate=48000:duration=12.5 -map 0:v -map 1:a \
     -c:v libx264 -preset veryfast -crf 8 -g 25 -pix_fmt yuv420p -c:a aac -ac 2 -f mpegts vlate.ts
   ffprobe -v error -show_entries format=start_time:stream=index,start_time -of compact vlate.ts
   # stream 0 (video) start_time=1.941333, stream 1 (audio) start_time=1.400000, format start_time=1.400000
   ```
2. Import it, put a video-only clip of source 2 s–3 s on a 25 fps timeline, export.
3. Or run `tests/unit/ts-start-offset.test.ts` on 0cf4266.

### Expected
The editor's frame choice: timeline frame n shows the media frame covering 2 + n/25 + 1/50 (container-relative),
with the video starting 0.541333 s after the container start: source frames 36..60. The MKV remux and a linked clip
of the same file give exactly that.

### Actual
Source frames 50..74: 14 frames (0.54 s) of the source later than the editor shows. At source 7.013 s: 175..199
instead of 162..186. The disc-scope run measured the same at 23.976 fps (frame 48 instead of 36 at 2 s, 120 instead
of 108 at 5 s) with `-itsoffset 0.5` video.

### Evidence
FFmpeg's input timestamp offset for the same file, `-copyts -start_at_zero`, by what the command maps (`-debug_ts`,
the `off_time` field of `demuxer+ffmpeg` lines):
```
-map 0:v              off_time:-1.94133    first video pts 0
-map 0:v -map 0:a     off_time:-1.4        first video pts 0.541333
(no -map)             off_time:-1.4
```
With `-copyts` alone the video pts are 1.941333 (absolute) for every mapping. FFmpeg 8.1.3 and 9.0.2 give the same.

### Suspected cause (hypothesis)
`-copyts -start_at_zero` (renderGraph.ts `addInput`) uses a zero that FFmpeg computes from the streams it actually
reads for MPEG-TS / MPEG-PS, so mapping only the video stream moves it to the video start.

### Scope
Every FFmpeg command that reads a TS / PS source through a subset of its streams and relies on FFmpeg's zero:
export inputs (video-only and audio-only), proxies, scene detection, channel proxies, thumbnails, OCR extraction,
Whisper audio extraction, waveform, the export's source end check.

---

## Verification

| Field | Value |
|---|---|
| Verified by / date | Claude (agent), 2026-10-09 |
| Verified on commit | 0cf4266 |
| Verdict | confirmed |

Reproduced with the commands above and with `tests/unit/ts-start-offset.test.ts` (the video-only TS export fails;
the linked TS clip, the MKV remux and a start-0 MP4 pass). The suspected cause is right, and the mechanism is
`correct_input_start_times()` in FFmpeg's `fftools/ffmpeg_opt.c` (6.1; `ffmpeg_demux.c` in later versions). It runs
after the output files are opened and, for input formats flagged `AVFMT_TS_DISCONT` (MPEG-TS, MPEG-PS, FLV), takes
the minimum start time of the streams that are **not discarded** (not mapped streams are discarded) as the file's
effective start. With `-copyts -start_at_zero` it sets the input's timestamp offset to minus that start; without
`-copyts` the offset becomes minus that start too (ignoring the container start); with `-copyts` alone the offset is
0 (absolute timestamps). Other formats keep `ic->start_time`, which is why the MKV remux was exact.

The same zero affects, on TS / PS sources:
- **audio-only export clips** of a stream that starts after the container start (late audio): the sound started at
  the in-point with no lead-in (onset 0.0001 s instead of 0.30 s in the test);
- **scene detection** (no `-copyts`, `-map 0:v:0`): cuts relative to the video start, 0.541333 s early;
- **thumbnails** (`-ss T -i`, no `-copyts`, `-map 0:v:0`): with the corrected zero FFmpeg's accurate-seek trim no
  longer drops the frame before the seek point, so the thumbnail is one frame early (frames 10, 42, 59, 122 instead of
  11, 43, 60, 123 at 1.0, 2.3, 2.95 and 5.5 s on an all-intra TS with late video). Any TS whose audio starts even
  slightly before its video (0.021 s in a plain FFmpeg-made TS) is affected: 55 instead of 56 at 2.3 s. The MKV remux
  gives the right frames;
- **channel proxies** (no `-copyts`, one audio stream mapped): a late stream lost its leading silence (onset 0.010 s
  instead of 0.50 s), so the preview played it early;
- **media proxies** (no `-copyts`, `-map 0:v:0` + the audio streams): right in the normal case (video and every
  audio stream mapped include the earliest stream); 0.3 s early (7 frames) for a fallback plan that maps only the
  audio stream starting 0.3 s after the first one. A subtitle or data stream that starts first would do the same.

Checked and not affected: OCR bitmap extraction (already `-copyts` minus the probed `format.start_time`), the source
end check (ffprobe packet times minus `MediaProbe.startTime`), the waveform (raw samples, lead from the probed stream
start), text subtitle extraction (text codecs do not occur in TS / PS; teletext and ARIB are refused), Whisper audio
extraction (no timestamps used, but see Follow-ups).

The preview: a TS is never played directly (Chromium cannot), so its preview is the media proxy, which is 0-based on
the container start; an original that Chromium plays is offset by `MediaProbe.startTime` (`mediaTimeOffset`). Both
are the zero the export now uses. On the late-video TS, the proxy at source 2 s + n/25 shows the same frames 36..60
as the fixed export.

---

## Resolution

| Field | Value |
|---|---|
| Closed by / date | Claude (agent), 2026-10-09 |
| Fix | branch `claude/fix-ts-export-start-offset`, the commit that moves this file to `bugs/closed/` |
| Files changed | electron/export/renderGraph.ts, electron/media/sceneDetect.ts, electron/media/thumbs.ts, electron/media/channelProxy.ts, electron/media/proxy.ts, shared/audioChannels.ts, electron/export/ffmpegWarnings.ts (comment), docs/export-pipeline.md, docs/ARCHITECTURE.md; tests below |
| Regression test | tests/unit/ts-start-offset.test.ts (20 tests) |

### Root cause
FFmpeg's `correct_input_start_times()` (see Verification): for MPEG-TS, MPEG-PS and FLV the zero of `-start_at_zero`,
and of the default rebasing without `-copyts`, is the start of the streams the command maps, not the container start.
ReCut's zero everywhere else (the preview's `mediaTimeOffset`, OCR, the source check) is the probed container start,
clamped at 0. Every FFmpeg command that mapped a subset of a TS / PS file's streams and relied on FFmpeg's zero was
off by the gap between the mapped streams' start and the container start.

### Fix
Every affected command reads with `-copyts` (the file's own timestamps) and subtracts the probed container start
(`MediaProbe.startTime`, clamped at 0) itself:
- **Export** (`renderGraph.ts` `addInput`): `-copyts` instead of `-copyts -start_at_zero`; the video chain's `trim` /
  `setpts` and the audio chain's `atrim` / `asetpts` add `t0` (the container start). `-ss` / `-t` are unchanged
  (FFmpeg seeks relative to the container start, and its accurate-seek trim then compares on absolute times). For a
  source starting at 0 the filter graph is byte-identical.
- **Scene detection** (`sceneDetect.ts`): `-copyts`, the probed start subtracted from each cut (in whole
  microseconds). `SCENE_VERSION` 3, so cached cuts are recomputed.
- **Thumbnails** (`thumbs.ts`): `-copyts` (single and batch). `THUMB_VERSION` `covering-frame-display-shape-v4`.
- **Channel proxies** (`channelProxy.ts`): `-copyts` and `asetpts=PTS-<start>/TB` before the pan, so
  `aresample=async=1:first_pts=0` pads a late stream from the container start. `CHANNEL_PROXY_VERSION` 2.
- **Media proxies** (`proxy.ts`): `-copyts -itsoffset -<start>` and `-fps_mode cfr` (what FFmpeg picks for mp4
  without `-copyts`; with it, its automatic choice would drop the start padding). No cache version change: the
  output is identical whenever the mapped streams include the earliest one and the container start is not negative
  (`framemd5` of video and audio, old against new arguments, identical on 16 sources: TS, MKV, MP4, VFR, B-frames,
  late audio / video, two video streams, a 10 s start offset; the 17th, an MKV with a -0.021 s start, differs in
  its audio only, see Before / after).

The smallest correct fix: the export cannot get the right zero from FFmpeg for TS / PS when an input maps one
stream, and the probed start is already the zero of the preview, OCR and the source check.

### Before / after
On a TS whose video starts 0.541333 s after its audio (25 fps), FFmpeg 6.1.1:
- video-only clip, source 2 s: frames 50..74 → 36..60 (the editor's frames); source 7.013 s: 175..199 → 162..186.
  Linked clip, MKV remux and a start-0 MP4: 36..60 / 162..186 before and after.
- audio-only clip of a TS whose audio starts 0.5 s late, in-point 0.2 s: sound from 0.0001 s → 0.30 s (MKV remux:
  0.30 s).
- channel proxy of that stream: sound from 0.010 s → 0.50 s (MKV remux: 0.50 s).
- scene cuts: 1.0, 2.0, 3.0 → 1.541333, 2.541333, 3.541333 (MKV remux the same).
- thumbnails (all-intra TS, late video) at 1.0, 2.3, 2.95, 5.5 s: frames 10, 42, 59, 122 → 11, 43, 60, 123.
- media proxy mapping video + the later of two audio streams: video 7 frames → 14 frames from the start, the same
  as the all-streams proxy.

Also changed, and checked in Chromium: a source with a **negative** container start, such as an FFmpeg-made MKV with
AAC (start -0.021 s). `-start_at_zero` shifted it by +0.021 s, so it exported one frame early at 24, 25 and 30 fps
(source 2 s: frame 47 instead of 48 at 24 fps, 49 instead of 50 at 25 fps, 59 instead of 60 at 30 fps; video-only
and linked). The preview plays it at its file times (the container start is clamped at 0; Chromium presents frame N
at media time N/24), so the export now matches it. Proxies of such a file drop the 21 ms of priming before 0 instead
of shifting the audio 21 ms late.

### Regression test proof
`tests/unit/ts-start-offset.test.ts` on 8d72c55 (fix stashed):
```
× a video-only clip: -copyts, and the trim / setpts add the container start
  → expected [ '-hide_banner', '-nostdin', …(48) ] to not include '-start_at_zero'
× a linked clip shares one input, and the audio chain adds the container start too
× a source starting at 0 keeps the filters it had
× media proxy: -copyts with -itsoffset of minus the container start, CFR as before
× channel proxy: -copyts, rebased by the container start before the pan
✓ the fixtures … / ✓ the negative-start fixture
× TS, late video: video-only clip shows the editor's frames
  "in 2: got 50..74 (25), want 36..60 (25)", "in 7.013: got 175..199 (25), want 162..186 (25)"
✓ TS, late video: linked picture + sound clip shows the editor's frames
✓ MKV remux of the same streams: video-only / linked
✓ MP4 starting at 0: video-only / linked
× MKV with a negative container start (AAC priming): video-only / linked
  "in 2: got 49..73 (25), want 50..74 (25)"
× an audio-only clip starts its sound where the MKV remux does → expected 0.000104 to be greater than 0.28
× the channel proxy is padded to the container start → expected 0.010125 to be greater than 0.48
× scene detection: cuts are container-relative → expected 0.541333 to be less than 0.002
× thumbnails: "thumbs.ts at 1: frame 10, want 11", "at 2.3: frame 42, want 43", "at 2.95: frame 59, want 60", "at 5.5: frame 122, want 123"
× a media proxy that maps only some streams of a TS stays on the container start
Tests  13 failed | 7 passed (20)
```
On the fix: 20/20, with FFmpeg 6.1.1 (system), 8.1.3-Jellyfin (the bundled build) and n9.0.2 (BtbN).

### Tests run
- `npm run typecheck`: clean.
- `npm test`: 123 files, 2109 passed, 2 skipped (2111).
- `tests/unit/ts-start-offset.test.ts`: 20/20 with FFmpeg 6.1.1, 8.1.3-Jellyfin and n9.0.2.
- Media attack suite (`npx vitest run -c tests/attack/vitest.config.ts`): 11 files, 118/118.
- E2E (`xvfb-run -a npx playwright test -c tests/e2e/playwright.config.ts` export, export-mkv,
  export-source-problems, export-intermediates, centre-channel, scenes, collect, source, program, audio-streams,
  mono-level): 39/39.

### Changed existing assertions
- `tests/unit/export.test.ts` (inputs keep container-relative pts): the input args are `-copyts -ss …` instead of
  `-copyts -start_at_zero -ss …`; the filter assertions are unchanged.
- `tests/unit/export-fps.test.ts` `BEFORE_ARGS`: `-start_at_zero` removed; the recorded filter graph is unchanged.
- `tests/unit/centre-channel.test.ts` channel proxy args: `-copyts` first, cache name `_v2`.
- `tests/unit/collect-roundtrip.test.ts`, `tests/e2e/collect.spec.ts`: collected channel proxy names `_v2` (from
  `CHANNEL_PROXY_VERSION`).
- `tests/unit/media-move-cache.test.ts`: the legacy thumbnail directory hash uses the new `THUMB_VERSION`.
None of these encoded the wrong timing; they pinned the argument shape or the cache version.

### Compatibility risks
- Exports of TS / PS sources with late video (video-only clips) or late audio (audio-only clips) change to the right
  frames / timing; so do sources with a negative container start (one frame later at 24-30 fps when the start is
  more than half a frame, e.g. FFmpeg-made MKV with AAC). Sources starting at 0 or with a positive start in other
  containers export exactly as before (byte-identical graphs at start 0).
- Caches: all thumbnails and filmstrips are re-extracted once (THUMB_VERSION), cached scene cuts are recomputed on
  the next detection (SCENE_VERSION), and channel proxies are re-encoded when next requested (CHANNEL_PROXY_VERSION).
  Scene cuts already saved in a project (`detectedScenes`) and a channel proxy already recorded as ready in a project
  keep their old values until detection is run again or the proxy is rebuilt (Clip Inspector). Media proxies are not
  invalidated: a fallback-plan proxy of a TS made before this fix keeps its old timing until its cache file is removed.
- No project format change, no new dependency.

### Follow-ups
- [2026-10-09-negative-start-video-start-offset](../open/2026-10-09-negative-start-video-start-offset.md):
  `video.startTime` is measured from the unclamped negative start, so thumbnails of such files are one frame early
  and a clip starting at the media's first frame exports that frame black.
- [2026-10-09-ts-thumbnail-next-keyframe](../open/2026-10-09-ts-thumbnail-next-keyframe.md): TS thumbnails land on
  the next keyframe with long GOPs (seek, not timestamps).
- [2026-10-09-whisper-ignores-late-audio-start](../open/2026-10-09-whisper-ignores-late-audio-start.md): transcripts
  are early by a late audio stream's offset, in any container.
- Not filed: a media proxy is CFR from 0, so a source whose frames are off the proxy's frame grid (here 0.53 of a
  frame) previews the previous frame for in-points that land in that part of a frame (source 7.013 s: proxy 161,
  export 162). Frame-aligned in-points match. Same before and after this fix, for TS and MKV alike.
