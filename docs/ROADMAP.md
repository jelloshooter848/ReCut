# Roadmap

None of the capabilities below exist in ReCut yet. They are deferred, not abandoned. Each entry says why it waited
and where it would plug in. For what works today, see the [README](../README.md). For current gaps and bugs, see
[LIMITATIONS](LIMITATIONS.md).

Order is rough priority for fan editing: restructuring finished films and series at franchise scale. Entries 1 and
2 are gates rather than capabilities: they come before the next large feature.

## 1. Performance at franchise scale

**Why:** ReCut is for franchise-scale work: thousands of timeline clips, thousands of scenes, multi-hour
sequences. Re-measured on 5 October 2026 with the 2,500-clip, 60-media project from the performance attack,
playback, search and autosave now meet their budgets, but every edit still takes 80–120 ms from commit to paint
(budget 32 ms), scrubbing at working zoom runs at 32–35 fps (budget 50), and opening the project freezes the window
for about 3 s. Every new feature adds work to the same commit and render path, so this comes first.
**Why deferred:** the first round of fixes (in-place playhead, unmounted hidden panels, level-of-detail lane,
virtualized lists, idle autosave, chunked export) went in on 4 October 2026, and the benchmarks had not been re-run
until now.
**Plan:** treat the budgets in `tests/perf` as a gate. Remove the remaining per-frame clip re-renders when
scrubbing, keep edit commit → paint under 32 ms, and move project open / save / clone off the renderer's main thread
(compact JSON built off-thread, one `normalizeProject` pass). Add a multi-hour sequence to `tests/perf/bigProject.mjs`.
Re-run the perf, attack and acceptance suites before each large feature below.

## 2. Fix the remaining preview gaps

**Why:** the preview should match the export. Today the preview ignores a clip's selected audio stream (it plays the
file's first audio track, or the stream baked into the proxy), so on multi-stream originals you can hear a different
stream than the export renders. Still images other than PNG / JPEG / WebP / GIF / BMP show as missing in the Program
monitor. These are correctness gaps, so they come before large new features.
**Plan:** honour per-clip audio stream selection in the preview by proxying every audio stream or selecting
`audioTracks`. Show TIFF, HEIC, AVIF, JPEG XL and similar stills through a short image proxy (PNG) built on import.

## 3. Bitmap subtitle OCR (PGS / VobSub / DVB)

**Why:** Blu-ray and DVD rips usually carry their subtitles as images (PGS, VobSub, DVB), and transcript search
cannot read them today. OCR produces the same thing as speech-to-text, a searchable transcript track, but on these
sources it is cheaper than speech recognition and keeps the authored timing. It can ship before Whisper (§4).
**Why deferred:** OCR needs an engine and per-language trained data, and ReCut must stay offline and cloud-free.
Bitmap streams are refused by the subtitle import today.
**Plan:** a `TranscriptProvider` backed by a user-installed OCR engine (for example Tesseract), running as a
main-process job. FFmpeg decodes the bitmap stream to images with their display times, the engine reads each event,
and cues attach as a `SubtitleTrack` with `origin: 'ocr'`. Results are cached with the existing path + size + mtime
key plus stream index, engine and language.

## 4. Local speech-to-text (Whisper)

**Why:** transcript search is the fastest way to find a line across a whole franchise. Today it needs subtitle files.
Many sources have none, or only bitmap subtitles (see §3).
**Why deferred:** a good model is large (hundreds of MB to GB), GPU support varies by platform, and ReCut must stay
offline and cloud-free.
**Plan:** add a `TranscriptProvider` (`src/transcript/providers.ts`) backed by a user-installed `whisper.cpp` binary
and model, running as a main-process job (`JobKind: 'transcribe'` is already reserved). FFmpeg extracts 16 kHz mono
audio, progress streams back, and cues attach as a `SubtitleTrack` with `origin: 'whisper'`. The disabled
**Local Whisper** entry under Transcribe… is the placeholder.

## 5. Nested sequences and compound clips

**Why:** trilogy merges and franchise cuts are built from acts, episodes and reels. Without nesting, a ten-hour
merge is one flat timeline, and a reworked act cannot be dropped into several cuts as one item. For this kind of
editing nesting is basic organisation, not polish.
**Why deferred:** it touches almost everything: the preview player and planner (a clip whose source is a sequence),
the export graph (render the inner sequence, or flatten it into the outer graph), linked-clip sync, the out-of-sync
badge, transcript "on timeline" hits, the Compare diff, and any future interchange (§7).
**Plan:** a clip kind whose source is a `Sequence` id, with a cycle check and a depth limit.
Flatten nested sequences into the outer timeline in the planner and in `buildRenderGraph`, so preview and export
share one path and no intermediate render is needed. **Make Compound Clip** replaces a selection with a new
sequence and a single clip that points to it; **Open in Timeline** edits the inner sequence. Interchange exports
nested sequences as OTIO stacks, or flattens them for EDL.

## 6. Surround mixing beyond pass-through / downmix

**Why:** fan edits often mix 5.1 features with stereo deleted scenes. Today 5.1 can only be passed through or
downmixed.
**Why deferred:** surround needs a mixer UI, per-track meters and a panner, plus a WebAudio graph that keeps
6 channels end to end (proxies are stereo today).
**Plan:** an Audio Mixer panel for the Audio workspace, per-track meters (`AnalyserNode` taps already exist for the
master meter), stereo/5.1 panning per clip, and multichannel proxies.
**Quick utility, can ship first:** centre-channel extraction for 5.1 sources. Extract the centre (dialogue) channel
as its own audio clip, choose which source channel a mono clip uses, and set a controlled stereo downmix (centre and
surround levels) instead of FFmpeg's default. It is cheap (FFmpeg `pan` / `channelsplit`) and useful on its own, but it
is not a substitute for stem separation (§10): the centre channel still carries music and effects.

