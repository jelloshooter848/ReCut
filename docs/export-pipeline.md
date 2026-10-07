# Export pipeline

The export turns a `Sequence` into one file (MP4, MOV, WAV or FLAC; or one WAV / FLAC per audio track) with a single
ffmpeg invocation per file (or, for very large sequences, a series of bounded chunk renders joined losslessly; see
"Chunked rendering"). The acceptance bar is that
**the file reflects the timeline exactly**: every frame of the output corresponds to the frame the editor
shows at that position, and the duration equals the exported range to the frame.

Files:

- `electron/export/renderGraph.ts` — pure. `buildRenderGraph(req, { subtitleFilePath? })` returns
  `{ args, filterGraph, durationSec, frameCount, outputFps, outputFrameCount, outputDurationSec, outputPath, warnings,
  subtitleContent?, inputCount, ... }`.
  No I/O; unit-tested; used for the "preview command" UI.
- `electron/export/exporter.ts` — runs it: writes the graph to a temp file, spawns ffmpeg, parses
  `-progress` output, handles cancel, moves the render temp (`<name>.recut-part-<random>.mp4`) onto the final
  name, writes the `.srt` sidecar (see "Output files").
- `electron/export/chunks.ts` — pure. Decides when to chunk and plans chunk boundaries.
- `electron/safeMkdir.ts` — creates the output folder without recursive mkdir (see "Running it").
- `electron/pathSafety.ts` — `canonicalPath` (realpath) and `fileIdentity` (device + inode) for the "is this a
  project source file?" checks, shared with the Subtitles panel's SRT/VTT export.
- `shared/exportFormat.ts` — pure. Containers (`CONTAINERS`: extension, muxer, muxer args, chapters, audio-only),
  the video encoder (`videoEncoder`: H.264 / H.265, ProRes profiles, DNxHR profiles, pixel format) and audio encoder
  (`audioEncoder`: AAC / AC-3, PCM 16 / 24, FLAC) of the settings, size-estimate rates, and the per-track audio plan
  (`perTrackAudioPlan`, `perTrackFileName`). The render graph and the Export dialog both use it.
- `shared/media.ts` — sample aspect ratio validation (`saneSar`, 1/16..16) and `videoDisplaySize`, shared with
  the preview compositor.
- `src/panels/export/request.ts` — builds the `ExportRequest` in the dialog, including `protectedPaths`.
- `tests/unit/export.test.ts` — generates synthetic media with ffmpeg and checks durations, frame counts,
  pixel colors and audio levels of real exports.

## Time model

- Timeline positions are integer frames at the sequence fps; source positions are seconds.
- The exported range is `[startF, endF)` frames: the whole sequence (`0..sequenceDuration`) or
  `view.inPoint..view.outPoint` for `rangeMode: 'inOut'` (falls back to the entire sequence with a warning
  when the marks are missing or empty). Output duration is exactly `(endF - startF) * den/num` seconds. A range
  that is not a pair of safe integers, or longer than 24 h, is refused with an error.
- Everything inside the graph is positioned relative to `startF`, so the output always starts at 0.
- **Range edges inside a transition** (`widenRangeForTransitions`): when `startF` or `endF` falls inside a
  transition window (a two-sided transition `(cut − ⌈D/2⌉, cut + ⌈D/2⌉)`, or a one-sided fade over the clip edge),
  the graph renders the widened range `[renderStartF, renderEndF)` and trims the composite back to `[startF, endF)`
  (`trim=start_frame/end_frame` on video, `atrim=start_sample/end_sample` on audio). An In/Out (or chunk) range
  therefore renders the frames the full export renders; a transition is never shortened, dropped or restarted by
  the range.

### Output frame rate

