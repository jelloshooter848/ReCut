# Known limitations

This page describes ReCut 0.3.0 as of 7 October 2026. Every item was checked against the code. Items marked **bug** are
defects. The others are features ReCut does not have yet (see [ROADMAP](ROADMAP.md)).

## Editing and effects

- **No keyframes.** Position, scale, rotation, opacity, crop, gain and level are fixed per clip.
- **No colour tools.** There is no grading, LUT, exposure or white balance, and no video effects beyond transform,
  opacity and crop.
- **No titles or generators.** Text, shapes and solids are not available. Import a still image instead.
- **Three transitions:** Cross Dissolve, Dip to Black, Audio Crossfade.
- **No nested sequences or compound clips.**
- **Speed:** forward only (no reverse). The Speed / Duration dialog (Ctrl+R) and the Inspector's Speed field both
  accept 1 %–10 000 %.
- **Sync:** linked clips that drift show an out-of-sync badge with the frame offset. There is no "Move / Slip into
  Sync" command, so you fix the offset by hand.
- **What-if experiments** disable clips and show an *estimated* runtime (V1 only, gaps not closed). **Remove
  disabled** / **Duplicate as cut** make it real, but skip clips on locked tracks.
- **Transcript search** flags lines that are already in the cut ("on timeline") only when the scope is a
  **Sequence**. In project, series or season scope it does not.
- **Undo** keeps the last 200 steps per session. Playhead, zoom and In/Out are not undoable.
- **Show source timecode on clips** is off by default. Turn it on in Preferences.
- **Timecode display** follows the frame rate only: at 29.97 and 59.94 fps every timecode (sequence and source) is
  SMPTE drop-frame (`HH:MM:SS;FF`), at every other rate non-drop. There is no setting to show non-drop timecode at
  29.97 / 59.94.

## Audio

- **No mixer, panning or per-track meters.** You get clip gain, level and fades, track volume, mute and solo, and one
  stereo peak meter on the Program monitor. The **Audio** workspace is only a different layout of the same panels.
- **Surround:** 5.1 is pass-through or downmix only. Export can produce 5.1 AC-3 (offered when a source has ≥ 6
  channels) or downmix to stereo through FFmpeg's resampler. There is no surround positioning, and 7.1 output is
  not available.
- **Preview of surround:** proxies are stereo, and the browser downmixes directly-played 5.1 to your output device.
- **Multi-stream originals** preview the stream the export renders for each clip. This relies on Chromium's
  `HTMLMediaElement.audioTracks`, which sits behind the `AudioVideoTracks` Blink feature; ReCut turns it on at
  startup (`electron/main.ts`). If a future Electron drops that feature, the preview would fall back to each file's
  first audio track while the export still renders the selected one. Proxies made before 0.4 carry a single stream:
  they keep working for that stream and are rebuilt (with every stream) when a clip or the media needs another one,
  with proxies on.
