# Known limitations

This page describes ReCut 0.8.1 as of 9 October 2026. Every item was checked against the code. Items marked **bug** are
defects. The others are features ReCut does not have yet (see [ROADMAP](ROADMAP.md)).

## Editing and effects

- **Keyframes (first version):** only position, scale, opacity and level animate. Rotation, crop, gain and the
  fades keep one value per clip. Interpolation is Linear or Ease (one fixed curve, chosen per keyframe for the
  segment that follows it); there are no Bézier handles, hold keyframes or graph editor. The timeline's keyframe
  diamonds are read-only (no dragging); keyframes are added, changed and removed in the Inspector at the playhead.
  Keyframes cannot be copied between clips. With several clips selected, an edit applies to each clip at its own
  frame under the playhead.
- **No colour tools.** There is no grading, LUT, exposure or white balance, and no video effects beyond transform,
  opacity and crop.
- **No titles or generators.** Text, shapes and solids are not available. Import a still image instead.
- **Three transitions:** Cross Dissolve, Dip to Black, Audio Crossfade.
  - A Cross Dissolve or Audio Crossfade of an odd length plays and exports one frame shorter (it is centred on the
    cut, so it covers the same number of frames on each side).
  - When a clip has too little media past its edge for a Cross Dissolve, the export renders it shorter, or as a cut,
    and the Export dialog warns about it; the Program monitor still plays it at full length, holding the clip's first
    or last frame.
  - A Cross Dissolve at the edge of a nested clip is drawn as two ramps, one over the other, not as a mix of the two
    pictures, so it dims in the middle (by a quarter of the outgoing picture at the cut), in the preview and the
    export alike. Dissolves between clips inside the nested sequence, or between two plain clips, mix linearly.
- **Nested sequences and compound clips** (see the [user guide](USER-GUIDE.md#acts-and-reels-nested-sequences-and-compound-clips)):
  - Nesting is limited to 8 levels, and to 1,000 tracks or 50,000 clips (picture and sound together) once
    flattened: every inner track of every nested clip becomes a track of the outer sequence, with the inner clips the
    nested clip plays, counting every clip and track as enabled. Nesting, pasting, Make Compound Clip and Break
    Apart refuse what would go past it; a project file past it opens with the nested clips past it made offline
    (listed in the repair warning). Adding clips or tracks inside a nested sequence is not checked, so a project can
    grow past the limit that way and is then cut the next time it is opened.
  - A nested clip always plays at 100 % speed (no speed change or reverse on it; change the speed of the clips
    inside).
  - An inner sequence of another frame rate plays in real time at the outer rate by picking the inner frame shown at
    each outer frame's start time (frames are repeated or skipped, never blended).
  - A nested clip's opacity applies to each inner layer on its own, not to the inner picture as a whole, so where
    semi-transparent inner layers overlap they show through each other. Inner layers that are rotated are not cut
    off at the inner frame's edge or by the nested clip's crop.
  - Keyframes inside a nested sequence of another frame rate play at the same times, so their frames are rescaled
    to the outer rate (a keyframe can land between two outer frames).
  - An inner layer whose own position or scale is keyed is not cut to the inner frame edge or the nested crop.
  - A long clip animated both inside and on the nested clip is sampled into keyframes, at most 2,000 points per
    property: beyond 2,000 frames the motion is followed through every second (or n-th) frame, in straight lines
    between them. Such long keyframe lists export slowly, because FFmpeg evaluates the whole list on every frame
    (a 6-second clip with 2,000 keyframes on position, scale and level took about 13 seconds to export).
  - **Break Apart** goes one level deep and needs the same frame rate inside and outside.
  - Chapters, markers and subtitle tracks inside a nested sequence are not exported (only the exported sequence's
    own), and the Subtitles panel does not show them on the outer timeline.
  - Compare lists a nested clip as one clip; it does not compare what changed inside it.
  - Nested clips show no thumbnails or waveform on the timeline, and cannot be added to the scene library.
  - The preview decodes every inner layer itself, so a nested clip costs what the same clips cost on the outer
    timeline.
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
  channels) or downmix to stereo through FFmpeg's resampler. Per clip, Clip Inspector › Audio › **Channels** can play
  one source channel as mono or a stereo downmix with set centre and surround levels instead (Roadmap §9 quick
  utility). There is no surround mixer, panner or per-channel routing (a mono channel goes to the centre), and 7.1
  output is not available.
- **The centre channel is not a dialogue stem.** **Extract Centre Channel (Dialogue)** copies the source's centre
  channel (FC), which carries most of a film's dialogue but also the music and effects mixed to the centre. It does
  not separate voices from the rest; that is stem separation (Roadmap §12), which ReCut does not have. Off-centre
  dialogue (panned voices, dialogue in the surrounds) stays in the other channels.
- **Preview of surround:** proxies are stereo, and the browser downmixes directly-played 5.1 to your output device.
  A clip's channel selection previews from its own stereo audio file (made with the export's filter), so it needs
  a short FFmpeg job before it is heard; the clip is silent in the Program monitor until then. Each distinct
  selection (stream, channel or downmix levels) of a file gets its own file in the cache.
