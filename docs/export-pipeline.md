# Export pipeline

The export turns a `Sequence` into one MP4 with a single ffmpeg invocation. The acceptance bar is that
**the file reflects the timeline exactly**: every frame of the output corresponds to the frame the editor
shows at that position, and the duration equals the exported range to the frame.

Files:

- `electron/export/renderGraph.ts` — pure. `buildRenderGraph(req, { subtitleFilePath? })` returns
  `{ args, filterGraph, durationSec, frameCount, outputPath, warnings, subtitleContent?, inputCount }`.
  No I/O; unit-tested; used for the "preview command" UI.
- `electron/export/exporter.ts` — runs it: writes the graph to a temp file, spawns ffmpeg, parses
  `-progress` output, handles cancel, renames `<name>.part.mp4` to the final name, writes the `.srt` sidecar.
- `tests/unit/export.test.ts` — generates synthetic media with ffmpeg and checks durations, frame counts,
  pixel colors and audio levels of real exports.

## Time model

- Timeline positions are integer frames at the sequence fps; source positions are seconds.
- The exported range is `[startF, endF)` frames: the whole sequence (`0..sequenceDuration`) or
  `view.inPoint..view.outPoint` for `rangeMode: 'inOut'` (falls back to the entire sequence with a warning
  when the marks are missing or empty). Output duration is exactly `(endF - startF) * den/num` seconds.
- Everything inside the graph is positioned relative to `startF`, so the output always starts at 0.

## Graph construction

### Inputs

Each rendered clip segment gets an ffmpeg input, each decode limited to what is needed. A linked
video + audio pair with the same range shares one input (identical args are reused once per stream kind),
so a linked clip is decoded once:

```
-copyts -start_at_zero [-ss <seek>] -t <(S - seek) + srcLen + 0.25> -i <media.path>
```

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
        fps=FPS:start_time=0, format=yuva420p, [lut=a=0:enable='lt(t,T)',] scale=W:H:force_original_aspect_ratio=decrease:force_divisible_by=2,
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
- `<transform>`: identity is a single `pad` to WxH. Otherwise `crop` (fractions of the fitted image) →
  `scale` (transform.scale) → `rotate` (degrees→radians, transparent fill, bounding box kept even) →
  `pad` onto a transparent canvas large enough to hold both the frame and the image, centered on the frame
  center plus `(x, y)` (sequence pixels, 0,0 = centered; crop keeps the cropped region's on-screen position) →
  `crop=W:H`. Geometry is expressed with `iw/ih` expressions so rounding inside ffmpeg cannot make `pad` fail.

Gaps are `color=black@0.0` (transparent) sources of exactly the gap's frame count; the opaque black base is
added at compositing time, so V1 gaps are black.

### Track assembly and compositing

Per video track, segments and gaps are joined with `concat=n=K:v=1:a=0` (a single segment is used as is)
followed by `settb=den/num,setpts=N` (re-stamps frames consecutively with integer timestamps, independent of
concat's duration estimation; the former `setpts=N*den/num/TB` truncated to N-1 in floating point and
dropped/doubled frames on single-segment tracks).
Tracks are composited bottom (V1) to top with `overlay=0:0:eof_action=pass` onto an opaque black base of
exactly `frameCount` frames, then optional `subtitles=`, then `format=yuv420p`. Muted video tracks are
skipped; if any track is soloed, only soloed tracks are rendered.

### Transitions: the centered-handle model

A transition of `D` frames between A (outgoing) and B (incoming) is **centered on the cut**: the region
`[cut - D/2, cut + D/2)` is the mix. Timeline positions of A and B do not move and the total duration is
unchanged. To render it:

- A's segment is extended by `h = D/2` frames past its end using the *source* frames after `sourceOut`
  (the out-handle); B's segment starts `h` frames earlier using the source before `sourceIn` (the in-handle).
- `xfade=transition=fade|fadeblack:duration=D:offset=len(A') - D` consumes `A' = A + h` and `B' = B + h`
  and yields `A + B` frames. Chained transitions fold left: `xfade(xfade(A', B'), C')`, offset computed
  from the running length.
- `D` is rounded down to an even number and clamped to the available handles, to each clip's length and
  to the export range; a clamped or dropped transition produces a warning. A transition whose cut falls at
  the range boundary becomes a hard cut.
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

`-c:v libx264|libx265 -preset P (-crf C | -b:v Nk -maxrate Nk -bufsize 2Nk) -pix_fmt yuv420p -r FPS
-fps_mode cfr -c:a aac|ac3 -b:a Nk -ar SR -ac N -movflags +faststart -t <duration> -f mp4 <outputDir>/<fileName>.mp4`.
`-shortest` is never used: durations are controlled in the graph; `-t` is only a safety clamp.

## Running it

- The graph is always passed via `-filter_complex_script <file>` (Windows has a 32k command-line limit).
  `args` contains the `__FILTER_SCRIPT__` token which the exporter replaces with the temp file path;
  `buildExportCommand()` inlines the graph for display instead.
- Temp files live in `os.tmpdir()/recut-export-<id>/` and are deleted afterwards.
- Progress is parsed from `-progress pipe:1` (`out_time_us` / duration). Failure rejects with the last 30
  stderr lines; cancel sends SIGKILL and deletes the partial file.
- Burn-in: `buildRenderGraph` returns range-relative SRT in `subtitleContent`; the exporter writes it and
  passes the path, which is escaped for both filtergraph parsing levels (`escapeFilterPath`). With
  `exportSubtitleSidecar`, the same SRT is written next to the MP4.
