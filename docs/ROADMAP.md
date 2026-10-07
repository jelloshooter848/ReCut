# Roadmap

Entries marked **done** have shipped; the table below shows where each one stands. Every other entry does not exist
in ReCut yet: it is deferred, not abandoned, and says why it waited and where it would plug in. For what works today,
see the [README](../README.md). For current gaps and bugs, see [LIMITATIONS](LIMITATIONS.md).

Order is rough priority for fan editing: restructuring finished films and series at franchise scale. Entries 1 and
2 are gates rather than capabilities: they come before the next large feature. Why some entries sit where they do is
recorded under [Ordering decisions](#ordering-decisions) at the end.

## Progress

Updated with every feature PR (the PR that lands an entry sets its row and the entry's **Status** line) and checked
in every release PR (docs/RELEASING.md).

| § | Entry | Status | Release |
|---|---|---|---|
| 1 | Performance at franchise scale | Done | 0.3.0 |
| 2 | Fix the remaining preview gaps | Done | 0.4.0 |
| 3 | Pre-export warnings | Done | 0.5.0 |
| 4 | Bitmap subtitle OCR (PGS / VobSub / DVB) | Done | 0.6.0 |
| 19 | Official Linux and macOS releases | In progress: Linux AppImage and CI gate implemented (ships in 0.6.1); macOS next | 0.6.1 (Linux), 0.7.0 (macOS) |
| 5–18 | Everything else | Not started | — |

Work outside the numbered entries is listed in [CHANGELOG](../CHANGELOG.md), for example the release gate (0.4.0),
the shipped licences (0.4.1) and the calibrated performance gate (0.5.0).

**Scheduled next after §4:** official Linux and macOS releases (§19) follow Bitmap subtitle OCR (§4, release 0.6.0):
**Linux in 0.6.1, macOS in 0.7.0** (project owner's decision, 7 October 2026). §19 keeps its number, out of list
order, so existing references stay valid.

## Road to 1.0

Decided by the project owner on 7 October 2026, from the review of "ReCut — Whisper Findings and Recommended Roadmap
to v1.0" and [the 1.0 definition report](../bugs/closed/2026-10-07-roadmap-no-1.0-definition.md).

**What 1.0 means:** ReCut is reliable for the workflow it was built for (restructuring finished films and television
at franchise scale), on Windows, Linux and macOS. It is not feature parity with Premiere Pro or DaVinci Resolve.

### Milestones

| Release | Milestone | Entries |
|---|---|---|
| 0.6.0 | Bitmap subtitle OCR | §4 (done) |
| 0.6.1 | Official Linux release (AppImage) | §19, Linux part |
| 0.7.0 | Official macOS release (dmg, signed and notarised) | §19, macOS part |
| 0.8.0 | Delivery 1: intermediates and audio | §6 (ProRes, DNxHR, WAV / audio-only, one file per audio track) and the centre-channel utility from §9 |
| 0.9.0 | Delivery 2: MKV packaging | §7 (MKV, more than one audio track, soft subtitle tracks, chapters) |
| 0.10.0 | Portability and trust | §16 Collect / Consolidate, the [moved-media cache fix](../bugs/closed/2026-10-05-moved-media-cache-miss.md), the project compatibility promise and its tests, an update notice |
| 0.11.0 | Local transcription (Whisper) | §5 |
| 0.12.0 | Nested sequences and compound clips | §8 |
| 0.13.0 | Keyframes, first version | §11 (position, scale, opacity, volume) |
| 1.0.0-rc.N | Feature freeze, release candidates | see below |
| 1.0.0 | Stable release | |

Version numbers after 0.6.1 are the plan, not a promise: a bug-fix release in between takes the next PATCH number,
and a milestone that ships early or late moves its number with it.

**Required for 1.0:** cross-platform releases, both delivery milestones, portability and trust, nested sequences.
**Strongly preferred:** local transcription. **First to move to 1.1 if 1.0 needs cutting:** keyframes; then local
transcription, if it threatens stability or platform support. No optional milestone holds 1.0 back indefinitely.

**Portability and trust (0.10.0) includes:**
- **Project compatibility promise:** every 1.x release opens projects saved by earlier stable releases, or refuses
  them with a clear message, never silently damaging them. Projects saved by each stable release (0.3.0 onwards) are
  kept as test fixtures and opened by CI on every build; `normalizeProject()` gets real migrations when
  `formatVersion` first changes.
- **Update notice:** checks the latest GitHub release and says when a newer version exists, with an opt-out in
  Preferences. No auto-update (as in §19).

### Release candidates (1.0.0-rc.1, rc.2, …)

Feature freeze: only fixes for release-blocking defects. Each candidate is a real release on the Releases page,
marked as a pre-release. Work for the candidates:
- macOS signing and notarisation (with the Developer ID of the owner's brother, set up in 0.7.0).
- Package checks on Windows, Linux and macOS; the full unit and end-to-end suites on each.
- Opening every saved-project fixture; save, autosave and recovery tests; Collect round trips.
- A real-media test pass by the owner: real Blu-ray and DVD rips (OCR on real disc subtitles, 5.1 sources,
  multi-hour sequences), from import to export, on each platform available.
- The performance gate on the reference machine.
- Documentation and LIMITATIONS checked against the app.
- At least one week of normal use of the candidate without a release-blocking discovery.

### Ready for 1.0

1.0.0 ships when all of these hold:
1. No known data-loss or project-corruption defect.
2. No known preview or export correctness defect in a supported workflow.
3. The Windows, Linux and macOS release gates are green.
4. Every saved-project fixture opens; save, autosave and recovery tests pass.
5. Install and launch checks pass on every platform.
6. The owner's real-media test pass is complete, and Collect is verified on real projects.
7. The performance gate passes.
8. The documentation matches the app, and LIMITATIONS is current.
9. A release candidate has been in normal use for at least a week without a release-blocking discovery.

### Not required for 1.0

- **Windows code signing.** Windows builds stay unsigned through 1.0, so SmartScreen warns on first launch (the
  release notes and install guide explain **More info › Run anyway**). The owner will not pay for a certificate for a
  free project. After 1.0, apply to a free open-source signing programme (for example SignPath Foundation) or accept
  a sponsor. macOS is different: an unsigned app is much harder to open there, and signing costs the project nothing.
- After 1.0: the full surround mixer (§9), interchange (§10, after nesting), stem separation (§12), colour tools
  (§13), GPU decode (§14), multi-language subtitle authoring (§15), collaboration (§17), advanced keyframe curves,
  titles, and more Linux package formats.

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
**Status: done (7 October 2026, release 0.5.0).** The Export dialog's Checks list warns, for the clips the export
renders in the chosen range, about video at another frame rate than the sequence, VFR media, out-of-sync linked
clips, transitions dropped or shortened for lack of source handles (with the set and rendered lengths) and clips past
the end of their media; each names the first three media or clips and has a **Show** link to the timeline. The
segment and handle planning moved from `buildRenderGraph` into `shared/exportPlan.ts`, which both call, so the dialog
predicts what the export renders (its output is unchanged; a 1,500-sequence parity test checks the prediction
against the filter graph).

## 4. Bitmap subtitle OCR (PGS / VobSub / DVB)

**Why:** Blu-ray and DVD rips usually carry their subtitles as images (PGS, VobSub, DVB), and transcript search
cannot read them today. OCR produces the same thing as speech-to-text, a searchable transcript track, but on these
sources it is cheaper than speech recognition and keeps the authored timing. It can ship before Whisper (§5).
**Why deferred:** OCR needs an engine and per-language trained data, and ReCut must stay offline and cloud-free.
Bitmap streams are refused by the subtitle import today.
**Plan:** an OCR engine built into ReCut, with languages installed from inside the app, running as a main-process
job. FFmpeg decodes the bitmap stream to images with their display times, the engine reads each event, and cues
attach as a `SubtitleTrack` with `origin: 'ocr'`. Results are cached with the existing path + size + mtime key plus
stream index, engine and language.
**Status: done (7 October 2026, release 0.6.0).** **Read with OCR…** (Transcript › Import › Embedded…, the Project
panel's Embedded Subtitles, Transcript › Import › Transcribe… › Read bitmap subtitles (OCR)…) turns a PGS, VobSub, DVB
or XSUB stream into a subtitle track named "English (OCR #3)" that Transcript search finds. The engine is Tesseract
compiled to WebAssembly (tesseract.js 7.0.0, about 5.9 MB in the app, no native program); languages (57, pinned
`tessdata_fast` files with SHA-256) are installed in the app from **File › OCR Languages…** or from the OCR dialog,
and OCR then runs offline. Reading runs as an `ocr` job on the background lane (a pool of up to 3 worker threads);
results are cached per file, stream, language file and engine core, so a re-run is instant and replaces the earlier
track. On generated fixtures character accuracy is 100 % (PGS, VobSub, DVB, XSUB, 17 lines each) and a 1,500-event
PGS stream reads in about 28 s on 4 cores (99.96 %). Teletext and ARIB captions are not supported.

## 5. Local speech-to-text (Whisper)

**Why:** transcript search is the fastest way to find a line across a whole franchise. Today it needs subtitle files.
Many sources have none, or only bitmap subtitles (see §4).
**Why deferred:** a good model is large (hundreds of MB to GB), GPU support varies by platform, and ReCut must stay
offline and cloud-free.
**Scheduled:** release 0.11.0, before nested sequences (§8) (project owner's decision, 7 October 2026; see
[Road to 1.0](#road-to-10)). Strongly preferred for 1.0, second to move to 1.1 if 1.0 needs cutting.
**Plan:** the same model as OCR (§4): **engine built in, models downloaded on request.**
- **Engine:** a CPU build of `whisper.cpp` (a few MB) ships inside the app for each platform (Metal on Apple Silicon
  where it helps), so it is signed with the app on macOS and nothing executable is ever downloaded. No GPU-vendor
  builds (CUDA) in the first version.
- **Models:** none in the installer. Preferences and the Transcribe… dialog list the models (for example base, small,
  medium, large-v3-turbo, with their sizes); each is downloaded only when the user asks, from a pinned URL checked
  against a fixed SHA-256, with progress, resume, Cancel, Remove and Install from file…, through the OCR downloader
  (`electron/ocr/download.ts`) and the jobs network lane. Models live in ReCut's user-data folder, so updates keep
  them.
- **Transcribing:** a `TranscriptProvider` (`src/transcript/providers.ts`) running as a main-process job
  (`JobKind: 'transcribe'` is already reserved), queued and cancellable like any job. FFmpeg extracts 16 kHz mono
  audio, progress streams back, and the cues become an ordinary `SubtitleTrack` with `origin: 'whisper'`, so
  transcript search, jump-to-source and series search treat it like imported or OCR subtitles. Results are cached by
  source, model (with its hash) and settings; reading the same media again is instant. Transcription never uses the
  network.
- The disabled **Local Whisper** entry under Transcribe… is the placeholder.
**Done when:** ReCut can transcribe media locally into the transcript that search and navigation already use, on
Windows, Linux and macOS, with no model in the installer.

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
**Status: done (7 October 2026, release 0.10.0).** **File › Collect Project…** copies the project and its media
(media used in sequences, or all project media; optionally subtitle files and ready proxies) into
`<destination>/<Project name>/` (`Media/`, `Subtitles/`, `Proxies/`), as a cancellable job with byte progress that
verifies each copy (size and fingerprint) and writes the project, with absolute paths rewritten to the copies, last.
Same-named files from different folders get distinguishing subfolders; offline media are skipped with a warning; a
failed or canceled collect leaves the folder marked `COLLECT-INCOMPLETE.txt` and never touches the originals. The
derived-media cache is now keyed by content (size + sampled fingerprint, with the old path key still read), which
closes the [moved-media cache bug](../bugs/closed/2026-10-05-moved-media-cache-miss.md). Paths stay absolute (§17).

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
- Code signing (Windows). The Windows installer and portable exe are already built, installed and smoke-tested in CI
  with FFmpeg bundled, but unsigned. The Linux AppImage is built and tested in CI with FFmpeg bundled (§19); a tested
  dmg build with bundled FFmpeg, and macOS signing and notarisation, are planned in §19.
- Snapshots stored as diffs, to keep project files small.
- Titles / text generator.

## 19. Official Linux and macOS releases

**Status:** scheduled by the project owner on 7 October 2026 (it was parked at the bottom until then), next after
Bitmap subtitle OCR (§4, 0.6.0). Order: **Linux first, in 0.6.1; macOS in 0.7.0.** Source of the decision: the owner's
review of the "ReCut Cross-Platform Release Support Proposal". The section keeps its number because other documents
and bug files cite § numbers.
**Linux part implemented, pending release 0.6.1** (not done until 0.6.1 is published): the x86-64 AppImage
`ReCut-<version>-linux-x86_64.AppImage` with a bundled BtbN `linux64-gpl` FFmpeg and its `FFMPEG-LICENSE.txt` /
`FFMPEG-BUILD.txt` (`scripts/linux/get-ffmpeg.sh`; the BtbN builds have no readme), listed in
`THIRD_PARTY_NOTICES.md`; the blocking `linux` job in `.github/workflows/windows.yml` on `ubuntu-22.04` (unit tests,
e2e under xvfb, packaging, AppImage smoke test mounted and extracted), which the `publish` job needs; the AppImage
attached to the release with run instructions in the notes. The macOS part has not started.
**Why:** ReCut ships only Windows builds. `package.json` → `build.linux` already targets `AppImage` and `build.mac`
`dmg`, and the app has macOS menu and quit handling, but neither package has been released or tested: the Linux
unpacked build is what the test suites run on, and no Mac build has ever been made. Fan editors work on all three
platforms.
**Why deferred:** the Windows release path (bundled FFmpeg with its licence files, install checks, the four release
gates in `docs/RELEASING.md`) had to be solid first, and a macOS release needs signing that only an Apple Developer
account can provide.
**Plan, 0.6.1, Linux:**
- An x86-64 **AppImage** with a bundled, known FFmpeg / FFprobe build, shipped with its licence and source
  information as the Windows bundle is: `FFMPEG-LICENSE.txt`, `FFMPEG-README.txt` (when the build has one) and
  `FFMPEG-BUILD.txt` (where the build came from, its version and how to get its source), listed in
  `THIRD_PARTY_NOTICES.md`.
- A **Linux CI job**: unit tests, the e2e suite under xvfb, packaging, then launching the AppImage and a smoke test
  (FFmpeg found, probe and encode). It joins the release gate (the `publish` job's `needs`) and is **blocking once
  Linux is official**, like the Windows gates.
- **Clear asset names** on the release page, so Windows, Linux and macOS downloads cannot be confused.
**Plan, 0.7.0, macOS:**
- A **.dmg**, **Apple Silicon first**; Intel or a universal build too if practical.
- A bundled **arm64 FFmpeg / FFprobe** with the same licence and source files. **Main risk:** sourcing a relocatable
  arm64 static FFmpeg build whose licence and source can be documented as for Windows and Linux.
- A **macOS CI job** (build, tests, package, launch and smoke test): **advisory during bring-up, blocking once macOS
  is official.** macOS runner minutes are billed at a higher rate, so it runs for releases rather than every build if
  that becomes a cost problem.
- **Signing and notarization** with a Developer ID belonging to someone the owner trusts (the owner's brother has an
  Apple Developer account). Plan: CI secrets holding a Developer ID Application certificate (`.p12` and its password)
  and an App Store Connect API key for notarization. **Until it is signed, the .dmg is a test build**, published with
  first-launch instructions (right-click › **Open**, or allow it under System Settings › Privacy & Security).
**Out of scope** for both: `.deb`, `.rpm`, Flatpak, Snap, the Mac App Store, auto-update, and ARM Linux.
**Done when:** 0.6.1 publishes a Linux AppImage with bundled FFmpeg and its licence files, gated by a blocking Linux
CI job; 0.7.0 publishes a macOS .dmg with bundled arm64 FFmpeg, signed and notarized (or labelled a test build with
first-launch instructions until it is), with the macOS job blocking once the platform is official.

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
- **Cross-platform releases next after OCR.** Official Linux (0.6.1) and macOS (0.7.0) releases (§19) come right
  after Bitmap subtitle OCR (§4, 0.6.0), by the project owner's decision on 7 October 2026 (review of the
  "ReCut Cross-Platform Release Support Proposal"). Linux goes first: the test suites already run on Linux and it
  needs no signing; the macOS risks are an arm64 FFmpeg build with documented licence and source, and signing.
- **Rejected: nested sequences ahead of OCR.** OCR (§4) is cheap and self-contained and unblocks transcript search
  on most Blu-ray and DVD rips. Nesting is the most invasive entry on the list.
- **The 1.0 plan (7 October 2026).** The project owner adopted the [Road to 1.0](#road-to-10) milestones from the
  review of "ReCut — Whisper Findings and Recommended Roadmap to v1.0", with three changes to that review: local
  transcription bundles its engine and downloads only models (as OCR does) instead of downloading the engine too;
  delivery is two releases (intermediates and audio first, then MKV packaging), because MKV with several audio tracks
  needs export mixes the model does not have yet; and local transcription comes before nested sequences, because it
  reuses the OCR downloader, jobs and cache and does not depend on nesting.
- **Windows code signing after 1.0.** The owner will not pay for a certificate for a free project (7 October 2026).
  Windows builds stay unsigned through 1.0; after 1.0, apply to a free open-source signing programme or accept a
  sponsor. macOS builds are signed from 0.7.0.
- **Interchange stays after nesting**, including export-only CMX3600 EDL (proposed for the delivery milestone in the
  1.0 review): it would have to be reworked for nested sequences.
