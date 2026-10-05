# Roadmap

None of the capabilities below exist in ReCut yet. They are deferred, not abandoned. Each entry says why it waited
and where it would plug in. For what works today, see the [README](../README.md). For current gaps and bugs, see
[LIMITATIONS](LIMITATIONS.md).

Order is rough priority for fan editing.

## 1. Local speech-to-text (Whisper)

**Why:** transcript search is the fastest way to find a line across a whole franchise. Today it needs subtitle files.
Many sources have none, or only bitmap subtitles.
**Why deferred:** a good model is large (hundreds of MB to GB), GPU support varies by platform, and ReCut must stay
offline and cloud-free.
**Plan:** add a `TranscriptProvider` (`src/transcript/providers.ts`) backed by a user-installed `whisper.cpp` binary
and model, running as a main-process job (`JobKind: 'transcribe'` is already reserved). FFmpeg extracts 16 kHz mono
audio, progress streams back, and cues attach as a `SubtitleTrack` with `origin: 'whisper'`. The disabled
**Local Whisper** entry under Transcribe… is the placeholder.

## 2. Fix the remaining preview gaps

**Why:** the preview should match the export. **Plan:** render still images in the Program monitor (an `<img>`
layer or a short image proxy). Honour per-clip audio stream selection in the preview by proxying every audio stream
or selecting `audioTracks`.

## 3. Surround mixing beyond pass-through / downmix

**Why:** fan edits often mix 5.1 features with stereo deleted scenes. Today 5.1 can only be passed through or
downmixed.
**Why deferred:** surround needs a mixer UI, per-track meters and a panner, plus a WebAudio graph that keeps
6 channels end to end (proxies are stereo today).
**Plan:** an Audio Mixer panel for the Audio workspace, per-track meters (`AnalyserNode` taps already exist for the
master meter), stereo/5.1 panning per clip, and multichannel proxies.

## 4. Interchange: EDL, FCPXML, OpenTimelineIO

**Why:** to round-trip with Resolve or Premiere for grading and finishing, and to share edit decisions without
sharing media.
**Why deferred:** the timeline model (rational fps, frames, centred transitions, clip-anchored cues) had to settle
first. **Plan:** export OTIO and CMX3600 EDL from `Sequence` (pure, in `shared/`), then import.

## 5. Keyframes

**Why:** Ken Burns moves on stills, volume ducking under dialogue, and fades that are not linear.
**Why deferred:** keyframes touch the model, the Inspector, the canvas compositor and the FFmpeg graph (expressions
or `sendcmd`). Static transforms were made frame-exact first.
**Plan:** per-property keyframe lists on `ClipTransform` / `ClipAudio`, evaluated in the planner and emitted as
FFmpeg expressions.

## 6. Colour tools

**Why:** matching shots from different releases (theatrical vs Blu-ray grades) is common in trilogy merges.
**Why deferred:** the preview is a Chromium 2D canvas. Real-time grading needs a WebGL/WebGPU compositor, and the
export needs the same maths in FFmpeg (`eq`, `colorbalance`, `lut3d`).
**Plan:** a WebGL compositor in `SequencePlayer`, basic lift/gamma/gain + saturation + LUT, with matching FFmpeg
filters.

## 7. GPU decode and preview

**Why:** 4K HEVC originals play only through proxies today.
**Why deferred:** Chromium's `<video>` cannot decode HEVC/AC-3 consistently on every platform, so proxies are the
portable answer. **Plan:** a WebCodecs-based decoder path where available, and hardware encoders (NVENC,
VideoToolbox, QSV) for proxies and export.

## 8. Multi-language subtitle authoring

**Why:** fan subs and translated releases. Today the Subtitles panel edits one track at a time.
**Plan:** a side-by-side track grid, per-track language and styling, ASS export, and timing tools (shift / stretch
a range, snap to shot changes using scene detection).

## 9. Cloud-free collaboration

**Why:** fan-edit teams split work by act or by character arc.
**Why deferred:** projects are single JSON files with absolute paths.
**Plan:** relative media roots per machine; mergeable project diffs built on the existing structural Compare diff;
continuity notes and story blocks as portable sidecar files that sync through Git or a shared folder. No ReCut
server.

## 10. Smaller items

- "Move / Slip into Sync" for out-of-sync linked clips.
- A **Build alternate cut without matching clips** button next to the What-if buttons (duplicate, ripple-delete
  matches, open Compare).
- Transcript hits flagged "on timeline" in every scope, not only Sequence scope.
- Bitmap subtitle OCR (PGS / VobSub → SRT).
- Signed and tested AppImage / dmg / nsis builds with bundled FFmpeg.
- Snapshots stored as diffs, to keep project files small.
- Titles / text generator. Nested sequences.