- **Channel-selected clips draw the whole stream's waveform** on the timeline, not the selected channel's.
- **Keyframed level:** the timeline waveform is drawn at the clip's static level, not the keyframed one. The
  Program monitor follows the keyframes with a gain ramp re-aimed on every display frame (about every 16 ms, 50 ms
  ahead), so a steep ramp can lag the export's level briefly; while scrubbing or shuttling it is silent, as before.
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
  - **HEIC / HEIF** needs FFmpeg 7.1 or later (phone photos are tile grids). The FFmpeg bundled in the Windows,
    Linux and macOS releases (8.1 or later) is new enough. FFmpeg 6.1 (e.g. Ubuntu 24.04's, when running from source)
    cannot read HEIF, so there a HEIC neither previews nor exports.
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
- **VFR sources** are flagged in the Media Inspector ("timecodes may drift; consider a proxy") and in the Export
  dialog's Checks. In the media attack suite, exports of VFR clips match the editor's frame model, but Chromium's own
  seeking on VFR files has not been measured. For frame-critical work on VFR material, use a proxy or a
  constant-frame-rate transcode.
- No dedicated GPU decode or render path. Decoding is whatever Chromium does for `<video>`. Set
  `RECUT_DISABLE_GPU=1` if the GPU misbehaves.

## Subtitles and transcripts

- **Speech-to-text (Whisper) runs on the CPU only** (Metal on Apple Silicon), never on an NVIDIA / AMD GPU, and it
  is slow with the big models. **Intel Macs** get no Metal acceleration either: the Intel (x64) dmg's engine is
  CPU-only, so transcription there is noticeably slower than on an Apple Silicon Mac (it does not need Rosetta). Measured on the development machine (4 shared cores of a 2.1 GHz Xeon, AVX-512,
  3 threads), the engine's encoder needs 0.5 s (Tiny), 1.5 s (Base) and 4.3 s (Small) per 30 s of audio; decoding
  the text adds about as much again. As a rough guide an hour of dialogue takes a few minutes with Tiny or Base and
  about a quarter to half an hour with Small; Medium and Large v3 Turbo can take longer than the media plays. These
  are encoder measurements with generated models of the real sizes: no real model could be downloaded on that
  machine, so end-to-end times with real models are still to be measured.
- Whisper's text is an approximation: names, songs, shouting, overlapping voices, heavy accents, music and effects
  under the dialogue can be misheard or dropped, and it sometimes repeats a line or invents one in silence. It does
  not tell speakers apart (no diarisation). Timing is per phrase, not per word. Auto-detect decides the language
  from the start of the audio, so a film that opens with music may be detected wrongly: choose the language instead.
- A long media is transcribed in parts of up to 30 minutes, cut at the quietest moment near each boundary; a line
  spoken across a cut can still be split in two.
- Models are downloaded from Hugging Face only when you click Install, and only from the pinned files; if Hugging
  Face moves its downloads to another host, installs fail with "refusing redirect to …" until ReCut is updated: use
  **Install from file…** meanwhile.
- Bitmap subtitle streams (PGS, VobSub, DVB, XSUB) are read with **OCR** (Read with OCR…), which needs the
  stream's language installed once (File › OCR Languages…). OCR is an approximation: italics, coloured or
  low-contrast text, signs and songs drawn into the subtitle, unusual fonts and heavy styling can come out with wrong
  characters or not at all. The result is an ordinary track; check the lines you rely on. Teletext (`dvb_teletext`)
  and ARIB captions are not supported.
- ASS/SSA styling is dropped (converted to SRT).
- Sidecar auto-pickup looks only in the video's own folder (`name.srt`, `name.<lang>.srt`, and `.vtt`). Subtitles in
  a separate `subs/` folder must be imported with **Import Subtitles…**.
- No dedicated multi-language subtitle authoring view. Tracks are edited one at a time in the Subtitles panel.

## Export

- Formats: MP4 (H.264 / H.265, AAC / AC-3), MKV (H.264 / H.265 with several audio tracks, soft subtitles and
  chapters), MOV (ProRes or DNxHR with PCM audio), and audio-only WAV or FLAC (one mixed file or one file per audio
  track). No WebM, no image sequences, no hardware encoders, no DNxHD (the legacy fixed-size profiles) and no ProRes
  4444 XQ or alpha channel.
- **MKV packaging:** ProRes / DNxHR are not offered in MKV (use MOV); there is no Opus, E-AC-3, DTS or TrueHD audio
  and no audio passthrough (every track is re-encoded from the mix); all audio tracks share one sample rate; soft
  subtitles are plain SubRip text (no ASS styling, no bitmap PGS / VobSub, no attachments or fonts). A 5.1 track of
  stereo sources has them in front left / right only (no upmix to the centre or surrounds), and a stereo or mono
  track of 5.1 sources is FFmpeg's standard downmix (no custom downmix levels, §9). Matroska stores no channel layout
  for PCM tracks, only the count. Audio track sources are saved as track ids, so export settings reused on another
  sequence lose their chosen sources (the Checks list asks for them again).
- **MP4 has one audio track and no soft subtitles.** FFmpeg's MP4 muxer drops stream titles and forces the first
  `mov_text` track to default, so multi-track packaging is MKV only.
- **Intermediates are composited in 8-bit 4:2:0.** ProRes and DNxHR are written in their 4:2:2 / 4:4:4 10-bit pixel
  formats, but the render graph composites every clip in 8-bit 4:2:0 (as for H.264), so a 10-bit or 4:2:2 source
  loses that precision. They are edit-friendly intra-frame files, not a higher-quality master.
- **Colour tags:** MOV files carry the same colour tags as the MP4 export: no primaries, transfer or matrix
  for ProRes (FFmpeg 8 and later mark it limited range; 6.1 leaves the range unmarked). FFmpeg's DNxHR encoder
  always marks its stream BT.709, limited range, whatever the source.
- **DNxHR needs at least 256×120** (an FFmpeg encoder limit); the dialog refuses smaller frame sizes.
- **One file per audio track:** muted tracks, tracks not soloed (when any track is soloed) and tracks with no enabled
  clip in the range get no file. There is no per-clip channel routing or panning in the files: each is the track at
  the export's channel layout. There are no stems by content (dialogue / music / effects, §12).
- **WAV files over 4 GB** are written as RF64, which some older programs cannot open.
- No interchange formats (EDL, FCPXML, OTIO, AAF).
- **Frame-rate conversion** (an export frame rate other than the sequence's) repeats or drops whole frames. There is
  no frame blending or motion interpolation, so 23.976 → 30 shows a regular repeat cadence and 23.976 ↔ 24 repeats
  or drops one frame about every 42 s. Duration and audio sync are not affected.
- **Keyframes in the export:** a clip with keyframed position or scale is placed per frame with FFmpeg's
  `perspective` filter (bilinear, sub-pixel) instead of the static scale / rotate / pad chain, which costs time: on
  the 4-core test machine about 35 frames per second at 1080p for that clip's part of the timeline, on top of the
  decode and encode. The picture is first scaled (bicubic) to the largest size the clip reaches when that is below
  100 %; well below that size fine detail can shimmer, and the Checks list warns when the scale drops under half of
  it. Keyframed opacity changes in steps of 1/1024; keyframed level is evaluated every 256 samples (5.3 ms at
  48 kHz). Clips without keyframes export exactly as before.
- **Pre-export warnings** (Export dialog › Checks) do not cover abrupt level jumps at cuts or subtitle timing drift:
  both need an analysis pass over the media.
- **AC-3 audio** is limited to 32, 44.1 and 48 kHz (the FFmpeg encoder's rates). 96 kHz is available with AAC only.
- **Output names are compared case-insensitively on every platform.** An export (video, sidecar `.srt`, or a
  Subtitles panel SRT/VTT export) whose path differs from a project source file only in letter case is refused,
  also on a case-sensitive Linux volume.

## Platform and packaging

- **Verified packages:** the Windows installer and portable exe (built, installed and smoke-tested on Windows in CI;
  the unit and end-to-end suites run on Windows on every build and must pass before anything is published) and the
  Linux x86-64 AppImage (built on Ubuntu 22.04 in CI, launched and smoke-tested; the unit and end-to-end suites run on
  Linux on every build and must pass before anything is published). Nothing is signed for Windows, so SmartScreen
  warns on first launch.
- **macOS: two dmgs, no universal build.** Each release has an arm64 (Apple Silicon) and an x64 (Intel) dmg, each
  with its own architecture's FFmpeg and speech-to-text engine bundled, signed with a Developer ID and notarized
  ([MACOS-SIGNING](MACOS-SIGNING.md)); pick the one for your Mac ([INSTALL](INSTALL.md#macos)). Needs macOS 12 or
  newer (the bundled FFmpeg's minimum); tested in CI on macOS 14 on Apple Silicon only. **The Intel build has never run
  on an Intel Mac:** CI runs it under Rosetta 2 on the Apple Silicon runner (Rosetta there reports no AVX, so the AVX /
  AVX2 / AVX-512 speech-to-text kernels an Intel Mac would use are built but not exercised). Intel Macs do not need
  Rosetta. Intel support may be retired after 1.0. Test builds from CI artifacts (not releases) are ad-hoc signed when
  the signing secrets are not available, so macOS blocks their first launch until it is allowed under System Settings ›
  Privacy & Security.
- **Linux: AppImage only, x86-64 only.** No `.deb`, `.rpm`, Flatpak or Snap, and no ARM build. The AppImage needs the
  FUSE 2 library (`libfuse2`) unless it is started with `--appimage-extract-and-run`, and it does not add itself to
  the application menu or register `.recut` files (an AppImage integration tool can). The bundled FFmpeg needs glibc
  2.28 or newer, so very old distributions (before Debian 10 / Ubuntu 18.10 / RHEL 8) cannot run it. Tested on Ubuntu
  22.04 only.
- **FFmpeg is bundled only in the Windows release builds, the Linux AppImage and the macOS dmgs** (and fetched
  by `Start ReCut.cmd`).
  Elsewhere, install it yourself or drop static binaries into `resources/ffmpeg/` before `npm run package` /
  `npm run dist` (see
  [INSTALL](INSTALL.md#bundling-ffmpeg)). ReCut works with FFmpeg 6 through 9. When FFmpeg is missing, ReCut shows a banner and import / proxies / export stop with
  an explanation. ReCut finds FFmpeg once per session, so restart it after installing.
- The cache location can only be changed with `RECUT_CACHE_DIR` or `cacheDir` in `prefs.json`. There is no UI for it.
- One window and one open project at a time.
- **No automatic updates.** ReCut can only tell you that a newer release exists (opt-in daily check, or Help › Check
  for Updates…) and open its release page; you download and install it yourself. The check needs access to
  `api.github.com` (through the system proxy, if any). It never offers a pre-release (release candidate) to someone
  running a stable version; someone running a release candidate is told about a later candidate of the same version
  or a newer stable release.

## Projects

- Projects store **absolute** media paths, so moving media means using Relink. A media path that is not absolute
  (for example in a hand-edited project file) is refused by probing, thumbnails, proxies and export with "media path
  must be an absolute path".
- **Derived media are cached by a sampled fingerprint, not a full hash.** Thumbnails, waveforms, proxies, scene cuts
  and OCR results are keyed by the file's size and nine 64 KiB blocks (start, end and evenly between), so they survive
  moving, renaming and copying a file. A file changed in place without changing its size, where every changed byte
  lies outside those blocks (a hex patch, a fixed-size tag rewritten in the middle), keeps its old derived media until
  you clear the cache folder. Remuxes and re-encodes change the size or the sampled bytes.
- **Collect Project copies, it does not move.** It needs room for a full copy of the media on the destination, and
  it does not delete or relink anything in the open project. It stops at the first file it cannot copy or verify
  (the folder is left marked incomplete); there is no resume, so collect again into an empty folder. Media not used
  in any sequence (with **Media used in sequences only**) and offline media keep their original paths in the copy.
  Collected projects still store absolute paths (relative media roots are [roadmap §17](ROADMAP.md#17-cloud-free-collaboration)).
  A FAT32 drive cannot hold a file over 4 GB, so collecting a large remux there fails at that file.
- **Limits on load:** timeline positions and durations are capped at 86,400,000 frames (24 h at 1000 fps, far more
  at normal rates), clip speed at 1 %–10 000 %, nested sequences at 8 levels and at 1,000 tracks or 50,000 clips
  once flattened (the nested clips past either limit are made offline), and any value nested deeper than 64
  levels in the JSON is dropped. An invalid sequence frame rate becomes 23.976.
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
- **The reference machine** for these numbers and for the gate is that class of machine: a 4-core cloud container
  (Intel Xeon @ 2.10 GHz, 16 GB, xvfb + software GL), calibration score js 80 ms, ffmpeg 452 ms, render 242 ms
  (`tests/perf/calibrate.mjs`, lower is faster; recorded in `tests/perf/baseline.json` on 7 October 2026). Re-measured
  then on 0.4.1 (the two quiet runs that seeded it), the 3 h sequence scrubbed at 54–57 fps at the closest zoom.
- **A slower machine is slower.** On a 4-core host about 1.5–2× slower than the reference, scrubbing the 3 h sequence
  at the closest zoom measured about 41 fps rather than ~59, and opening and saving took about 1.1 s and 450 ms
  instead of 714 and 214 ms: open and save time scale with the host's speed.
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
