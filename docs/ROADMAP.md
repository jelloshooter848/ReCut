# Roadmap

None of the capabilities below exist in ReCut yet. They are deferred, not abandoned. Each entry says why it waited
and where it would plug in. For what works today, see the [README](../README.md). For current gaps and bugs, see
[LIMITATIONS](LIMITATIONS.md).

Order is rough priority for fan editing: restructuring finished films and series at franchise scale. Entries 1 and
2 are gates rather than capabilities: they come before the next large feature. Why some entries sit where they do is
recorded under [Ordering decisions](#ordering-decisions) at the end.

## 1. Performance at franchise scale

**Why:** ReCut is for franchise-scale work: thousands of timeline clips, thousands of scenes, multi-hour
sequences. Before this work, re-measured on 5 October 2026 with the 2,500-clip, 60-media project from the
performance attack, playback, search and autosave met their budgets, but every edit took 80–120 ms from commit to
paint (budget 32 ms), scrubbing at working zoom ran at 32–35 fps (budget 50), and opening the project froze the window
for about 3 s. Every new feature adds work to the same commit and render path, so this came first.
**Why deferred:** the first round of fixes (in-place playhead, unmounted hidden panels, level-of-detail lane,
virtualized lists, idle autosave, chunked export) went in on 4 October 2026, and the benchmarks had not been re-run
until now.
**Plan:** treat `tests/perf` as a gate: `npm run perf:check` runs both perf suites and sorts every budgeted row into
user-facing gates (pass/fail), architecture guardrails (fail on a material regression against
`tests/perf/baseline.json`) and diagnostic microbenchmarks (reported with their trend, never blocking); see
`docs/DEVELOPMENT.md` → Performance gate (measurements of 6 October 2026 in
`bugs/closed/2026-10-05-perf-budgets-2500-clips.md`; compare medians of two or more runs). Remove the remaining
per-frame clip re-renders when scrubbing, keep edit commit → paint under 32 ms, and move project open / save / clone
off the renderer's main thread (compact JSON built off-thread, one `normalizeProject` pass). The benches also cover a 3 h, 6,700-clip sequence at 23.976 fps
(`buildLongSequence` in `tests/perf/bigProject.mjs`). Re-run the perf, attack and acceptance suites before each large
feature below.
**Done when:** All franchise-scale user-facing performance gates pass, no architecture guardrail shows an
unexplained material regression, and diagnostic microbenchmarks remain reported for trend analysis.
**Status: done (7 October 2026, release 0.3.0).** The final gate (`npm run perf:check -- --runs 2` on bd60227)
passes 98 of 98 gates and 130 of 130 guardrails in both runs; the 3 h sequence scrubs at about 59 fps at 1 px/frame,
edits paint in 17–28 ms, save takes 214–249 ms and open 714–808 ms. Record and before/after table:
`bugs/closed/2026-10-05-perf-budgets-2500-clips.md`. Two deliberate rendering trade-offs were approved for it (waveform
bars, composited playhead; `docs/attack/performance.md`).
**Future architecture trigger:** incremental persistence (saving only what changed) or a different project
representation becomes worth doing when a measurable trigger is hit, for example the end-to-end save or open gate
fails at the franchise-scale project size, or the project file grows past about 100 MB. That is a decision driven by
scale, not work required to make the old whole-project microbenchmarks (stringify, parse, clone ≤ 100 ms) pass.

## 2. Fix the remaining preview gaps

**Why:** the preview should match the export. Today the preview ignores a clip's selected audio stream (it plays the
file's first audio track, or the stream baked into the proxy), so on multi-stream originals you can hear a different
stream than the export renders. Still images other than PNG / JPEG / WebP / GIF / BMP show as missing in the Program
monitor. These are correctness gaps, so they come before large new features.
**Plan:** honour per-clip audio stream selection in the preview by proxying every audio stream or selecting
`audioTracks`. Show TIFF, HEIC, AVIF, JPEG XL and similar stills through a short image proxy (PNG) built on import.
**Status: done (7 October 2026, release 0.4.0).** The preview plays each clip's selected audio stream, as the export
does: Chromium's `audioTracks` (the `AudioVideoTracks` Blink feature) picks the track of a directly played file, and
proxies carry every audio stream (`<key>_<h>p_all.mp4`; when FFmpeg cannot proxy one stream, the decodable ones, then
the selected one alone). Clip Inspector › Audio › **Stream** picks a clip's stream; the Source monitor and the
waveforms follow the selected stream. Every still FFmpeg decodes previews in the Source and Program monitors, from a
PNG proxy made on import when Chromium cannot draw it (TIFF, TGA, EXR, PSD, JPEG XL, AVIF, HEIC, ...). What remains
depends on the FFmpeg build (HEIC needs 7.1 or later) and is listed in [LIMITATIONS](LIMITATIONS.md). Finding M-05 of
the media attack is resolved.

## 3. Pre-export warnings

**Why:** a fan edit can take hours to export, and several common mistakes only show up when the result is watched: a
source at a different frame rate from the sequence (frames dropped or repeated), variable-frame-rate media (timing
drift), linked picture and sound knocked out of sync, and transitions that render shorter than set, or not at all,
because the source has no frames past the clip. ReCut already detects most of these, but not where the export dialog
looks.
**Why deferred:** the export pipeline was being made frame-exact and safe first. Once it is, these checks are small.
**Plan:** extend the export dialog's existing checklist (`exportChecklist` in `src/panels/export/settings.ts`, which
already reports an empty sequence, missing, offline or unanalysed media, an invalid frame rate, upmixed 5.1 and
missing subtitle tracks) instead of adding a panel. Each new item is a warning, not an error, and names the clips or
media involved:
- **Source frame rate differs from the sequence.** The probe records each source's rate (`probe.video.fps`,
  `electron/media/probe.ts`) and `fpsEquals` (`shared/time.ts`) compares rates. Today the only comparison is the
  conform prompt on the first edit into an empty sequence (`conformTargetFor`, `src/panels/source/insert.ts`).