`settings.fps` (the dialog's Frame rate) is the encoded rate. It must pass the shared `isValidFps`
(`shared/time.ts`: integer terms 1..1,000,000, 1..1000 fps); anything else falls back to the sequence rate with a
warning. When it equals the sequence rate (also as an unreduced fraction, e.g. 48000/2002), the graph and args
are exactly the sequence-rate ones. Otherwise **all timeline maths stay at the sequence rate** (segments, trims,
transitions, fades, burn-in subtitles, the whole audio graph) and only the composited video is resampled at the very
end:

    [vcomp] ... format=yuv420p, tpad=stop=<P>:stop_mode=clone, settb=den/num, setpts=N+<rel>,
            fps=fps=OUT, trim=end_frame=<K>, setpts=PTS-STARTPTS [vout]

`setpts=N+<rel>` gives every frame its absolute sequence index relative to the export start (`rel` is non-zero
for a chunk), so `fps` puts output frame `n` on the last sequence frame `i` with `round(i · OUT / SEQ) <= n`
(FFmpeg rounds half up), i.e. the sequence frame on screen at the middle of output frame `n`. The
`P = ⌈SEQ / OUT⌉ + 1` cloned frames (at least one output frame's worth) let `fps` emit the final output frames,
also for a range shorter than half an output frame; `trim` keeps exactly
`K = outputFrameIndex(endF − exportStart) − outputFrameIndex(startF − exportStart)` frames, where
`outputFrameIndex(f) = round(f · OUT / SEQ)` (exact BigInt maths, `renderGraph.ts`). For the whole export
`K = round(duration · OUT)` (at least 1), the encoder gets `-r OUT -fps_mode cfr`, and `-t` is
`max(duration, K / OUT)` so the last frame (which can end up to half an output frame after the audio) is never cut.
Audio is untouched, so duration and A/V sync are those of the sequence. Verified frame by frame against this
model on FFmpeg 6.1, 8.1 and 9.0 (`tests/unit/export-fps.test.ts`).

## Graph construction

### Inputs

Each rendered clip segment gets an ffmpeg input, each decode limited to what is needed. A linked
video + audio pair with the same range shares one input (identical args are reused once per stream kind),
so a linked clip is decoded once:

```
-copyts -start_at_zero [-ss <seek>] -t <(S - seek) + srcLen + 0.25> -i file:<media.path>
```

The exporter passes every input and output path as `file:<absolute path>` (`ffmpegFileArg`,
`electron/media/ffmpeg.ts`; single pass, chunks, concat lists, final join), so a path such as `concat:/a|/b`,
`tee:...` or `pipe:0` is never an FFmpeg protocol, and a relative path is refused instead of being read relative to
the main process's working directory. `buildRenderGraph` itself (and "Show FFmpeg command") shows the plain paths.

**Timestamps are container-relative source seconds.** `-copyts -start_at_zero` keeps every stream's own
pts minus the container start_time, which is exactly what `sourceIn` means (and what the editor, proxies and
thumbnails use). ffmpeg's default rebasing is not used because it depends on the container: MPEG-TS does not
rebase to the `-ss` point (its picture came out 1 s early), and each stream's own start offset was lost for
clips in the first second of a file. `-ss` is only a decode shortcut: `seek = max(0, S - h - preroll)` with
`h = 0.5/mediaFps`, `preroll = 0.04 s` for MP4/MOV/MKV/WebM (frame-exact input seek) and `1 s` for other
containers (TS etc.). All cuts are done in-graph on absolute source times, so they land on the intended frame
regardless of keyframe placement.
Images use `-loop 1 -framerate FPS -t <len>`. Disabled clips are skipped; offline / missing media and
clips whose media lacks the needed stream are skipped with a warning (black / silence is rendered there).

### Video segments (one chain per clip)

```
[i:v:0] trim=start=S-h:duration=h+L, settb=AVTB, setpts=PTS-(S+c)/TB, [setpts=PTS/speed,]
        fps=FPS:start_time=0, format=yuva420p, [lut=a=0:enable='lt(t,T)',]
        scale=<un-squeeze by sar>, setsar=1, scale=W:H:force_original_aspect_ratio=decrease:force_divisible_by=2, setsar=1,
        <transform>, [lut=a=val*opacity,]
        tpad=stop=N:stop_mode=clone, trim=end_frame=N, setpts=PTS-STARTPTS, [fade=in/out]
```

- **Frame choice matches the editor.** The Program Monitor seeks to `sourceTime + 0.5/mediaFps` and shows the
  frame covering it, i.e. media frame `floor(t*mediaFps + 0.5)`. The chain keeps frames from half a media
  frame before the in-point `S`, keeps their sub-frame phase, and biases them by
  `c = 0.5/mediaFps - 0.5*speed/seqFps (+1 µs so a frame starting exactly at the seek time wins)`; `fps`
  (which keeps the last frame whose rounded pts falls in a slot) then picks exactly that frame, also for
  off-grid in-points, mixed rates and VFR sources. `settb=AVTB` keeps sub-frame precision (`setpts` truncates
  to the stream time base, 1/1000 in MKV).
- `fps=…:start_time=0` anchors slot 0 at the in-point. A video stream that starts after the in-point (the
  probe records `video.startTime`, the stream start relative to the container start) is padded with its first
  frame, made transparent up to `T` (the slot of its first real frame).
- `tpad` + `trim=end_frame=N` make every segment **exactly N frames** even if the source ran short or
  `fps` rounded differently; this is what makes segment arithmetic (and therefore timeline positions) exact.
- Segments are `yuva420p` with transparent padding so upper tracks show lower tracks through letterboxing,
  crops and offsets. Opacity is applied to the alpha plane.
- **Square pixels.** The first scale un-squeezes a non-square sample aspect ratio to the display shape (wider
  for SAR > 1, taller for SAR < 1; a SAR within 1e-6 of 1 passes untouched), as the preview's `<video>` element
  does, so anamorphic DVD / HDV sources fill the frame the same way. `setsar=1` after the fit scale and at the end
  of the transform chain keeps every segment, gap and transition input at SAR 1: the even rounding of `scale` /
  `crop` leaves a slightly non-square SAR, which `concat` and `xfade` refuse to join. The crop offset uses the
  fitted display size (`fitInputSize`, `shared/media.ts` `videoDisplaySize(..., 'filter')`).
- `<transform>`: identity is a single `pad` to WxH. Otherwise `crop` (fractions of the fitted image) →
  `scale` (transform.scale) → `rotate` (degrees→radians, transparent fill, bounding box kept even) →
  `pad` onto a transparent canvas large enough to hold both the frame and the image, centered on the frame
  center plus `(x, y)` (sequence pixels, 0,0 = centered; crop keeps the cropped region's on-screen position) →
  `crop=W:H, setsar=1`. Geometry is expressed with `iw/ih` expressions so rounding inside ffmpeg cannot make `pad`
  fail.

Gaps are `color=black@0.0` (transparent) sources of exactly the gap's frame count; the opaque black base is
added at compositing time, so V1 gaps are black.

### Track assembly and compositing

Per video track, segments and gaps are joined with `concat=n=K:v=1:a=0` (a single segment is used as is)
followed by `settb=den/num,setpts=N` (re-stamps frames consecutively with integer timestamps, independent of
concat's duration estimation; the former `setpts=N*den/num/TB` truncated to N-1 in floating point and
dropped/doubled frames on single-segment tracks).
Tracks are composited bottom (V1) to top with `overlay=0:0:eof_action=pass` onto an opaque black base of
exactly the rendered range's frame count, then (for a widened range) `trim=start_frame=<lead>:end_frame=<lead +
frameCount>`, optional `subtitles=`, `format=yuv420p` and, with a converted frame rate, the resampling above.
Muted video tracks are skipped; if any track is soloed, only soloed tracks are rendered.

### Transitions: the centered-handle model

A transition of `D` frames between A (outgoing) and B (incoming) is **centered on the cut**: the region
`[cut - D/2, cut + D/2)` is the mix. Timeline positions of A and B do not move and the total duration is
unchanged. To render it:

- A's segment is extended by `h = D/2` frames past its end using the *source* frames after `sourceOut`
  (the out-handle); B's segment starts `h` frames earlier using the source before `sourceIn` (the in-handle).
- `xfade=transition=fade|fadeblack:duration=D:offset=len(A') - D` consumes `A' = A + h` and `B' = B + h`
  and yields `A + B` frames. Chained transitions fold left: `xfade(xfade(A', B'), C')`, offset computed
  from the running length.
- `D` is rounded down to an even number and clamped to the available handles and to each clip's length; a
  clamped or dropped transition produces a warning that names the limit ("source handles" only when the handles
  are what shortened it). The export range does not clamp it: the render range is widened to cover it (see "Time
  model"). A transition whose clips are not adjacent is ignored with a warning.
- `outClipId: null` → `fade=t=in` over the first `D` frames of the clip; `inClipId: null` → `fade=t=out`.

Audio uses the same model with `acrossfade=d=D:c1=tri:c2=tri` (which overlaps the last `D` of A' with the
first `D` of B', i.e. the same `A + B` length), `afade` for the one-sided cases.

### Audio

Audio comes only from audio-track clips (linked video/audio are separate clips). Each clip maps the
**absolute** stream index: `[i:<clip.audioStream>]` (falls back to the media's preferred / first stream
with a warning). Chain:

```
atrim=start=S:duration=L, asetpts=PTS-S/TB, aresample=async=1:first_pts=0, [atempo... (stages within 0.5..2)],
aresample=SR, aformat=sample_fmts=fltp:channel_layouts=stereo|5.1,
[volume=<gain>dB,] [volume=<volume>,] [afade in/out,] apad=whole_dur=len, atrim=duration=len
```

Audio is rebased to the in-point `S` (not to its own first sample) and `aresample=async=1:first_pts=0` fills
a late-starting stream with silence, so a file whose audio starts after its video keeps that offset.

Muted clips are silence; gaps are `anullsrc`. Per track: `concat`, then `volume=<track.volume>`.
Tracks are mixed with `amix=inputs=N:normalize=0:duration=longest`, then `aresample`/`aformat` to the
output layout; `-ac 2|6` is also passed. A silent stream is produced when there is no audio at all, so the
MP4 always has an audio track.

### Encoding

MP4: `-c:v libx264|libx265 -preset P (-crf C | -b:v Nk -maxrate Nk -bufsize 2Nk) -pix_fmt yuv420p -r OUT_FPS
-fps_mode cfr -c:a aac|ac3 -b:a Nk -ar SR -ac N -movflags +faststart -t <duration> -f mp4 <outputDir>/<fileName>.mp4`.
`-shortest` is never used: durations are controlled in the graph; `-t` is only a safety clamp.

MOV: `-c:v prores_ks -profile:v 0..4 -vendor apl0` or `-c:v dnxhd -profile:v dnxhr_lb|sq|hq|hqx|444`, then
`-pix_fmt <profile's format> -r OUT_FPS -fps_mode cfr -c:a pcm_s16le|pcm_s24le -ar SR -ac N -t <duration> -f mov`.
The graph's last video filter is `format=<the same pixel format>` (yuv420p for MP4) after the composite, which stays
8-bit 4:2:0. No `+faststart` for MOV.

WAV / FLAC (audio only, `RenderGraph.audioOnly`): no video chains at all (no `[vout]`, no inputs for video clips, no
frame-size check), `-vn`, `-c:a pcm_s16le|pcm_s24le` (WAV, with `-rf64 auto`) or `-c:a flac -sample_fmt s16|s32
[-bits_per_raw_sample 24]`, and `[aout]` padded / trimmed to exactly `round(frames × SR × den / num)` samples. WAV
gets no chapters. Burn-in is ignored with a warning; "nothing enabled" checks audio tracks only.

Per-track audio (`settings.audioPerTrack` on WAV / FLAC): `exportOutputFiles` lists one request per file and
`buildExportGraphs` builds each with `RenderGraphOptions.audioTrackId`: the full export's range and its widening for
transitions, but only that track's chain into `[aout]` (`[ta]aresample,aformat,...[aout]`, the same chain the mix
sums with `amix=normalize=0`). The exporter renders every file to its own temp and only then renames them.

### Metadata and chapters

FFmpeg copies the first input's global tags (title, comment, artist, ...) and chapters into the output unless told
otherwise, so every export process (single pass, each chunk, the chunk join) passes `outputMetadataArgs`:
`-map_metadata:g -1 -map_metadata:s -1 -map_chapters <N|-1>`. No global or stream metadata comes from any input;
the streams carry FFmpeg's defaults (`language=und`, `VideoHandler` / `SoundHandler`). `-map_metadata -1` is not
used: it also drops the chapter titles that `-map_chapters` copies.

Chapters (`exportChapters`) are the sequence's markers of kind `chapter` in `[startF, endF)` (kinds `marker` and
`continuity` are editor notes): times in sequence seconds from the range start, so an output frame-rate conversion
does not move them; the latest chapter marker at or before `startF` covers the range start; two on one frame, the
later in the list wins; each chapter ends where the next starts, the last at the output duration (the `-t` value).
The first chapter starts at 0, because an MP4 chapter track cannot leave a gap before it (FFmpeg reads such a file
back with the first chapter at 0). When no chapter marker is at or before `startF`, an untitled leading chapter runs
from 0 to the first marker, so that marker's break is kept. `buildRenderGraph` returns them in `chapters` and as an FFMETADATA1 file in
`chaptersContent` (`ffmetadataChapters`, `TIMEBASE=1/1000000`, names escaped by `ffmetadataEscape`: `=`, `;`, `#`,
`\` and line breaks get a backslash; a trailing backslash is dropped, since FFmpeg 6.1–9.0 read a line break after
an escaped backslash as escaped). With `chaptersFilePath` the file is the last input, `-f ffmetadata -i <file>`, and
`-map_chapters` names it (`inputCount` does not count it). The MP4 muxer stores them as a `chpl` atom plus a chapter
text track (ffprobe lists it as a `data` stream; the probe ignores it). Chunk graphs carry no chapters; the chunked
join adds the same file as its third input.

## Running it

- The graph is always passed via `-filter_complex_script <file>` (Windows has a 32k command-line limit).
  `args` contains the `__FILTER_SCRIPT__` token which the exporter replaces with the temp file path;
  `buildExportCommand()` inlines the graph for display instead.
- Temp files (filter script, burn-in SRT, `chapters.txt`) live in `os.tmpdir()/recut-export-<id>/` and are deleted
  afterwards. The command preview shows the chapters file as `os.tmpdir()/recut-export/chapters.txt`.
- Progress is parsed from `-progress pipe:1` (`out_time_us` / duration). Failure rejects with the last 30
  stderr lines; cancel sends SIGKILL and deletes the partial file.
- Burn-in: `buildRenderGraph` returns range-relative SRT in `subtitleContent`; the exporter writes it and
  passes the path, which is escaped for both filtergraph parsing levels (`escapeFilterPath`). Cues are snapped
  to the sequence frames the editor shows them on (start frame inclusive, end frame exclusive) and written at
  frame midpoints, half a frame before those frames: libass picks cues by frame time in whole milliseconds, so
  exact frame times showed or hid about half the cue edges one frame off. Burn-in runs on the sequence-rate frames,
  before any frame-rate conversion. With `exportSubtitleSidecar`, a sidecar SRT with the exact cue times
  (`buildSubtitleSrt`) is written next to the MP4.
- The output folder is created with `ensureDirSafe` (`electron/safeMkdir.ts`), never with a blocking or
  recursive mkdir: recursive mkdir never returns under `/proc` and froze the main process (BUG-1). It walks up
  to the first existing ancestor, refuses non-folders and `/proc`, `/sys`, `/dev` (also through symlinks),
  creates the missing parts one at a time and gives up after 5 s with "Cannot create output folder".

## Output files

- **Absolute folder.** `exportOutputPath` refuses a relative `outputDir` ("The output folder must be an absolute
  path"); the dialog validates the same rule. The file name is reduced to a basename with the format's extension
  (`.mp4` by default; a known media extension such as `.mov` is replaced).
- **Never a project source.** `assertOutputNotASource` refuses an output or sidecar `.srt` that is a media or proxy
  file of the sequence, any media / proxy in `req.media` (own keys only, `Object.hasOwn`), or any path in
  `req.protectedPaths`. The dialog fills `protectedPaths` with `projectSourcePaths(project)`: every media and proxy
  path, every media subtitle track file (including the file the Transcript's subtitle-file provider read, and, for
  older tracks without a path, the sidecar names it looks for), and every file imported into a sequence subtitle
  track (`SequenceSubtitleTrack.sourcePaths`, in all sequences and snapshots). Paths are compared after
  `canonicalPath` (realpath) and case-folded on every platform; with the exporter's `statPath`, an existing output
  is also compared by device + inode (`fileIdentity`), so a hard link or alias is caught. An output or sidecar path
  that is a folder is refused before rendering.
- **No silent replace.** An existing output or sidecar throws `ExportOutputExistsError`; `startExport` returns
  `{ ok: false, code: 'exists' }` and the dialog asks "<file> already exists. Replace it?" and resends the request
  with `overwrite: true`. `runExport` checks again just before the final move, so a file created while rendering is
  not replaced either.
- **Exclusive temps.** The render goes to `<name>.recut-part-<random>.mp4`, created with `O_EXCL` next to the
  output (never an existing file, symlink or hard link); ffmpeg writes into that file, and its device + inode are
  checked before the move. The sidecar is written to `<name>.recut-part-<random>.srt` (flag `wx`) and renamed.
- **Final move** (`finalizeExportOutput`): a plain `rename`, which replaces the target atomically (POSIX rename,
  `MoveFileEx` with `REPLACE_EXISTING` on Windows); the previous file is never deleted first. Only when that is
  refused and a regular file is in the way (e.g. read-only on Windows) is it moved aside, the render moved in and
  the old file deleted, or moved back on failure. If the move still fails, the finished render is kept as
  `<name>.recut-unsaved-<time>.mp4` and the error names it.

## Chunked rendering (large sequences)

One graph opens one ffmpeg input (demuxer + decoder) per clip segment, all at once; ffmpeg memory grows
by about 6–13 MB per input and a 2,500-clip sequence was killed at 6 GB (docs/attack/performance.md P-01).
When the single-pass graph would have more than **150 inputs**, more than **120 video clip segments**, or an
estimated memory above 1.5 GB (`shouldChunk`), the exporter renders the range in chunks instead. Small sequences use the single pass
unchanged.

**Boundaries** (`planExportChunks`, integer sequence frames) are planned separately for the video pass
(video tracks only: ≤ 100 segments and ≤ 1,000 MB estimated memory per chunk) and the audio pass (audio
tracks only: ≤ 300 segments; audio-only inputs cost ~2.2 MB). ffmpeg keeps each finished segment's decoder
and filter frame pools until it exits, so a chunk's memory grows with its segments and with resolution:
`estimateSegmentMemoryMB = 2 + (10 · source pixels + 12 · output pixels) / 1e6` (measured, 96 segments →
1280x720: 1.07 GB with 160x90 sources, 2.97 GB with 1080p sources; 1080p → 1080p allows ~21 segments per
chunk). A boundary is a clip edge on a rendered track and is never:

- inside a transition window (two-sided: `(cut − ⌈D/2⌉, cut + ⌈D/2⌉)`; fade in/out: over the clip edge),
  so no xfade / acrossfade / fade is split and no transition is dropped as "at the range edge";
- inside an audio clip's own fade-in/out, inside an audio clip with speed ≠ 1 (atempo state), or inside a
  clip that needs more source than its media has (its held last frame needs earlier frames).

Cuts no clip spans on any track of the pass are preferred when they keep the chunk at least half full.
Each chunk is `buildRenderGraph(req, { range, streams })` over its sub-range: the same segment chains, frame
choice and exact frame counts as the single pass (a clip that spans a boundary is split into two segments
whose source positions come from `sourceTimeAt`, exactly like an In/Out export starting mid-clip). Burn-in
subtitles are written per chunk, relative to the chunk. With a converted output frame rate each video chunk
renders the output frames `[outputFrameIndex(start), outputFrameIndex(end))` of the whole export (see
"Output frame rate"), so the chunks add up to the single-pass count with no drift and the same frames; a video
chunk that owns no output frame (e.g. a 1-frame chunk at 60 → 24 fps) is merged into the next one
(`mergeChunksWithoutOutputFrames` in `exporter.ts`).

**Video**: one ffmpeg per chunk → `chunk-NNNN.mp4` with the export's encoder args plus closed GOPs and an
IDR at the chunk start (`-x264-params keyint=250:open-gop=0:stitchable=1` / `-x265-params
keyint=250:open-gop=0`, `-force_key_frames 0`), `-an`. Each input gets `-threads 1` and the graph
`-filter_complex_threads 2`: per-input decoder threads multiplied memory by the input count (1.47 GB →
0.56 GB for a 96-segment chunk of the perf sequence, no slower).

**Audio**: one ffmpeg per audio chunk → `chunk-NNNN.wav`, 32-bit float PCM (lossless w.r.t. the graph's
`fltp`, no clipping of `amix` sums above 1.0). The chunk is exactly `S(end) − S(start)` samples long
(`apad=whole_len=N,atrim=end_sample=N` on `[aout]`) with `S(f) = round((f − startF) · SR · den/num)`, so the
chunks join with no drift at any frame rate. Measured: the concatenated chunk PCM equals the single-pass
PCM to float rounding (≤ 1e-5, from SIMD/scalar tails at different frame splits) with boundaries inside
clips. Known limit: when a boundary splits a clip whose source sample grid does not line up with the
boundary (e.g. a 44.1 kHz source in a 48 kHz export, or 29.97 fps where a frame is 1601.6 samples), the rest
of that clip in the next chunk can be offset by less than one source sample (≤ 11 µs); inaudible.

**Join**: one ffmpeg reads both lists with the concat demuxer (`ffconcat`, relative names) — video
`-c:v copy`, the PCM through one final AAC/AC-3 encode with the export's audio args, the chapters file (when the
range has chapter markers) as a third input with `-map_chapters 2`, no metadata from the chunk files —
`-movflags +faststart -t <duration>` → `<name>.recut-part-<random>.mp4`, moved into place as usual. The chapters are
those of the single pass.

Progress is weighted (video 80 % by frames, audio 12 %, join 8 %) and monotonic. Cancel kills the current
ffmpeg; the temp folder (chunk files, lists, scripts) is removed in all cases. An error names the step:
`Export failed in chunk 3/26 (video, frames 5880-8760): <ffmpeg tail>`.
