# Known limitations

This page describes ReCut 0.1.0 at commit `7156564`. Every item was checked against the code. Items marked **bug** are
defects. The others are features ReCut does not have yet (see [ROADMAP](ROADMAP.md)).

## Editing and effects

- **No keyframes.** Position, scale, rotation, opacity, crop, gain and level are fixed per clip.
- **No colour tools.** There is no grading, LUT, exposure or white balance, and no video effects beyond transform,
  opacity and crop.
- **No titles or generators.** Text, shapes and solids are not available. Import a still image instead.
- **Three transitions:** Cross Dissolve, Dip to Black, Audio Crossfade.
- **No nested sequences or compound clips.**
- **Speed:** forward only (no reverse). The Speed / Duration dialog (Ctrl+R) accepts 1 %–10 000 %. The Inspector's
  Speed field is limited to 10 %–800 %.
- **Sync:** linked clips that drift show an out-of-sync badge with the frame offset. There is no "Move / Slip into
  Sync" command, so you fix the offset by hand.
- **What-if experiments** disable clips and show an *estimated* runtime. No single action removes the disabled
  clips and closes the gaps. Use Ripple Delete, or duplicate the cut first.
- **Transcript search** flags lines that are already in the cut ("on timeline") only when the scope is a
  **Sequence**. In project, series or season scope it does not.
- **Undo** keeps the last 200 steps per session. Playhead, zoom and In/Out are not undoable.
- **Show source timecode on clips** is off by default. Turn it on in Preferences.

## Audio

- **No mixer, panning or per-track meters.** You get clip gain, level and fades, track volume, mute and solo, and one
  stereo peak meter on the Program monitor. The **Audio** workspace is only a different layout of the same panels.
- **Surround:** 5.1 is pass-through or downmix only. Export can produce 5.1 AC-3 (offered when a source has ≥ 6
  channels) or downmix to stereo through FFmpeg's resampler. There is no surround positioning, and 7.1 output is
  not available.
- **Preview of surround:** proxies are stereo, and the browser downmixes directly-played 5.1 to your output device.
- **Multi-stream originals:** export renders each clip's selected audio stream. The preview does not: a
  directly-playable file plays Chromium's default (first) audio track, and a proxied file plays the single stream
  baked into its proxy (the media's selected stream at proxy time). Changing a clip's stream does not change what
  you hear in the preview.

## Preview (Chromium) and proxies

- The monitors are Chromium `<video>` elements composited on a 2D canvas, so only browser codecs play directly
  (H.264 8-bit 4:2:0, VP8/9, AV1 with AAC/MP3/Opus/Vorbis/FLAC/PCM in MP4/MOV/MKV/WebM/Ogg). HEVC, AC-3, DTS, TS and
  similar files need a **proxy**. With proxies on (the default), they are generated automatically on import. See
  [FORMATS](FORMATS.md).
- **Proxies off does not mean originals only.** For an original Chromium cannot decode, a ready proxy is still used
  (Program shows the **Proxy** chip). This is deliberate. "Needs proxy" appears only when no proxy exists.
- **Bug: still images are not drawn in the Program monitor.** Images are probed as not browser-playable
  (`playabilityReason: "still image"`), so Program shows black and a **Needs proxy** chip over them. A proxy cannot
  fix this: Generate Proxy is disabled for images in the Project menu, and the proxy job rejects a source with no
  duration ("source has neither video nor audio"). The Source monitor shows images, and export renders them
  correctly. (Checked by reading the code and by running `resolvePlaybackPath` on a probed PNG. Not reproduced in
  the UI.)
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

## Platform and packaging

- **Only the Linux unpacked build** (`npm run package` → `release/linux-unpacked`) has been verified. The AppImage,
  dmg and nsis targets are configured but untested. Nothing is signed or notarised.
- **FFmpeg is not bundled.** Install it yourself. ReCut does not warn at startup when it is missing. Imports and
  exports fail, and Preferences / About show "not found".
- **Bug (minor):** the exporter resolves FFmpeg on its own path. It honours `RECUT_FFMPEG` and `PATH` (then falls back
  to `/usr/bin/ffmpeg`), but ignores `RECUT_FFMPEG_PATH` and the `<resources>/ffmpeg` folder that the media services
  check.
- **Preferences** are reachable with Ctrl+, (or Cmd+, / the app menu on macOS). On Linux and Windows there is no menu
  item for them.
- The cache location can only be changed with `RECUT_CACHE_DIR` or `cacheDir` in `prefs.json`. There is no UI for it.
- One window and one open project at a time. Projects store **absolute** media paths, so moving media means using
  Relink.

## Scale and performance

- The performance attack (`docs/attack/performance.md`) measured a 2,500-clip, 60-media project and found slow
  playback, edits and autosave. Since then, the playhead moves in place, hidden panels unmount, the timeline has a
  level-of-detail lane, the Scenes / Transcript / Project lists are virtualized, autosave is idle-time and compact,
  export is chunked and job lanes are split. **The report has not been re-measured since those changes.**
- Snapshots store full copies of a sequence, so many snapshots of a large sequence make the project file grow
  quickly.

## Reports in `docs/` that are out of date

- `docs/acceptance.md` lists BUG-1 to BUG-6 from the last gauntlet run. Commit `7156564` contains fixes for all six
  (safe output-folder creation; the conform prompt on Transcript inserts; Movie routing without a year; per-file
  chip counts; a toast when opening from `.bak`; redrawing the paused frame when a proxy becomes ready). The gauntlet
  has not been re-run since.
- The `docs/attack/*.md` reports are snapshots from before the fix waves. At this commit, the `tests/attack-qa` unit repros (84
  tests) and the `tests/attack` media measurements (102 tests) all pass. The Playwright parts of those suites were
  not re-run. Re-run a suite before you treat a finding as open.
