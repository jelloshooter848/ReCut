# Formats

ReCut has two media paths:

- **Probe, thumbnails, waveforms, proxies, scene detection and export** use FFmpeg. Anything your FFmpeg build can
  decode can be imported and exported. Every file is handed to FFmpeg / FFprobe as `file:<absolute path>`, so a
  name containing `:`, `|`, `#` or `?` is read literally and never as an FFmpeg protocol (`concat:`, `http:`,
  `pipe:`, ...). Media paths in a project must therefore be absolute; a relative one is refused with "media path
  must be an absolute path".
- **Preview** (Source / Program / Compare monitors) runs inside Chromium. Only browser-decodable files play
  directly. Everything else plays from a **proxy**.

## Import

The **Import Media** dialog (Ctrl+I, or **Import…** in the Project panel) filters on:

| Group | Extensions |
|---|---|
| All media | every extension below |
| Video | mp4, m4v, mov, mkv, webm, avi, wmv, ts, m2ts, mts, mpg, mpeg, flv, ogv, 3gp |
| Audio | mp3, m4a, aac, wav, flac, ogg, oga, ac3, eac3, dts, wma, opus, aiff, aif |
| Images | png, apng, jpg, jpeg, jpe, jfif, webp, bmp, tif, tiff, gif, heic, heif, avif, jxl, tga, exr, psd, dpx, sgi, pcx, ppm, pgm, pbm, pam, qoi, hdr, jp2, j2k |
| Subtitles | srt, vtt |
| All files | * (any file FFprobe can read, e.g. mka) |

The Images list is the one list ReCut uses to recognise still images (`shared/media.ts`): an image file goes into the
**Graphics** bin, and the probe treats a picture without duration from one of these files as a still.

You can also drag files from the OS onto the Project panel. Subtitle files (`.srt`, `.vtt`) included in a media
import are attached as sidecars when they match a video (see below). Otherwise they are skipped with a hint to use
**Import Subtitles…**.