- **VFR media in the sequence.** The probe sets `isVfr` (`electron/media/probe.ts`). The Media Inspector and the
  Project panel's info footer flag it; export does not.
- **Out-of-sync linked clips.** `linkedSyncOffsets` (`src/panels/timeline/clipBadges.ts`) already computes the
  offsets for the timeline's out-of-sync badge.
- **Transitions without enough source handles.** `buildRenderGraph` (`electron/export/renderGraph.ts`) already
  computes the handles, drops or shortens such transitions, and warns when a clip runs past the end of its media, but
  these warnings reach the user only as a toast after the export finishes. Move the handle calculation into a pure
  function in `shared/` that both the render graph and the checklist call, so the dialog shows the same result before
  export. The limit applied while editing (`transitionLimit`, `shared/timeline.ts`) checks clip length only, not the
  source media past the clip's ends.

Not in the first version: abrupt level jumps at cuts and subtitle timing drift. Both need analysis passes over the
media.

## 4. Bitmap subtitle OCR (PGS / VobSub / DVB)

**Why:** Blu-ray and DVD rips usually carry their subtitles as images (PGS, VobSub, DVB), and transcript search
cannot read them today. OCR produces the same thing as speech-to-text, a searchable transcript track, but on these
sources it is cheaper than speech recognition and keeps the authored timing. It can ship before Whisper (§5).
**Why deferred:** OCR needs an engine and per-language trained data, and ReCut must stay offline and cloud-free.
Bitmap streams are refused by the subtitle import today.
**Plan:** a `TranscriptProvider` backed by a user-installed OCR engine (for example Tesseract), running as a
main-process job. FFmpeg decodes the bitmap stream to images with their display times, the engine reads each event,
and cues attach as a `SubtitleTrack` with `origin: 'ocr'`. Results are cached with the existing path + size + mtime
key plus stream index, engine and language.

## 5. Local speech-to-text (Whisper)

