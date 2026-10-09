# MPEG-TS / MPEG-PS with late video: a video-only clip exports early by the video's start offset

| Field | Value |
|---|---|
| Status | in-progress |
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