The probe records the container, duration, container start time, the first video stream (codec, size, rational and
average fps, a VFR flag, pixel format, rotation, sample aspect ratio, the stream's start offset), **every** audio
stream (codec, channels, layout, sample rate, language), and every subtitle stream. Attached pictures (cover art)
and attachment streams are ignored. Files that fail to probe stay in the project with an **Error** badge. Missing
files are marked **offline**.

## Preview: direct vs proxy

A file previews **directly** only when all of these are true (`electron/media/probe.ts` → `evaluatePlayability`):

| Check | Accepted |
|---|---|
| Container | mp4, mov, m4v, m4a, webm, matroska (mkv), mp3, wav, flac, ogg |
| Video codec | h264 (8-bit 4:2:0 only), vp8, vp9, av1, theora (in ogg) |
| Audio codecs (every stream) | aac, mp3, opus, vorbis, flac, pcm_s16le, pcm_s24le, pcm_f32le |

Anything else needs a proxy. The reason is shown in the Media Inspector and Source monitor (e.g. "audio codec ac3
not supported by Chromium"). Typical cases:

- HEVC / H.265, MPEG-2, VC-1, ProRes, DNxHD and other codecs
- H.264 4:2:2, 4:4:4, or 10-bit
- AC-3, E-AC-3, DTS or TrueHD audio, even when the video is H.264
- MPEG-TS / M2TS, AVI, WMV, FLV containers

**Still images** show in the Source and Program monitors and export as stills:

- PNG, JPEG (`jpg`, `jpeg`, `jpe`, `jfif`), WebP, GIF and BMP are drawn directly from the original.
- Every other still FFmpeg decodes (TIFF, TGA, EXR, PSD, JPEG XL, AVIF, HEIC, DPX, ...) is previewed from a **PNG
  proxy** that FFmpeg makes on import (`<cache>/proxies/<key>_still.png`): the first picture, upright (FFmpeg applies
  the EXIF / display-matrix orientation), un-squeezed to square pixels, RGBA when the source has alpha, the long side
  capped at 3840 px. It is queued even with **Use proxies** off, because without it the preview has nothing to draw.
  AVIF goes through the proxy although Chromium could draw it, so the preview shows FFmpeg's decode, the one the
  export uses. Until the PNG exists, the Source monitor says "<EXT> image needs a preview proxy" and the Program
  monitor counts it under **Needs proxy**.
- An **animated GIF** (more than one frame) is a video: it gets an MP4 proxy like any file Chromium cannot play. A
  one-frame GIF is a still.
- What your FFmpeg build decodes decides which stills import at all. See [LIMITATIONS](LIMITATIONS.md#preview-chromium-and-proxies)
  (HEIC needs FFmpeg 7.1 or later).

### Proxies

- With **Use proxies** on (the default, in the Project panel toolbar, Jobs › Proxies, or Preferences), importing a
  video or audio file that Chromium cannot decode **queues a proxy automatically**. A toast says
  "Generating proxies for N files the preview can't decode". Still images get their PNG proxy whatever the setting
  (see above).
- Proxy format: MP4, H.264 (`veryfast`, CRF 23, 12-frame GOP for snappy seeking), scaled to the proxy height (540p
  by default; 720p and 1080p can be chosen in Jobs › Proxies › Size, never larger than the source), and AAC 160 kb/s
  with at most 2 channels per track. A 5.1 source therefore gets a stereo proxy.
- The proxy carries **every** audio stream of the source, in source order, one AAC track each
  (`<key>_<height>p_all.mp4`). The preview picks the track of each clip's stream, so changing a stream never needs a
  new proxy.
- If FFmpeg cannot decode or encode one of the streams, that run fails, and the proxy is retried with only the
  streams FFmpeg can decode (`<key>_<height>p_a<N>_a<M>….mp4`), then with the media's selected stream alone
  (`<key>_<height>p_a<N>.mp4`; the first decodable stream when that one cannot be decoded). The project records which streams the proxy carries. A clip whose stream is not in it
  previews the proxy's first track.
- Proxies from before 0.4 carry one stream (`<key>_<height>p_a<N>.mp4`, or `<key>_<height>p.mp4` for the first).
  They stay in use while every clip plays that stream; when a clip or the media needs another one, the proxy is
  marked stale and, with proxies on, rebuilt with every stream.
- Proxies are cached under `<cache>/proxies/` and keyed by path + size + mtime, so a re-import reuses them.
- You can also generate a proxy manually: right-click › **Generate Proxy**, Media Inspector › **Generate**, the
  Program chip **Generate proxies**, or the bulk buttons in Jobs › Proxies.
- **Proxies off:** browser-playable originals play directly. For an undecodable original that already has a ready
  proxy, ReCut still plays the proxy (the Program shows the **Proxy** chip) instead of showing nothing. This is
  deliberate. With no proxy, the Program shows **Needs proxy: N** with a **Generate proxies** action.
- **Export never uses proxies.** It always reads the original files.

### Other preview notes

- Files whose container start time is not 0 (e.g. TS remuxes) are offset correctly in the preview.
- Variable-frame-rate files are flagged **VFR** in the Media Inspector, which suggests a proxy. Export handles them
  frame-exactly. Chromium's own seeking on VFR originals is less predictable.
- Display rotation (phone video) is read from the stream's side data. Width and height are reported as displayed.
- Anamorphic (non-square pixel) video, e.g. DVD at 720×480 with SAR 32:27: thumbnails and filmstrips are
  un-squeezed to the display shape (thumbnails cached by older builds are regenerated once), and export un-squeezes
  it before fitting it into the frame. The monitors rely on Chromium to apply the pixel aspect ratio.

## Audio layouts

| Source | Preview | Export (stereo) | Export (5.1) |
|---|---|---|---|
| Mono | plays through WebAudio | upmixed to both channels | mapped into 5.1 by FFmpeg's resampler |
| Stereo | plays as is | as is | mapped into 5.1 by FFmpeg's resampler (front L/R) |
| 5.1 | the browser downmixes to your output device (a proxy is already stereo) | downmixed by FFmpeg (`aformat` / `-ac 2`) | 6 channels, AC-3 |
| 7.1 and other layouts | as above | downmixed | converted to 5.1 |

- **5.1 export** (Export › Audio › Channels › **5.1 Surround**, or the **1080p 5.1 Surround** preset) is only offered
  when at least one source in the sequence has 6 or more channels. It uses AC-3 at 640 kb/s by default.
- A sequence can be set to 5.1 in New Sequence / Sequence Settings (Match Media picks 5.1 when the clip has ≥ 6
  channels). That sets the export defaults. Mixing itself is level / gain / fades per clip and volume per track.
  There is no panning or surround positioning.
- **Multi-stream files** (e.g. an English stereo track and a Japanese 5.1 track): choose the stream in Media
  Inspector › **Audio stream** (used for new clips and by the Source monitor) or per clip in Clip Inspector › Audio ›
  **Stream** (**Media default** follows the media's choice). Export renders that exact stream, and so does the
  preview: the Program monitor plays, and the timeline draws, each clip's stream, from the original or from the
  proxy, which carries every stream. The Source monitor plays and draws the media's selected stream. A stream the file does not have falls back to the first audio stream, as in
  the export. The preview selects the track through Chromium's `audioTracks` (see
  [LIMITATIONS](LIMITATIONS.md#audio)).

## Subtitles

| Source | How |
|---|---|
| SRT, WebVTT files | **Import Subtitles…** (Project right-click, File menu, or Transcript › Import), or in a sequence's Subtitles panel with **Import to track…**. The parser accepts BOMs, CRLF, 3-digit hours and VTT cue identifiers. |
| Sidecar files | When a video is imported, `<video name>.srt|.vtt` and `<video name>.<lang>.srt|.vtt` **in the same folder** are attached automatically, with the language taken from the file name. |
| Embedded text streams | Right-click › **Embedded Subtitles** or Transcript › Import › **Embedded…**. Text codecs (SubRip, ASS/SSA, mov_text, WebVTT, TTML, SAMI, MicroDVD, ...) are converted to SRT. ASS styling is dropped. |
| Bitmap streams (PGS, VobSub, DVB, XSUB) | Right-click › **Embedded Subtitles** or Transcript › Import › **Embedded…** › "#3 eng (PGS) — **Read with OCR…**". ReCut reads the images with its built-in OCR engine (Tesseract) in the language you choose; install languages once in **File › OCR Languages…**. The track is named "English (OCR #3)". Teletext and ARIB captions are not supported. |
| Speech-to-text | Transcript › Import › Transcribe… › **Local Whisper…** or right-click › **Transcribe with Whisper…**: the built-in whisper.cpp engine transcribes any audio stream FFmpeg can decode (it is converted to 16 kHz mono first) with a model installed from **File › Transcription Models…** (ggml Whisper models, 78 MB to 1.6 GB). The track is named "English (Whisper Small)". |

Media subtitle tracks feed the Transcript search. When **Carry subtitles into sequence** is on (the default),
inserting a clip copies its cues into the sequence's subtitle tracks, attached to the clip.

**Output:**
- Subtitles panel › **Export** › **Export SRT…** / **Export VTT…** writes one track. It only writes absolute
  `.srt` / `.vtt` paths, refuses any file the project reads from (media, proxies, subtitle files imported to media
  or to a sequence track, or read by the Transcript; compared case-insensitively and by file identity, so links are
  caught), and writes through a temp file in the same folder that is renamed into place.
- Export dialog › Subtitles › **Sidecar** writes `<name>.srt` next to the MP4 with the sequence's subtitle cues
  (all tracks merged), re-timed to the exported range.
- Export dialog › Subtitles › **Burn in** renders them into the picture with FFmpeg's `subtitles` filter (needs
  libass). Cues are snapped to the sequence frames the Program monitor shows them on, so they appear and disappear on
  exactly those frames. The sidecar keeps the exact cue times.

## Images

Stills (png, jpg, gif, bmp, webp, and anything else FFmpeg reads as an image) import as `image` media with a default
length of 5 s when inserted. They export with `-loop 1` at the sequence frame rate. A still whose name contains a
printf pattern such as `x%03d.png` fails with FFmpeg 6.1 (see [LIMITATIONS](LIMITATIONS.md)).

## Export formats

- Container: **MP4** only (`+faststart`).
- Video: **H.264 (libx264)** or **H.265 / HEVC (libx265)**, yuv420p, constant frame rate. Quality is either **CRF**
  (14–32) or **Target bitrate**. Encoder preset ultrafast…slow. Frame size 16–8192 px (even). Frame rate is the
  sequence's or 23.976 / 24 / 25 / 29.97 / 30 / 50 / 59.94 / 60 (NTSC rates stay exact rationals, e.g. 30000/1001).
  A rate other than the sequence's is converted at the output by repeating or dropping frames: the timeline,
  transitions, subtitles and audio are rendered at the sequence rate, so the duration and A/V sync do not change.
- Audio: **AAC** (44.1 / 48 / 96 kHz) or **AC-3** (32 / 44.1 / 48 kHz, the encoder's limit), stereo or 5.1. Switching
  to AC-3 lowers a higher sample rate to 48 kHz; a request that still asks for an unsupported AC-3 rate is exported
  at 48 kHz (or the next supported rate) with a warning.
- Range: entire sequence or In → Out. A range edge inside a transition renders the frames the full export renders.
- Anamorphic sources are un-squeezed, and the output always has square pixels.
- Chapters: the sequence's **Chapter** markers in the range (names and times from the range start; ordinary and
  continuity markers are not exported). No chapter markers, no chapters. The first chapter starts at 0: a chapter
  marker at or before the range start (the latest one) covers it; if there is none, an untitled chapter runs from 0
  to the first chapter marker. No metadata is copied from the sources: no global tags (title, comment, artist,
  date, ...), no source chapters, no stream titles, handler names or languages (streams carry FFmpeg's defaults:
  `und`, `VideoHandler` / `SoundHandler`).
- Output: an absolute folder, an existing file is only replaced after you confirm, and a project source file is
  never written over (see [USER-GUIDE › Export](USER-GUIDE.md#15-export) and
  [export-pipeline.md](export-pipeline.md#output-files)).
- Presets (`shared/model.ts` → `EXPORT_PRESETS`, plus **Match Sequence**):

| Preset | Size | Video | Audio |
|---|---|---|---|
| 1080p High Quality | 1920×1080 | H.264 CRF 18, medium | AAC 320 kb/s stereo |
| 1080p Smaller File | 1920×1080 | H.264 CRF 26, fast | AAC 160 kb/s stereo |
| 4K High Quality | 3840×2160 | H.264 CRF 18, medium | AAC 320 kb/s stereo |
| 720p Preview | 1280×720 | H.264 CRF 28, veryfast | AAC 128 kb/s stereo |
| 1080p 5.1 Surround | 1920×1080 | H.264 CRF 18, medium | AC-3 640 kb/s 5.1 |
| Match Sequence | sequence size | (keeps current codec settings) | sequence rate / channels |

Exports are frame-exact: the output has exactly the frame count of the exported range, and each frame is the one the
Program monitor shows. With a converted frame rate the output has `round(range duration × export rate)` frames and
each one shows the sequence frame on screen at its midpoint. See [export-pipeline.md](export-pipeline.md).