**Why:** transcript search is the fastest way to find a line across a whole franchise. Today it needs subtitle files.
Many sources have none, or only bitmap subtitles (see §4).
**Why deferred:** a good model is large (hundreds of MB to GB), GPU support varies by platform, and ReCut must stay
offline and cloud-free.
**Plan:** add a `TranscriptProvider` (`src/transcript/providers.ts`) backed by a user-installed `whisper.cpp` binary
and model, running as a main-process job (`JobKind: 'transcribe'` is already reserved). FFmpeg extracts 16 kHz mono
audio, progress streams back, and cues attach as a `SubtitleTrack` with `origin: 'whisper'`. The disabled
**Local Whisper** entry under Transcribe… is the placeholder.

## 6. Intermediate and audio-only export

**Why:** round-tripping (§10) needs media the finishing tool can grade and mix: an edit-friendly intermediate rather
than a long-GOP MP4, and separate audio. Fan editors also hand the audio to a mixer or deliver a soundtrack-only
cut.
**Why deferred:** export is MP4 only (H.264 / H.265 with AAC / AC-3), and the export pipeline was being made
frame-exact and safe first.
**Plan:** ProRes (`prores_ks`) and DNxHR (`dnxhd`) in MOV, PCM audio in MOV, audio-only WAV (PCM) and other audio
containers, and per-track or per-stem export (one WAV per audio track, or per stem once §12 exists). The render graph
already builds video and audio separately; this adds containers, codecs and a "no video" mode.

## 7. MKV packaging export