## 7. Interchange: EDL, FCPXML, OpenTimelineIO

**Why:** to round-trip with Resolve or Premiere for grading and finishing, and to share edit decisions without
sharing media.
**Why deferred:** the timeline model (rational fps, frames, centred transitions, clip-anchored cues) had to settle
first. **Plan:** export OTIO and CMX3600 EDL from `Sequence` (pure, in `shared/`), then import.

## 8. Intermediate and audio-only export

**Why:** round-tripping (§7) needs media the finishing tool can grade and mix: an edit-friendly intermediate rather
than a long-GOP MP4, and separate audio. Fan editors also hand the audio to a mixer or deliver a soundtrack-only
cut.
**Why deferred:** export is MP4 only (H.264 / H.265 with AAC / AC-3), and the export pipeline was being made
frame-exact and safe first.
**Plan:** ProRes (`prores_ks`) and DNxHR (`dnxhd`) in MOV, PCM audio in MOV, audio-only WAV (PCM) and other audio
containers, and per-track or per-stem export (one WAV per audio track, or per stem once §10 exists). The render graph
already builds video and audio separately; this adds containers, codecs and a "no video" mode.

## 9. Keyframes

**Why:** Ken Burns moves on stills, volume ducking under dialogue, and fades that are not linear.
**Why deferred:** keyframes touch the model, the Inspector, the canvas compositor and the FFmpeg graph (expressions
or `sendcmd`). Static transforms were made frame-exact first.
**Plan:** per-property keyframe lists on `ClipTransform` / `ClipAudio`, evaluated in the planner and emitted as
FFmpeg expressions.

## 10. Dialogue / music / effects stem separation

**Why:** fan editors work from a finished mix. Separate dialogue, music and effects stems let an editor cut dialogue
while the score and ambience carry across the cut, or replace the score under a scene.
**Why deferred:** stems are far more useful once there are meters, routing and automation, so this comes after the
mixer (§6) and keyframes (§9), and after the preview gaps (§2). A separation model is also the largest runtime
dependency ReCut would take on.
**Plan:** a main-process job that writes stems for a media file and caches them like proxies. The model needs no
change: `linkId` groups any number of clips, so a picture clip plus its stems is one linked group. Constraints:
- **No bundled Python by default.** Keep the engine behind an interface and run it as an isolated main-process job.
  Prefer a user-installed or standalone engine, as for Whisper (§4); a bundled Python + PyTorch worker would be the
  largest packaging cost in the app.
- **Do not hash whole source files.** Hashing a 40 GB remux is slow. Key the cache on the existing path + size +
  mtime key plus model, model version and settings.
- **Check both licences before shipping a model:** the code licence and the pretrained-weights licence, which can
  differ. Weights trained on a dataset may inherit the dataset's terms.

## 11. Colour tools

**Why:** matching shots from different releases (theatrical vs Blu-ray grades) is common in trilogy merges.
**Why deferred:** the preview is a Chromium 2D canvas. Real-time grading needs a WebGL/WebGPU compositor, and the
export needs the same maths in FFmpeg (`eq`, `colorbalance`, `lut3d`).
**Plan:** a WebGL compositor in `SequencePlayer`, basic lift/gamma/gain + saturation + LUT, with matching FFmpeg
filters.

## 12. GPU decode and preview

**Why:** 4K HEVC originals play only through proxies today.
**Why deferred:** Chromium's `<video>` cannot decode HEVC/AC-3 consistently on every platform, so proxies are the
portable answer. **Plan:** a WebCodecs-based decoder path where available, and hardware encoders (NVENC,
VideoToolbox, QSV) for proxies and export.

## 13. Multi-language subtitle authoring

**Why:** fan subs and translated releases. Today the Subtitles panel edits one track at a time.
**Plan:** a side-by-side track grid, per-track language and styling, ASS export, and timing tools (shift / stretch
a range, snap to shot changes using scene detection).

## 14. Collect / Consolidate Project

**Why:** archiving a finished edit, moving it to a new drive, or handing it to someone else means finding every
source file by hand today. Projects store absolute paths, so the copy then needs Relink.
**Plan:** **Collect Project…** copies the project file and every media file it uses (optionally only media used in
sequences, and optionally subtitle sidecars and proxies) into one folder, and saves the copy with paths rewritten to
that folder. It shares groundwork with relative media roots (§15). Derived media should survive the move: today the
cache key includes the absolute path, so thumbnails, waveforms and proxies are rebuilt after media moves
(see [LIMITATIONS](LIMITATIONS.md#projects)).

## 15. Cloud-free collaboration

**Why:** fan-edit teams split work by act or by character arc.
**Why deferred:** projects are single JSON files with absolute paths.
**Plan:** relative media roots per machine; mergeable project diffs built on the existing structural Compare diff;
continuity notes and story blocks as portable sidecar files that sync through Git or a shared folder. No ReCut
server.

## 16. Smaller items

- "Move / Slip into Sync" for out-of-sync linked clips.
- A **Build alternate cut without matching clips** button next to the What-if buttons (duplicate, ripple-delete
  matches, open Compare).
- Transcript hits flagged "on timeline" in every scope, not only Sequence scope.
- Code signing (Windows) and notarisation (macOS). Tested dmg and AppImage builds with bundled FFmpeg. The Windows
  installer and portable exe are already built, installed and smoke-tested in CI with FFmpeg bundled, but unsigned.
- Snapshots stored as diffs, to keep project files small.
- Titles / text generator.
