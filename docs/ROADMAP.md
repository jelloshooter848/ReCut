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
| 19 | Official Linux and macOS releases | Done: Linux (0.6.1); macOS dmgs for Apple Silicon and Intel, signed and notarised (0.8.0) | 0.6.1 / 0.8.0 |
| 16 | Collect / Consolidate Project (with the moved-media cache fix) | Done | 0.7.0 |
| 5 | Local speech-to-text (Whisper) | Done | 0.8.0 |
| 6 | Intermediate and audio-only export | Done | 0.8.0 |
| 7 | MKV packaging export | Done | 0.8.0 |
| 9 | Surround: centre-channel and channel-selection utility (the mixer comes after 1.0) | Quick utility done | 0.8.0 |
| 11 | Keyframes, first version (position, scale, opacity, volume; linear and ease) | Done | 0.8.0 |
| 8 | Nested sequences and compound clips | Done | 0.8.0 |
| 10, 12–15, 17, 18 | Everything else | Not started; planned after 1.0 ([After 1.0](#after-10)) | — |
| 20 | Disc file import: unencrypted DVD-Video (VOB / VIDEO_TS) and Blu-ray (BDMV) folders and files | Not started; file-level parity planned before 1.0, titles and playlists after 1.0 | — |
| 21 | Plug-in / extension interface | Not started; planned after 1.0 ([After 1.0](#after-10)) | — |

Work outside the numbered entries is listed in [CHANGELOG](../CHANGELOG.md), for example the release gate (0.4.0),
the shipped licences (0.4.1) and the calibrated performance gate (0.5.0).

**Where things stand (8 October 2026):** every feature planned for 1.0 is done and was published together in
**0.8.0**, with the official, signed and notarised macOS downloads (§19). Next come the 1.0 release candidates
([Road to 1.0](#road-to-10)). §19 keeps its number, out of list order, so existing references stay valid.

## Road to 1.0

Decided by the project owner on 7 October 2026, from the review of "ReCut — Whisper Findings and Recommended Roadmap
to v1.0" and [the 1.0 definition report](../bugs/closed/2026-10-07-roadmap-no-1.0-definition.md).

**What 1.0 means:** ReCut is reliable for the workflow it was built for (restructuring finished films and television
at franchise scale), on Windows, Linux and macOS. It is not feature parity with Premiere Pro or DaVinci Resolve.

### Milestones

| Release | Milestone | Entries |
|---|---|---|
| 0.6.0 | Bitmap subtitle OCR | §4 (done) |
| 0.6.1 | Official Linux release (AppImage) | §19, Linux part (done) |
| 0.7.0 | Collect Project, the moved-media cache fix, the project compatibility promise and the update notice (all of 0.10.0, shipped early) | §16 (done), 0.10.0 (done) |
| 0.8.0 | Everything else for 1.0, in one release (owner's decision, 7 October 2026: "don't hold anything"): the official macOS release (Apple Silicon and Intel dmgs, signed and notarised), Delivery 1 (intermediates and audio), Delivery 2 (MKV packaging), local transcription (Whisper), nested sequences and compound clips, keyframes (first version) | §19 macOS part, §6 and the centre-channel utility from §9, §7, §5, §8, §11 (all done) |
| 0.10.0 | Portability and trust (done early, in 0.7.0) | §16 Collect / Consolidate, the [moved-media cache fix](../bugs/closed/2026-10-05-moved-media-cache-miss.md), the project compatibility promise and its tests, an update notice |
| before 1.0.0-rc.1 | Disc file import, file-level parity (owner's decision, 9 October 2026; moves to 1.1 if it threatens the release candidates) | §20 file-level part |
| 1.0.0-rc.N | Feature freeze, release candidates | see below |
| 1.0.0 | Stable release | |

Version numbers after 0.6.1 are the plan, not a promise: a bug-fix release in between takes the next PATCH number,
and a milestone that ships early or late moves its number with it. The milestones first planned as 0.8.0, 0.9.0,
0.11.0, 0.12.0 and 0.13.0, and the macOS release, were combined into 0.8.0 once all of them were built.

**Required for 1.0:** cross-platform releases, both delivery milestones, portability and trust, nested sequences.
**Strongly preferred:** local transcription. **First to move to 1.1 if 1.0 needs cutting:** keyframes; then local
transcription, if it threatens stability or platform support. No optional milestone holds 1.0 back indefinitely.
All of them shipped in 0.8.0; what remains before 1.0 is the release candidates.

**Portability and trust (planned as 0.10.0, shipped in 0.7.0) includes:**
- **Project compatibility promise:** every 1.x release opens projects saved by earlier stable releases, or refuses
  them with a clear message, never silently damaging them. Projects saved by each stable release (0.3.0 onwards) are
  kept as test fixtures and opened by CI on every build; `normalizeProject()` gets real migrations when
  `formatVersion` first changes.
- **Update notice:** checks the latest GitHub release and says when a newer version exists, with an opt-out in
  Preferences. No auto-update (as in §19).

### Release candidates (1.0.0-rc.1, rc.2, …)

Feature freeze: only fixes for release-blocking defects. Each candidate is a real release on the Releases page,
marked as a pre-release. Work for the candidates:
- macOS signing and notarisation (with the Developer ID of the owner's brother; set up for 0.8.0).
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
- Everything in [After 1.0](#after-10) below.

## After 1.0

Decided by the project owner on 7 October 2026. **Principle:** finish what 1.0 started before opening large new
areas, and let the owner's real-media testing and the first outside users steer 1.1. **Cadence:** a release as soon
as each milestone is done (as before 1.0), with PATCH releases for fixes in between. Version numbers are the plan,
not a promise, as for the Road to 1.0.

| Release | Milestone | Entries |
|---|---|---|
| 1.0.x | Fixes found by the release candidates and the first users, starting with the open bugs in `bugs/open/`. On the 1.0 release day, apply to a free open-source code signing programme (SignPath Foundation) for Windows | §18 (Windows signing) |
| 1.1.0 | Polish what shipped | §18 smaller items (Move / Slip into Sync, Build alternate cut without matching clips, transcript hits on timeline in every scope, MP4 with more than one audio track and soft subtitles); keyframes v2 (rotation and crop keyframes, dragging keyframe diamonds on the timeline); the nested-sequence follow-ups (inner chapters and subtitles on export as an option, opacity applied to the composite, speed on nested clips) |
| 1.2.0 | Subtitle authoring | §15: the next need once OCR (§4) and Whisper (§5) produce subtitles is fixing their text and timing |
| 1.3.0 | Audio mixer | §9 (mixer panel, per-track meters, stereo / 5.1 panning, multichannel proxies; track volume automation built on keyframes) |
| 1.4.0 | Interchange | §10 (export OTIO and CMX3600 EDL, nested sequences included; import afterwards) |
| 1.5.0 | Dialogue / music / effects stems | §12 (after the mixer; starts with an engine and licence spike) |
| 1.6.0 | GPU picture | §13 and the titles generator (§18) on one WebGL compositor; §14 (hardware encoders for proxies and export, WebCodecs decode) |
| 2.0.0 | Cloud-free collaboration | §17. It needs the first change to the project format (`formatVersion` 2: relative media roots, sidecar files), which the compatibility promise ties to a MAJOR release |
| any | Linux packages | More package formats (Flatpak, .deb) when asked for (§19) |
| not scheduled | Disc titles and playlists (added 9 October 2026) | §20 follow-up: title and chapter choice from IFO / MPLS, joined VOBs and m2ts clips, multi-angle and branching titles |
| not scheduled | Plug-in / extension interface (added 9 October 2026) | §21 |

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
**Scheduled:** before nested sequences (§8) (project owner's decision, 7 October 2026; see
[Road to 1.0](#road-to-10)); planned as 0.11.0, shipped in 0.8.0 with the rest of the 1.0 features. Strongly preferred for 1.0, second to move to 1.1 if 1.0 needs cutting.
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
**Status: done (7 October 2026, release 0.8.0).** The engine is whisper.cpp
1.9.5 (`whisper-cli`, CPU, about 10 MB with five CPU-variant kernels picked at run time; Metal on Apple Silicon),
compiled in CI from the pinned, SHA-256-checked source (`scripts/whisper-source.mjs`, `scripts/{linux,windows,mac}/
get-whisper.*`) and bundled like FFmpeg. Seven models (tiny, base, base.en, small, small.en, medium, large-v3-turbo;
78 MB to 1.6 GB), pinned to one Hugging Face commit with size and SHA-256 (`shared/whisper.ts`), are installed from
**File › Transcription Models…** or Preferences through the shared verified downloader (`electron/net/download.ts`,
redirects only to Hugging Face's storage host). **Transcribe with Whisper…** (Transcript › Import › Transcribe… ›
Local Whisper…, or the Project panel's media menu) queues a `transcribe` job per media (own lane, cancellable,
chunked at quiet moments for bounded memory, cached) and adds a track named "English (Whisper Small)" with
`origin: 'whisper'`. The macOS build steps are written (`scripts/mac/get-whisper.sh`) but wait for the macOS CI job;
no model was downloaded during development (the network policy blocked Hugging Face), so the pins were cross-checked
against three independent projects and real-model recognition is tested only in CI.
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
**Status: done (7 October 2026, release 0.8.0).** Export › Format offers MP4, MOV (ProRes Proxy / LT / 422 / HQ /
4444 with `prores_ks`, DNxHR LB / SQ / HQ / HQX / 444 with `dnxhd`, PCM 16- or 24-bit audio), WAV and FLAC (audio
only, the mix or one file per audio track, sample-aligned and the length of the range); the file extension follows
the format, and settings saved before load as MP4. Formats and encoder arguments live in `shared/exportFormat.ts`.
Not done: per-stem export (needs §12), MKV (§7), and a higher-precision compositing path for 10-bit / 4:2:2 sources
(see [LIMITATIONS](LIMITATIONS.md#export)).

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
**Status: done (7 October 2026, release 0.8.0).** Export › Format › **MKV** (FFmpeg's Matroska muxer) writes H.264 /
H.265 with any number of audio tracks, each a mix definition (which sequence audio tracks, stereo / 5.1 / mono, AAC /
AC-3 / FLAC / PCM, language, title; the first is the default; presets "Main mix only", "5.1 + stereo downmix", "Main
+ commentary"), all sample-exact and the same length; the sequence's subtitle tracks as soft SubRip streams with
language, title and Default / Forced flags; chapters as in MP4; no metadata from the sources. Settings without the
new fields export one main mix, as before. Plan and arguments in `shared/exportFormat.ts` (`audioOutputPlan`,
`subtitleOutputPlan`), the mixes in `electron/export/renderGraph.ts`. Not done: several audio tracks or soft
subtitles in MP4 (FFmpeg's MP4 muxer drops the titles), ProRes / DNxHR in MKV, ASS styling, audio passthrough (see
[LIMITATIONS](LIMITATIONS.md#export)).

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
**Status: done (7 October 2026, release 0.8.0).** A clip with `sequenceId` plays a project
sequence (`formatVersion` stays 1; cycles and nesting deeper than 8 levels are refused by every command and cut by
`normalizeProject`). `flattenSequence` in `shared/nest.ts` expands nested clips into media clips (inner time at the
outer frame rate, composed transforms, multiplied gains, transitions at nested edges as alpha / gain ramps) and is the
one path both the preview planner and the export render graph render, memoized per sequence. Commands, each one undo
step: **Make Compound Clip**, **Open in Timeline** (double-click), **Break Apart Compound Clip**, and nesting a sequence
by dropping it on the timeline or Project panel › **Nest in Active Sequence**. Edits inside show everywhere the
sequence is nested; a shorter inner sequence leaves the rest of the nested clip black and silent. Walkers: export
(nested audio belongs to its outer track for per-track files and MKV output tracks; chapters and subtitles come from
the outer sequence only), Export Checks, Match Frame and the SRC timecode through to the media, transcript "on
timeline" hits, the Compare diff and link sync (a nested clip is one clip), Collect Project, the Inspector, the
timeline's NEST badge, the scene library (refused). Tests: `tests/unit/nest*.test.ts` (nested vs flat timelines in the
planner, the segment plan and real FFmpeg renders, including an fps mismatch and dissolves at the boundaries),
`tests/e2e/nest.spec.ts`, and nesting in the compatibility fixture scenario. Interchange (§10) has not shipped, so it
needs nothing yet. Limits: [LIMITATIONS](LIMITATIONS.md) › Editing.

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
**Status: quick utility done (7 October 2026, release 0.8.0); the mixer is not started and is planned after 1.0.**
Clip Inspector › Audio › **Channels** plays a multichannel clip's normal mix, one source channel as mono (named from
the ffprobe layout, numbered when it is unknown) or a stereo downmix with centre and surround levels (BS.775
defaults, LFE left out); **Extract Centre Channel (Dialogue)** (clip context menu, **Clip** menu) adds a linked
"(centre)" clip on a free track below, one undo step. The export applies a FFmpeg `pan` filter first in the clip's
audio chain (`shared/audioChannels.ts`); the preview plays the same filter's output from a per-(stream, selection)
audio file made from the original (`electron/media/channelProxy.ts`), so AC-3 / DTS sources preview correctly. What
remains of this entry: the Audio Mixer panel, per-track meters, panning and multichannel proxies.

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
**Status: first version done (7 October 2026, release 0.8.0).** Position, scale,
opacity (`ClipTransform.keyframes`) and level (`ClipAudio.keyframes`) take keyframes in clip-relative frames with
Linear or Ease (smoothstep), evaluated by `shared/keyframes.ts` in the preview and the export; the Inspector adds,
edits, steps through and clears them at the playhead (one undo step each) and the timeline shows them as diamonds.
The export places keyed motion per frame with `perspective`, keyed opacity with `sendcmd` + `lut` and keyed level
with `volume` every 256 samples, measured against the evaluator with real FFmpeg. Still to come: rotation and crop
keyframes, Bézier / hold interpolation, dragging keyframes on the timeline, and a graph editor.

## 12. Dialogue / music / effects stem separation

**Why:** fan editors work from a finished mix. Separate dialogue, music and effects stems let an editor cut dialogue
while the score and ambience carry across the cut, or replace the score under a scene.
**Why deferred:** stems are far more useful once there are meters, routing and automation, so this comes after the
mixer (§9) and keyframes (§11), and after the preview gaps (§2). A separation model is also the largest runtime
dependency ReCut would take on.
**Plan:** a main-process job that writes stems for a media file and caches them like proxies. The model needs no
change: `linkId` groups any number of clips, so a picture clip plus its stems is one linked group. Constraints:
- **Engine built in, models downloaded on request**, as for OCR (§4) and Whisper (§5) (project owner's decision,
  7 October 2026): a native engine (no Python, no PyTorch) ships inside the app, adding roughly 20–50 MB, and
  models are installed on request from pinned URLs checked against a fixed SHA-256. The engine stays behind an
  interface and runs as an isolated main-process job. The release starts with a short spike to choose the engine
  and check model licences.
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
**Status: done (7 October 2026, release 0.7.0).** **File › Collect Project…** copies the project and its media
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
  with FFmpeg bundled, but unsigned. Planned for the 1.0 release day: apply to a free open-source signing programme
  (SignPath Foundation; see [After 1.0](#after-10)). macOS signing and notarisation are part of §19.
- Snapshots stored as diffs, to keep project files small.
- Titles / text generator.
- **More than one audio track and soft subtitles in MP4** (project owner's request, 7 October 2026; after 1.0). MKV
  export already has them (§7) and the render graph already builds every output track, so this is mostly muxing: per-track
  language and title metadata and `mov_text` subtitles. Limits to design around: FFmpeg's MP4 muxer does not keep track
  titles or the default flag on every version, and many players only play an MP4's first audio track.

## 19. Official Linux and macOS releases

**Status: done.** Linux done (release 0.6.1); macOS done (8 October 2026, release 0.8.0, signed and notarised
dmgs for Apple Silicon and Intel). Scheduled by the project owner on 7 October 2026 (it was parked at the bottom until then), next after Bitmap
subtitle OCR (§4, 0.6.0); the order was Linux first, then macOS once signing was in place (planned for 0.7.0, now
part of 0.8.0). Source of the decision: the owner's review of the "ReCut Cross-Platform Release Support Proposal". The
section keeps its number because other documents and bug files cite § numbers.
**Linux part done (7 October 2026, release 0.6.1):** the x86-64 AppImage
`ReCut-<version>-linux-x86_64.AppImage` with a bundled BtbN `linux64-gpl` FFmpeg and its `FFMPEG-LICENSE.txt` /
`FFMPEG-BUILD.txt` (`scripts/linux/get-ffmpeg.sh`; the BtbN builds have no readme), listed in
`THIRD_PARTY_NOTICES.md`; the blocking `linux` job in `.github/workflows/windows.yml` on `ubuntu-22.04` (unit tests,
e2e under xvfb, packaging, AppImage smoke test mounted and extracted), which the `publish` job needs; the AppImage
attached to the release with run instructions in the notes.
**macOS part done (8 October 2026, release 0.8.0):** two dmgs, both
macOS 12+ (owner's decision, 8 October 2026; Intel support may be retired after 1.0): `ReCut-<version>-macos-arm64.dmg`
for Apple Silicon and `ReCut-<version>-macos-x64.dmg` for Intel, each with its own architecture's bundled, pinned and
checksum-verified jellyfin-ffmpeg build of the same release (`macarm64-gpl` / `mac64-gpl`) and its
`FFMPEG-LICENSE.txt` / `FFMPEG-BUILD.txt` (`scripts/mac/get-ffmpeg.sh --arch`) and speech-to-text engine (Metal on
arm64; CPU-only with CPU-variant kernels on x64, `scripts/mac/get-whisper.sh --arch`), no universal binary, hardened
runtime with only the `allow-jit` entitlement, and the blocking `macos` (a matrix over arm64 and x64, both on
`macos-14`; the x64 leg runs under Rosetta 2, never on Intel hardware) and `macos-e2e` (arm64 only) jobs in
`.github/workflows/windows.yml` (unit tests, dmg, per-binary signature and architecture checks, smoke test of the app
in the mounted dmg; artifacts `ReCut-macos-arm64` and `ReCut-macos-x64`; Developer ID signing and notarization of
both with the five secrets of `docs/MACOS-SIGNING.md`, which a release run requires, ad-hoc signed test builds
without them). Both jobs are in the `publish` job's `needs`, and both dmgs are attached to the release with a
which-dmg line in the notes.
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

## 20. Disc file import (DVD-Video and Blu-ray folders and files)

**Why:** fan edits start from DVDs and Blu-rays, and many editors keep them as unencrypted DVD-Video (VOB / VIDEO_TS)
and Blu-ray (BDMV) folders and files. ReCut opens the Blu-ray stream files today (`m2ts` / `mts` are in the Import
dialog's Video list), but `vob` is in no import list (`VIDEO_EXTS`, `src/state/parseIdentity.ts`), so the dialog shows
VOBs only under **All files**; `.IFO` / `.BUP` files dropped with them become items with an **Error** badge (FFprobe
refuses them); and there is no folder import that finds the media inside `VIDEO_TS` or `BDMV`.
**ReCut never decrypts discs.** It reads only unencrypted DVD-Video (VOB / VIDEO_TS) and Blu-ray (BDMV) folders and
files that the bundled FFmpeg already opens, as the README's Legal section says.
**Parity** means a disc file behaves as an MPEG-TS / M2TS file does today: import (Import dialog, drag and drop, folder
import), probe, preview through the automatic proxy (Chromium decodes none of MPEG-2, VC-1, AC-3, DTS or LPCM), scene
detection, every audio stream, VobSub and PGS read with OCR (§4), frame-accurate export, Collect Project and Relink.
**Measured (9 October 2026)** against the bundled FFmpeg builds (configuration and component lists of all three:
Windows gyan.dev 9.0.2 essentials, Linux BtbN 9.0.2, macOS jellyfin-ffmpeg 8.1.3; ReCut's probe, proxy, scene, OCR
and export code run with BtbN 9.0.2 and with jellyfin-ffmpeg 8.1.3's Linux build) on generated media: a VOB with
MPEG-2, 5.1 and stereo AC-3 and VobSub; the same title split as a disc splits it (`VTS_01_1.VOB` / `VTS_01_2.VOB`, at
a 2048-byte pack boundary inside a GOP); a VOB of two separately authored cells; a `BDMV/STREAM/00001.m2ts` with
H.264, AC-3, LPCM and PGS; a `VIDEO_TS` with IFO / BUP files.
- Every build has the `mpeg` and `mpegts` demuxers and the MPEG-2, VC-1, AC-3, E-AC-3, DTS, TrueHD, LPCM, VobSub and
  PGS decoders. The title readers do not: the `dvdvideo` demuxer (libdvdnav / libdvdread) is only in the Linux build,
  the `bluray:` protocol (libbluray) only in the Linux and macOS builds.
- A whole-title VOB and the m2ts work with no new code: probe (every stream, 8:9 pixel aspect), proxy with every
  audio stream, the same scene cuts and exported frames as an MKV remux of the same streams, and VobSub / PGS events on
  their authored times.
- What breaks: (1) a file that starts inside a GOP (`VTS_01_2.VOB`, a cut m2ts) has video that starts after the
  container start, and a clip whose video gets its own FFmpeg input exports its picture that much early (21 frames on
  the VOB, 5 on the m2ts). Today's `.ts` files have the same bug (video 0.5 s after audio: 12 frames early when the
  video has its own input, exact when linked picture and sound share one, exact in an MKV remux), so it is fixed
  first. (2) The default probe window misses a VobSub stream whose first subtitle comes late in the file. (3) A VOB
  whose timestamps restart probes as 20 s of its 60 s and exports black past those 20 s. (4) Every disc names its
  pieces `VTS_01_1.VOB`, `VTS_01_2.VOB`, … and full pieces are usually the same size, so Relink › **Search
  folder…** (name + size) cannot tell two discs apart.
**Plan, before 1.0 (file-level parity, one slice):** `vob` in the import lists and `docs/FORMATS.md`; **Import
Folder…** and dropping a folder, which walk it (the Relink folder walk in `electron/fs.ts`) and import the title VOBs
of a `VIDEO_TS` (`VTS_nn_1.VOB` onwards, not the menu VOBs) and the `BDMV/STREAM` m2ts files (not `BACKUP`), named
after the disc folder; `.IFO`, `.BUP`, `.mpls` and `.clpi` skipped with one message; fixes (1) to (4): the probed
container start passed to FFmpeg for MPEG-TS / PS inputs, a wider probe window for both, a warning for timestamp
restarts (Media Inspector, Export checks), Relink preferring the candidate under the same disc folder; tests on
generated media and an e2e folder import. The shipped FFmpeg builds only, no native library, no new npm dependency.
About the size of the stills work (#42: 22 files, about 1,500 lines with tests); smaller than MKV packaging (#70).
**After 1.0 (follow-up):** title and chapter choice from IFO / MPLS; a title's VOBs or a playlist's m2ts clips joined
into one media item (each later VOB starts inside a GOP, so its first part-second has no picture: 0.87 s in the
test); remuxing files with timestamp restarts; multi-angle and seamless-branching titles, which need the disc's
navigation data. FFmpeg's title readers would need other builds on Windows and macOS, so this means IFO / MPLS readers
of ReCut's own and a media item that spans files (Collect, Relink, the cache key and the probe all change).
**Done when:** VOBs and BDMV m2ts files, imported one by one or as a disc folder, pass the parity list above on
Windows, Linux and macOS with the bundled FFmpeg.
**Status: planned (before 1.0, the owner's decision of 9 October 2026: before 1.0 if file-level parity is not too much
work, which the measurement above shows); not started.** If it threatens the release candidates it moves to 1.1.

## 21. Plug-in / extension interface

**Why:** some tools help a few editors but do not belong in ReCut itself: an importer or exporter for a niche format,
a house naming scheme, a batch job, a panel for one workflow. A defined interface lets people build and share them
as add-ons without forking ReCut, and keeps the core small.
**Why deferred:** an interface is a promise. It should expose store actions and job kinds that have settled (after
1.0 and its first milestones), and it needs a permission model before code from outside the project runs.
**Plan:** a versioned add-on API.
- **What an add-on can add:** menu commands (with shortcuts), panels registered like the built-in ones
  (`registerPanel`), import and export steps (a file type that becomes media, a format the Export dialog offers), and
  background jobs in the jobs queue with progress and Cancel.
- **Project access through store actions only:** an add-on reads the project and changes it only by calling the
  store's actions (`src/state/store.ts`), the ones the UI calls; it never mutates the project. Each change is an undo
  step, and save, autosave, recovery and the project compatibility promise keep working.
- **Install, enable, disable:** add-ons are installed from a local folder or file into ReCut's user-data folder,
  listed with name, version and permissions, enabled or disabled one by one, and removed. A project that used a
  disabled or removed add-on still opens.
- **Local, with shown permissions:** add-ons run locally, isolated from ReCut's own code, with no network access.
  Each declares what it needs (read the project, change it, files the user picks, FFmpeg through the jobs queue);
  ReCut shows that before enabling it and grants nothing else.
- **Stability:** the API has its own version (SemVer). An add-on states the range it needs and ReCut refuses one it
  cannot serve, with a clear message. Within a major version the API only grows; removals wait for the next major
  and are announced in the CHANGELOG.
- **The core stays complete:** every built-in feature works with no add-ons installed, and an add-on that fails is
  disabled with a message instead of breaking the app.
**Done when:** an example add-on adds a command, a panel, an export step and a job, changes the project through store
actions with undo, and installs, enables, disables and uninstalls cleanly on Windows, Linux and macOS; ReCut with no
add-ons passes the same suites as before.
**Status: planned (after 1.0); not started.**

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
  sponsor. macOS releases are signed and notarised from 0.8.0 (§19). Confirmed by the owner on 8 October 2026:
  apply on the 1.0 release day, not earlier.
- **Interchange stays after nesting**, including export-only CMX3600 EDL (proposed for the delivery milestone in the
  1.0 review): it would have to be reworked for nested sequences.
- **One release for the rest of 1.0 (7–8 October 2026).** Once everything planned for 1.0 was built, the project
  owner combined the remaining milestones (0.8.0 to 0.13.0) and the macOS release into one release, 0.8.0, instead
  of releasing them one by one ("don't hold anything"). macOS ships as two downloads, Apple Silicon and Intel (owner's
  decision, 8 October 2026; Intel support may be retired after 1.0).
- **After 1.0 (7 October 2026).** The project owner adopted the [After 1.0](#after-10) plan: polish first (1.1),
  then subtitle authoring (1.2) ahead of the mixer, because OCR and Whisper output needs fixing tools; the mixer
  before stems, as decided before; interchange once nesting has shipped; one WebGL compositor for colour, titles and
  speed; collaboration as 2.0 because it changes the project format. Releases go out as each milestone is done.
