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

Each rendered clip segment is its own ffmpeg input (so a clip used three times is decoded three times,
each decode limited to what is needed):

```
-ss <seek> -t <preroll + srcLen + 0.25> -i <media.path>
```

`seek = max(0, sourceStart - 1s)` (one second of pre-roll for decoder warm-up); the exact cut is done
in-graph with `trim=start=<preroll>` so cuts land on the intended frame regardless of keyframe placement.
Input seeking in ffmpeg is relative to the container start time, which is also what `sourceIn` means.
Images use `-loop 1 -framerate FPS -t <len>`. Disabled clips are skipped; offline / missing media and
clips whose media lacks the needed stream are skipped with a warning (black / silence is rendered there).

### Video segments (one chain per clip)

```
[i:v:0] trim=start=P:duration=L, setpts=PTS-STARTPTS, [setpts=PTS/speed,] fps=FPS, format=yuva420p,
        scale=W:H:force_original_aspect_ratio=decrease:force_divisible_by=2,
        <transform>, [lut=a=val*opacity,]
        tpad=stop=N:stop_mode=clone, trim=end_frame=N, setpts=PTS-STARTPTS, [fade=in/out]
```

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

Per video track, segments and gaps are joined with `concat=n=K:v=1:a=0` followed by
`setpts=N*den/num/TB` (re-stamps frames consecutively, independent of concat's duration estimation).
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
atrim=start=P:duration=L, asetpts=PTS-STARTPTS, [atempo... (stages within 0.5..2)],
aresample=SR, aformat=sample_fmts=fltp:channel_layouts=stereo|5.1,
[volume=<gain>dB,] [volume=<volume>,] [afade in/out,] apad=whole_dur=len, atrim=duration=len
```

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