**Why:** fan edits are usually delivered as MKV with chapters, more than one audio track (for example 5.1 plus a
stereo downmix, or a commentary) and soft subtitle tracks. ReCut exports MP4 only, and the export settings force the
file name to `.mp4` (`withMp4` in `src/panels/export/settings.ts`), so packaging is a second pass in MKVToolNix
today.
**Why deferred:** chapters are no longer the blocker. Since 0.2.0 the sequence's Chapter markers are exported as MP4
chapters and no metadata is copied from the sources (see [the export chapter / metadata
bug](../bugs/closed/2026-10-05-export-ignores-chapter-markers-copies-source-metadata.md) and [the first-chapter-break
fix](../bugs/closed/2026-10-06-first-chapter-break-lost-and-stale-roadmap.md)), and an MKV export would write the same
chapters (`exportChapters`). What packaging still needs: there is no container option and the export settings force
`.mp4` (`withMp4` in `src/panels/export/settings.ts`); export mixes everything to one audio track; subtitles are only
burned in or written as a sidecar file, never as a soft subtitle track.
**Plan:** an MKV container option in the export settings, with the file extension following it instead of forced
`.mp4`. Chapters as in MP4 export. One audio track per selected mix (for example 5.1 plus a stereo downmix, or a
commentary), each with its own language and title. Subtitle tracks are muxed as soft subtitles instead of only burned
in or written as a sidecar. Use FFmpeg's Matroska muxer, not `mkvmerge`, so there is no new dependency. It must work
with a user-installed FFmpeg: FFmpeg is bundled only in the Windows builds (see
[LIMITATIONS](LIMITATIONS.md#platform-and-packaging)).

## 8. Nested sequences and compound clips

**Why:** trilogy merges and franchise cuts are built from acts, episodes and reels. Without nesting, a ten-hour
merge is one flat timeline, and a reworked act cannot be dropped into several cuts as one item. For this kind of
editing nesting is basic organisation, not polish.
**Why deferred:** it touches almost everything: the preview player and planner (a clip whose source is a sequence),
the export graph (render the inner sequence, or flatten it into the outer graph), linked-clip sync, the out-of-sync
badge, transcript "on timeline" hits, the Compare diff, and interchange (§10).
**Plan:** a clip kind whose source is a `Sequence` id, with a cycle check and a depth limit.
Flatten nested sequences into the outer timeline in the planner and in `buildRenderGraph`, so preview and export
share one path and no intermediate render is needed. **Make Compound Clip** replaces a selection with a new
sequence and a single clip that points to it; **Open in Timeline** edits the inner sequence. Interchange exports
nested sequences as OTIO stacks, or flattens them for EDL. If interchange (§10) has shipped by then, it must be
extended for nesting as part of this work.

## 9. Surround mixing beyond pass-through / downmix

**Why:** fan edits often mix 5.1 features with stereo deleted scenes. Today 5.1 can only be passed through or
downmixed.
**Why deferred:** surround needs a mixer UI, per-track meters and a panner, plus a WebAudio graph that keeps
6 channels end to end (proxies are stereo today).
**Plan:** an Audio Mixer panel for the Audio workspace, per-track meters (`AnalyserNode` taps already exist for the
master meter), stereo/5.1 panning per clip, and multichannel proxies.
**Quick utility, can ship first:** centre-channel extraction for 5.1 sources. Extract the centre (dialogue) channel
as its own audio clip, choose which source channel a mono clip uses, and set a controlled stereo downmix (centre and
surround levels) instead of FFmpeg's default. It is cheap (FFmpeg `pan` / `channelsplit`) and useful on its own, but it
is not a substitute for stem separation (§12): the centre channel still carries music and effects.

## 10. Interchange: EDL, FCPXML, OpenTimelineIO

**Why:** to round-trip with Resolve or Premiere for grading and finishing, and to share edit decisions without
sharing media.
**Why deferred:** the timeline model (rational fps, frames, centred transitions, clip-anchored cues) had to settle
first. It stays after nesting (§8) because few fan editors round-trip, and interchange must represent nesting anyway.
**Plan:** export OTIO and CMX3600 EDL from `Sequence` (pure, in `shared/`), then import.

## 11. Keyframes

**Why:** Ken Burns moves on stills, volume ducking under dialogue, and fades that are not linear.
**Why deferred:** keyframes touch the model, the Inspector, the canvas compositor and the FFmpeg graph (expressions
or `sendcmd`). Static transforms were made frame-exact first.
**Plan:** per-property keyframe lists on `ClipTransform` / `ClipAudio`, evaluated in the planner and emitted as
FFmpeg expressions. The first version covers opacity, volume, position and scale, with linear and ease
interpolation. Rotation, crop, audio level curves and a graph editor follow later.

## 12. Dialogue / music / effects stem separation

**Why:** fan editors work from a finished mix. Separate dialogue, music and effects stems let an editor cut dialogue
while the score and ambience carry across the cut, or replace the score under a scene.
**Why deferred:** stems are far more useful once there are meters, routing and automation, so this comes after the
mixer (§9) and keyframes (§11), and after the preview gaps (§2). A separation model is also the largest runtime
dependency ReCut would take on.
**Plan:** a main-process job that writes stems for a media file and caches them like proxies. The model needs no
change: `linkId` groups any number of clips, so a picture clip plus its stems is one linked group. Constraints:
- **No bundled Python by default.** Keep the engine behind an interface and run it as an isolated main-process job.
  Prefer a user-installed or standalone engine, as for Whisper (§5); a bundled Python + PyTorch worker would be the
  largest packaging cost in the app.
- **Do not hash whole source files.** Hashing a 40 GB remux is slow. Key the cache on the existing path + size +
  mtime key plus model, model version and settings.
- **Check both licences before shipping a model:** the code licence and the pretrained-weights licence, which can
  differ. Weights trained on a dataset may inherit the dataset's terms.

## 13. Colour tools

**Why:** matching shots from different releases (theatrical vs Blu-ray grades) is common in trilogy merges.
**Why deferred:** the preview is a Chromium 2D canvas. Real-time grading needs a WebGL/WebGPU compositor, and the
export needs the same maths in FFmpeg (`eq`, `colorbalance`, `lut3d`).
**Plan:** a WebGL compositor in `SequencePlayer`, basic lift/gamma/gain + saturation + LUT, with matching FFmpeg
filters.

## 14. GPU decode and preview

**Why:** 4K HEVC originals play only through proxies today.
**Why deferred:** Chromium's `<video>` cannot decode HEVC/AC-3 consistently on every platform, so proxies are the
portable answer. **Plan:** a WebCodecs-based decoder path where available, and hardware encoders (NVENC,
VideoToolbox, QSV) for proxies and export.

## 15. Multi-language subtitle authoring

**Why:** fan subs and translated releases. Today the Subtitles panel edits one track at a time.
**Plan:** a side-by-side track grid, per-track language and styling, ASS export, and timing tools (shift / stretch
a range, snap to shot changes using scene detection).

## 16. Collect / Consolidate Project

**Why:** archiving a finished edit, moving it to a new drive, or handing it to someone else means finding every
source file by hand today. Projects store absolute paths, so the copy then needs Relink.
**Plan:** **Collect Project…** copies the project file and every media file it uses (optionally only media used in
sequences, and optionally subtitle sidecars and proxies) into one folder, and saves the copy with paths rewritten to
that folder. It shares groundwork with relative media roots (§17). Derived media should survive the move: today the
cache key includes the absolute path, so thumbnails, waveforms and proxies are rebuilt after media moves
(see [LIMITATIONS](LIMITATIONS.md#projects)).

## 17. Cloud-free collaboration

**Why:** fan-edit teams split work by act or by character arc.
**Why deferred:** projects are single JSON files with absolute paths.
**Plan:** relative media roots per machine; mergeable project diffs built on the existing structural Compare diff;
continuity notes and story blocks as portable sidecar files that sync through Git or a shared folder. No ReCut
server.

## 18. Smaller items

- "Move / Slip into Sync" for out-of-sync linked clips.
- A **Build alternate cut without matching clips** button next to the What-if buttons (duplicate, ripple-delete
  matches, open Compare).
- Transcript hits flagged "on timeline" in every scope, not only Sequence scope.
- Code signing (Windows) and notarisation (macOS). Tested dmg and AppImage builds with bundled FFmpeg. The Windows
  installer and portable exe are already built, installed and smoke-tested in CI with FFmpeg bundled, but unsigned.
- Snapshots stored as diffs, to keep project files small.
- Titles / text generator.

## 19. macOS build (.dmg) with each 0.X.0 release

**Status:** parked at the bottom by the project owner (7 October 2026) until they decide where it goes.
**Why:** ReCut ships only Windows builds. `package.json` → `build.mac` already targets `dmg`, and the app has macOS
menu and quit handling, but no Mac build has ever been made or tested.
**Plan (unsigned first, about 3–5 h):** a `macos-latest` job in `.github/workflows/windows.yml` (or a sibling
workflow) for releases only, not dev builds, since GitHub bills macOS minutes at 10× on private repos. It builds a
universal or arm64 + x64 dmg, bundles static `ffmpeg` / `ffprobe` for both architectures, smoke-tests the app
(launch, FFmpeg encode and probe; ideally the e2e suite) and joins the publish job's `needs`, so a red Mac build
blocks the release like any other gate. Unsigned apps need right-click › **Open** on first launch; Apple Silicon
also needs the ad-hoc signature electron-builder applies by default.
**Later, optional:** signing and notarisation (an Apple Developer account at $99 a year, certificates and an
app-specific password as GitHub secrets, about 2–3 h more), only if the Mac build is for other people. This
overlaps the code-signing line in §18.

## Ordering decisions

Recorded so they are not re-proposed without new information.

- **Delivery before nesting.** Intermediate and audio-only export (§6) and MKV packaging (§7) come before nested
  sequences (§8), by the project owner's decision on 5 October 2026. Both are export-side and fairly self-contained;
  nesting touches the preview, export, sync, Compare and interchange.
- **Interchange after nesting.** EDL / FCPXML / OTIO (§10) stays after nested sequences (§8): few fan editors
  round-trip, and interchange has to represent nesting anyway.
- **Rejected: Match Frame and "promote a range to the scene library".** Already built. Match Frame is a command on
  the F key; the Scenes panel has **New scene from clip** and **New scene from Source In/Out**.
- **Rejected: raise the performance gate to 5,000+ clips now.** Premature until the 2,500-clip project meets its edit,
  scrub and open budgets (§1). A multi-hour sequence is already part of §1.
- **Rejected: nested sequences ahead of OCR.** OCR (§4) is cheap and self-contained and unblocks transcript search
  on most Blu-ray and DVD rips. Nesting is the most invasive entry on the list.