- **A proxy can lack a stream FFmpeg cannot decode or encode.** The proxy then carries only the streams it could
  make (or, failing that, the media's selected stream alone), and a clip set to a missing stream previews the
  proxy's first track. Such a stream usually fails in the export too.

## Preview (Chromium) and proxies

- The monitors are Chromium `<video>` elements composited on a 2D canvas, so only browser codecs play directly
  (H.264 8-bit 4:2:0, VP8/9, AV1 with AAC/MP3/Opus/Vorbis/FLAC/PCM in MP4/MOV/MKV/WebM/Ogg). HEVC, AC-3, DTS, TS and
  similar files need a **proxy**. With proxies on (the default), they are generated automatically on import. See
  [FORMATS](FORMATS.md).
- **Proxies off does not mean originals only.** For an original Chromium cannot decode, a ready proxy is still used
  (Program shows the **Proxy** chip). This is deliberate. "Needs proxy" appears only when no proxy exists.
- **Still images** in PNG, JPEG, WebP, GIF and BMP are drawn directly. Every other still is previewed from a PNG
  proxy that FFmpeg makes on import, so a format previews and exports only if your FFmpeg build decodes it:
  - **HEIC / HEIF** needs FFmpeg 7.1 or later (phone photos are tile grids). It works with the FFmpeg bundled in
    the Windows release. FFmpeg 6.1 (e.g. Ubuntu 24.04) cannot read HEIF, so there a HEIC neither previews nor
    exports.
  - **PSD**: FFmpeg 6.1 rejects the RLE-compressed PSD files ImageMagick writes ("Not enough data for rle
    scanline"); uncompressed PSD works.
  - **JPEG XL** needs an FFmpeg built with libjxl.
  - **Rotated AVIF** (`irot`): FFmpeg 6.1 ignores the rotation, so the preview and the export both show the picture
    unrotated (they agree, because both use FFmpeg's decode). EXIF orientation in JPEG is applied by both.
- **An animated GIF is a video**: it plays through an MP4 proxy and exports all its frames. A one-frame GIF is a
  still.
- **Still images whose file name contains a printf pattern** such as `x%03d.png` fail with FFmpeg 6.1: its image
  reader takes the name as a numbered image sequence. Rename the file.
- **Anamorphic (non-square pixel) media:** export and thumbnails un-squeeze it from the probed sample aspect ratio.
  The preview relies on Chromium applying the pixel aspect ratio itself (the `<video>` display size); this has not
  been compared with the export for every container.
- **VFR sources** are flagged in the Media Inspector ("timecodes may drift; consider a proxy"). In the media attack
  suite, exports of VFR clips match the editor's frame model, but Chromium's own seeking on VFR files has not been
  measured. For frame-critical work on VFR material, use a proxy or a constant-frame-rate transcode.
- No dedicated GPU decode or render path. Decoding is whatever Chromium does for `<video>`. Set
  `RECUT_DISABLE_GPU=1` if the GPU misbehaves.

## Subtitles and transcripts

- **No speech-to-text yet.** Transcribe… › **Local Whisper** is a disabled placeholder. Transcript search needs SRT
  / VTT files or embedded text subtitles.
- Bitmap subtitle streams (PGS, VobSub, DVB) cannot be imported. ASS/SSA styling is dropped (converted to SRT).
- Sidecar auto-pickup looks only in the video's own folder (`name.srt`, `name.<lang>.srt`, and `.vtt`). Subtitles in
  a separate `subs/` folder must be imported with **Import Subtitles…**.
- No dedicated multi-language subtitle authoring view. Tracks are edited one at a time in the Subtitles panel.

## Export

- MP4 only, with H.264 or H.265 video and AAC or AC-3 audio. There is no ProRes / DNxHR / image-sequence / audio-only
  export, and no hardware encoders.
- No interchange formats (EDL, FCPXML, OTIO, AAF).
- **Frame-rate conversion** (an export frame rate other than the sequence's) repeats or drops whole frames. There is
  no frame blending or motion interpolation, so 23.976 → 30 shows a regular repeat cadence and 23.976 ↔ 24 repeats
  or drops one frame about every 42 s. Duration and audio sync are not affected.
- **AC-3 audio** is limited to 32, 44.1 and 48 kHz (the FFmpeg encoder's rates). 96 kHz is available with AAC only.
- **Output names are compared case-insensitively on every platform.** An export (video, sidecar `.srt`, or a
  Subtitles panel SRT/VTT export) whose path differs from a project source file only in letter case is refused,
  also on a case-sensitive Linux volume.

## Platform and packaging

- **Verified packages:** the Windows installer and portable exe (built, installed and smoke-tested on Windows in CI;
  the unit and end-to-end suites run on Windows on every build and must pass before anything is published) and the
  Linux unpacked build. The macOS dmg and Linux AppImage are configured but untested. Nothing is signed or notarised,
  so Windows SmartScreen warns on first launch.
- **FFmpeg is bundled only in the Windows release builds** (and fetched by `Start ReCut.cmd`). Elsewhere, install it
  yourself or drop static binaries into `resources/ffmpeg/` before `npm run package` / `npm run dist` (see
  [INSTALL](INSTALL.md#bundling-ffmpeg)). ReCut works with FFmpeg 6 through 9. When FFmpeg is missing, ReCut shows a banner and import / proxies / export stop with
  an explanation. ReCut finds FFmpeg once per session, so restart it after installing.
- The cache location can only be changed with `RECUT_CACHE_DIR` or `cacheDir` in `prefs.json`. There is no UI for it.
- One window and one open project at a time.

## Projects

- Projects store **absolute** media paths, so moving media means using Relink. A media path that is not absolute
  (for example in a hand-edited project file) is refused by probing, thumbnails, proxies and export with "media path
  must be an absolute path".
- **Moving media rebuilds its derived media.** Thumbnails, waveforms and proxies are cached under a key made from the
  file's absolute path, size and modified time. After you move a file (even unchanged, to a new folder or drive) and
  relink it, its thumbnails and waveform are generated again, and so is its proxy the next time one is built. A
  proxy that was ready before the move keeps being used while its cache file exists. The old cache entries stay on
  disk until you clear the cache. There is no Collect / Consolidate Project command.
- **Limits on load:** timeline positions and durations are capped at 86,400,000 frames (24 h at 1000 fps, far more
  at normal rates), clip speed at 1 %–10 000 %, and nesting at 64 levels. An invalid sequence frame rate becomes
  23.976.
- **Repairs are lossy.** A damaged project opens with a warning that lists the repairs, and the unrepaired file is
  kept as `<file>.pre-repair-<time>`. Out-of-range items are dropped or pulled in, and overlapping clips are
  shortened at their start or moved to an extra track (at most 32 extra tracks per kind; clips beyond that are
  dropped). Check the edit before saving over the file.
- A file saved by a newer ReCut (or without a `formatVersion`) is refused. ReCut never opens the `.bak` in its place
  (for a file without a `formatVersion` the error names an existing `.bak`); copy it to a `.recut` name to open it.

## Scale and performance

- **Measured on 7 October 2026** (release 0.3.0, Roadmap §1): a 2,500-clip, 60-media project, plus a 3-hour,
  6,700-clip sequence at 23.976 fps, on a 4-core Linux machine with software rendering. Edits paint in 17–28 ms,
  scrubbing runs at 57–60 fps at every zoom (the 3 h sequence included), mouse-wheel scrolling responds in about 6 ms
  per step, switching to the big sequence takes about 50 ms, Program playback holds 24 fps, saving takes 214 ms
  (249 ms with the 3 h sequence), opening takes 714 ms (808 ms) without freezing the window, and autosave takes about
  190 ms without stalling playback or scrubbing. `npm run perf:check` checks these numbers (see
  [DEVELOPMENT](DEVELOPMENT.md) → Performance gate); the full record is
  `bugs/closed/2026-10-05-perf-budgets-2500-clips.md`.
- Saving, autosave and open still handle the whole project each time (streamed in small pieces, so the window stays
  responsive). Saving only what changed is planned only if a much larger project needs it (see
  [ROADMAP](ROADMAP.md) §1, future architecture trigger).
- Two timeline elements are drawn for speed rather than pixel-perfect smoothness: waveforms are filled bars aligned
  to screen pixels, and the playhead moves on its own GPU layer (positions and timing are exact). See
  `docs/attack/performance.md` → Deliberate rendering trade-offs.
- On a heavily loaded machine, the first visit to each page while scrubbing a multi-hour sequence at the closest zoom
  can still stutter briefly; later passes over the same pages are smooth.
- Snapshots store full copies of a sequence, so many snapshots of a large sequence make the project file grow
  quickly.

## Reports in `docs/` that are out of date

- `docs/acceptance.md` keeps BUG-1 to BUG-6 from the first gauntlet run for history; all six are fixed. The gauntlet
  was re-run on 5 October 2026: all four acceptance tests pass (17/17, 21/21, 22/22 and 11/11 steps, no
  workarounds), and the full end-to-end suite passes (51 tests).
- `docs/attack/performance.md` is the 4 October 2026 measurement (plus the 7 October rendering trade-offs note).
  For the current numbers, see [Scale and performance](#scale-and-performance) above.
- The other `docs/attack/*.md` reports are snapshots from before the fix waves. On 5 October 2026 the `tests/attack-qa`
  unit repros (84 tests), the `tests/attack-qa` Playwright repros (22 tests) and the `tests/attack` media
  measurements (102 tests) all passed. Re-run a suite before you treat a finding as open.
