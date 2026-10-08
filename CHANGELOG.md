# Changelog

All notable changes to ReCut are listed here, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow semantic versioning as described in
[docs/RELEASING.md](docs/RELEASING.md). The project file `formatVersion` is versioned separately and is unchanged
(still `1`) unless an entry says otherwise.

## [0.8.0] - 2026-10-08

Every feature planned for 1.0 ([Road to 1.0](docs/ROADMAP.md#road-to-10)), in one release: local speech-to-text,
intermediate and audio-only export, MKV with several audio tracks and soft subtitles, a centre-channel utility for
5.1 sources, nested sequences and compound clips, and keyframes. **ReCut is now released for macOS** (Apple Silicon
and Intel, signed and notarized), next to Windows and Linux. Project files stay `formatVersion` 1; projects from
earlier releases open unchanged.

### Added

- **Transcribe with Whisper…** (Transcript › Import › Transcribe…, or the Project panel's media menu) turns speech in
  a media file into a searchable transcript track ("English (Whisper Small)"), entirely on your computer. The engine
  (whisper.cpp) ships inside the app; models (tiny to large-v3-turbo, 78 MB to 1.6 GB) are downloaded only when you
  install one from **File › Transcription Models…** or Preferences, from pinned addresses checked against a fixed
  SHA-256. Transcription runs as a job you can cancel, never uses the network, and a second run of the same media is
  instant.
- **New export formats** (Export › Format): **MOV** with ProRes (Proxy, LT, 422, HQ, 4444) or DNxHR (LB, SQ, HQ, HQX,
  444) and PCM audio, for editing or grading elsewhere; **WAV** and **FLAC** audio-only export, as the mix or one file
  per audio track, sample-aligned and exactly the length of the range.
- **MKV export** with any number of audio tracks: each one a mix of the sequence audio tracks you choose (stereo, 5.1
  or mono; AAC, AC-3, FLAC or PCM; language and title), with presets **Main mix only**, **5.1 + stereo downmix** and
  **Main + commentary**. The sequence's subtitle tracks become soft subtitle tracks (language, title, Default and
  Forced flags), and chapters are written as in MP4.
- **Channel selection for 5.1 sources** (Inspector › Audio › Channels): play a clip's normal mix, one source channel
  as mono, or a stereo downmix with your own centre and surround levels. **Extract Centre Channel (Dialogue)** (Clip
  menu, clip context menu) adds the centre channel as its own linked clip. The preview plays exactly what the export
  writes, AC-3 and DTS sources included.
- **Nested sequences and compound clips.** **Make Compound Clip** turns the selected clips into a new sequence and
  puts one clip in their place; **Open in Timeline** (or double-click) edits it, and edits show everywhere it is used;
  **Break Apart Compound Clip** reverses it. Drag a sequence from the Project panel onto the timeline to nest it. A
  sequence can never contain itself. Preview and export render nested sequences through the same path, frame for
  frame.
- **Keyframes** for position, scale, opacity and volume (Inspector), with Linear or Ease, shown as diamonds on the
  timeline. They stay with the picture when you trim, split, roll or slide, work inside and on compound clips, and
  the export matches the preview (within a quarter of a pixel, 1.5 luma levels and 0.5 dB).
- **macOS downloads:** `ReCut-<version>-macos-arm64.dmg` for Apple Silicon Macs and `ReCut-<version>-macos-x64.dmg`
  for Intel Macs, macOS 12 or newer, signed with a Developer ID and notarized by Apple, so they open normally. Each
  bundles FFmpeg and the speech-to-text engine for its processor (on Intel Macs transcription runs on the CPU only and
  is slower). See [INSTALL](docs/INSTALL.md#macos) for which one to pick.

### Fixed

- Fades to and from black exported darker than the preview showed (up to 16 luma levels), and on upper tracks they
  covered the track below with black instead of fading the clip out
  ([report](bugs/closed/2026-10-07-export-fade-to-black-ends-early.md)).
- Transitions between two clips now export what the preview shows: a Cross Dissolve no longer dims halfway in the
  preview, and a Dip to Black exports as the preview shows it (each clip fades over its own half, without needing
  extra media past the cut; dips also export faster)
  ([report](bugs/closed/2026-10-08-two-sided-transition-preview-mismatch.md)).
- The Program monitor could briefly show the other clip's frame after a cut-back seek while paused, under load
  ([report](bugs/closed/2026-10-07-program-transient-stale-frame-before-present.md)).
- The Program monitor could keep showing the previous frame after a seek while paused
  ([report](bugs/closed/2026-10-07-program-stale-frame-after-seek.md)).
- Mono sources played 3 dB louder in the preview than in the export
  ([report](bugs/closed/2026-10-07-mono-preview-level.md)), and the Program monitor's peak meter always showed
  "unavailable" ([report](bugs/closed/2026-10-07-program-meter-always-unavailable.md)).
- Verified downloads (OCR languages, transcription models) failed on any HTTP redirect
  ([report](bugs/closed/2026-10-07-download-redirect-net-fetch-manual.md)).
- Double-clicking a clip on the timeline (open in Source, or open a compound clip) did not always register on
  Windows; double-clicks are now detected by the timeline itself.
- After a clean save and quit, the next launch could offer to recover an autosave anyway: an autosave still being
  written could finish after the save ([report](bugs/closed/2026-10-08-autosave-after-save-spurious-recovery.md)).

### Development

- The Windows, Linux and macOS builds compile whisper.cpp 1.9.5 from a pinned, checksum-verified source and bundle it
  like FFmpeg; the release workflow checks its size and that it starts. On macOS it is built without Accelerate's
  BLAS, whose interface needs macOS 13.3, so transcription works from macOS 12; the build fails if such an import
  returns.
- The macOS jobs (both dmgs and the macOS end-to-end tests) are now release gates next to Windows and Linux, and
  both dmgs are attached to the release. A release run fails unless both dmgs are signed with the Developer ID,
  notarized and stapled; test builds without the signing secrets stay ad-hoc signed.
- A thumbnail-cancel unit test waits for the real event instead of a timing assumption.
- A saved-project fixture for 0.8.0 (`tests/fixtures/projects/recut-0.8.0.recut`) with keyframes and nested sequences;
  older fixtures must open without either.
- The README has a Highlights section with six short demos and refreshed screenshots covering the 0.8.0 features,
  made from the Blender open movies Tears of Steel and Sintel (CC BY 3.0) by `scripts/readme-media.mjs` and the
  README media workflow ([docs/screenshots](docs/screenshots/README.md)). INSTALL, the README and LIMITATIONS
  describe the signed macOS downloads.
- No new npm dependencies.

### Known issues

- The Intel dmg is tested in CI only under Rosetta 2 on an Apple Silicon Mac; it has not run on an Intel Mac yet. See
  [LIMITATIONS](docs/LIMITATIONS.md#platform-and-packaging).
- Unchanged: unsigned Windows builds (SmartScreen warns on first start), NSIS 3.0.4 (CVE-2025-43715, only when an
  installer runs as SYSTEM).

## [0.7.0] - 2026-10-07

Portability and trust (the 0.10.0 milestone of the [Road to 1.0](docs/ROADMAP.md#road-to-10), shipped early): projects
move between drives and machines without rebuilding anything, every release keeps opening older projects, and ReCut
can tell you when a new version is out. Project files stay `formatVersion` 1.

### Added

- **File › Collect Project…** copies the project and the media it uses (only media in sequences, or all project media;
  optionally subtitle files and ready proxies) into one folder, `<destination>/<Project name>/`, and saves the copy
  with its paths pointing at the copies. Before copying it shows the total size against the free space and lists
  offline media; files with the same name from different folders get their own subfolders (`Media/Disc 1/…`,
  `Media/Disc 2/…`). Every copy is checked against the original. The copy runs as a job you can cancel; if it fails or
  is cancelled, a `COLLECT-INCOMPLETE.txt` file stays in the folder and your original project and media are never
  touched.
- **Update notice** (opt-in): on first start ReCut asks once whether it may check GitHub for a new version once a
  day. If you say yes and a newer release exists, a bar offers **Release notes** and **Skip this version**. Nothing is
  downloaded or installed automatically. **Help › Check for Updates…** checks once on demand; Preferences shows the
  setting and the last check. See [USER-GUIDE](docs/USER-GUIDE.md) for exactly what the check sends.

### Fixed

- Moving, renaming, copying or relinking media no longer rebuilds its thumbnails, filmstrip, waveform, proxy, scene
  cuts or OCR results: they are now keyed by the file's content (its size and a sample of its bytes, read once) instead
  of its path and modification time. Caches made by earlier versions are still found and reused
  ([report](bugs/closed/2026-10-05-moved-media-cache-miss.md)).

### Development

- **Compatibility promise** ([project-format](docs/project-format.md#compatibility-promise)): 1.x opens projects saved
  by every earlier stable release, or refuses them with a clear message, and never silently damages them. Projects
  saved by each release from 0.3.0 on (`tests/fixtures/projects/`, made by that release's own code) are opened on
  every build, and each release PR adds its own (`scripts/make-project-fixture.mjs`).
- **macOS:** the Apple Silicon dmg (`ReCut-<version>-macos-arm64.dmg`, macOS 12 or later, FFmpeg from jellyfin-ffmpeg
  8.1) is built, mounted and smoke-tested, and the end-to-end suite runs on macOS, on every build. These jobs are
  advisory and the dmg is not on the release page yet: it becomes official once it is signed and notarised
  ([signing guide](docs/MACOS-SIGNING.md)). Help › About › Licences finds the Electron and Chromium licences in the
  macOS app.
- CI: a stalled Ubuntu package mirror no longer holds up a release (the Linux AppImage smoke test runs extracted only,
  with a warning, when libfuse2 cannot be installed).

### Known issues

- Collect Project copies only (no move), cannot resume an interrupted copy, and cannot write files over 4 GB to a
  FAT32 drive. A media file edited in place without changing its size, where every change falls between the sampled
  blocks, keeps its old thumbnails and proxy until the cache folder is cleared. See [LIMITATIONS](docs/LIMITATIONS.md).
- Unchanged: unsigned builds (Windows SmartScreen warns on first start), NSIS 3.0.4 (CVE-2025-43715, only when an
  installer runs as SYSTEM), no macOS download yet.

## [0.6.1] - 2026-10-07

ReCut on Linux ([Roadmap](docs/ROADMAP.md) §19): an official x86-64 AppImage with FFmpeg built in, built and tested on
every release like the Windows downloads. No changes to editing features; project files stay `formatVersion` 1.

### Added

- **Linux download:** `ReCut-0.6.1-linux-x86_64.AppImage` on the release page, next to the Windows installer and
  portable exe. Make it executable (`chmod +x`) and run it; nothing to install. FFmpeg (GPL, with libx264) is
  built in, with its licence and source information (Help › About › Licences…). Needs a 64-bit Intel/AMD PC and glibc
  2.28 or newer (Debian 10, Ubuntu 18.10, RHEL 8 or later). If it says FUSE is missing, install `libfuse2`
  (`libfuse2t64` on Ubuntu 24.04 and later) or start it with `--appimage-extract-and-run`.
- Opening a `.recut` project from a Linux file manager (which passes a `file://` link) opens it.

### Development

- Every release now also needs the Linux gate to pass: unit and end-to-end tests on Ubuntu 22.04, the AppImage built
  with the bundled FFmpeg, and the AppImage launched (mounted and extracted) and smoke-tested. `scripts/linux/get-ffmpeg.sh`
  fetches and checks the FFmpeg build. Test builds keep the AppImage as the run's `ReCut-linux` artifact.

### Known issues

- The AppImage is about 240 MB (the Linux FFmpeg build is larger than the Windows one). AppImage only: no `.deb`,
  `.rpm`, Flatpak, Snap or ARM build, and it does not add itself to the application menu (an AppImage integration tool
  can). Tested on Ubuntu 22.04. See [LIMITATIONS](docs/LIMITATIONS.md).
- Unchanged from 0.6.0: moved media rebuilds its cache ([open report](bugs/closed/2026-10-05-moved-media-cache-miss.md)),
  unsigned builds, NSIS 3.0.4 (CVE-2025-43715, only when an installer runs as SYSTEM).

## [0.6.0] - 2026-10-07

Read image subtitles ([Roadmap](docs/ROADMAP.md) §4): the picture subtitles on Blu-ray and DVD rips (PGS, VobSub,
DVB, XSUB) become timed, searchable text tracks, read on your computer. Project files stay `formatVersion` 1 (subtitle
tracks gain an optional `streamIndex`).

### Added

- **Read with OCR…** for image subtitle streams: in Transcript › Import › Embedded…, the Project panel's Embedded
  Subtitles menu and Transcribe… › Read bitmap subtitles (OCR)…. Pick the language, and the job reads every subtitle
  with its timing into a track named for example "English (OCR #3)", which transcript search finds like any other.
  Reading the same stream again replaces that track (one undo step) and is instant from the cache.
- **OCR languages** (File › OCR Languages…, or Preferences): 57 languages, each installed on request from the
  Tesseract project's language data (about 0.4–8 MB each, checked against a fixed SHA-256), with progress, Cancel,
  Remove and Install from file…. The OCR engine is built in; nothing is downloaded until you install a language, and
  reading subtitles never uses the network.

### Changed

- Importing an image subtitle stream as text now offers **Read with OCR…** instead of telling you to convert it with
  another tool. DVB teletext and ARIB captions stay unsupported and say so.

### Fixed

- Scene detection on media longer than about 2 h 47 min put cuts up to several frames early (FFmpeg 6.1 printed the
  times rounded); previously detected results are recomputed
  ([report](bugs/closed/2026-10-07-scene-detect-pts-precision.md)).
- The job queue's count of running jobs left out language downloads.

### Development

- New runtime dependency: tesseract.js 7.0.0 (Apache-2.0). Only its two LSTM engine builds ship (about 5.8 MB, unpacked
  from the app archive); Windows CI fails if the OCR folder grows past 7 MB, and the smoke tests require the OCR engine
  to start in the unpacked, installed and portable builds. THIRD_PARTY_NOTICES lists Tesseract and the libraries in its
  engine build; Help › About › Licences… includes the Tesseract licence.
- The performance gate: a count guardrail with a baseline of 0 tolerates 1, and `npm run perf:compare` runs 3 times per
  side by default.
- The roadmap has a Progress table, updated by every feature PR and checked by every release PR.

### Known issues

- OCR accuracy is measured on generated subtitles (100 % on the test streams); italic, coloured and sign subtitles on
  real discs may read less well. See [LIMITATIONS](docs/LIMITATIONS.md).
- Unchanged: moved media rebuilds its cache ([open report](bugs/closed/2026-10-05-moved-media-cache-miss.md)), unsigned
  builds, NSIS 3.0.4 (CVE-2025-43715, only when an installer runs as SYSTEM).

## [0.5.0] - 2026-10-07

Pre-export warnings ([Roadmap](docs/ROADMAP.md) §3): the Export dialog points out, before a long export, the mistakes
that otherwise only show up when the result is watched. Project files are unchanged (`formatVersion` 1).

### Added

- **Pre-export warnings** in the Export dialog's Checks list:
  - video at a different frame rate from the sequence (frames are repeated or dropped);
  - variable-frame-rate (VFR) media;
  - linked picture and sound out of sync, with the offset in frames;
  - transitions that will be dropped or shortened, with the set and rendered lengths and the reason (for example,
    not enough source media past the cut);
  - clips that run past the end of their media.

  Each warning names the clips or media involved and has a **Show** link that selects them on the timeline. Warnings
  never block the export. The dialog uses the same transition calculation as the export, so it predicts exactly what
  the export renders.

### Fixed

- Window size and position are saved through the same one-at-a-time preferences queue as everything else, instead of a
  separate write on close that could collide with another preferences write.
- On Windows, saving a project or the preferences retries briefly when another program (for example an antivirus scan)
  holds the file and the final rename is refused.

### Development

- The performance gate (`npm run perf:check`) measures the machine's speed before each run (JavaScript, FFmpeg and
  rendering) and, when it differs from the reference machine by more than 10 %, judges time and frame-rate results on
  the reference machine's scale. It still prints the raw results, and shows the machine and its speed next to the
  baseline's. The same code now gets the same verdict on faster and slower hosts
  ([report](bugs/closed/2026-10-07-perf-gate-verdict-not-reproducible.md)). `tests/perf/baseline.json` (format 2) records
  the reference machine's speed and was re-seeded.
- New `npm run perf:compare -- <refA> <refB>`: compares two versions on the same machine, runs interleaved, and flags
  results that are worse beyond the noise.

### Known issues

- Unchanged: moved media rebuilds its cache ([open report](bugs/closed/2026-10-05-moved-media-cache-miss.md)), unsigned
  builds, NSIS 3.0.4 (CVE-2025-43715, only when an installer runs as SYSTEM).

## [0.4.1] - 2026-10-07

Licences: the Windows build now ships ReCut's licence and the bundled FFmpeg's licence and source information.
Project files are unchanged (`formatVersion` 1).

### Added

- **Help › About › Licences…** opens the licence files that ship with ReCut: ReCut's own (MIT), the third-party notices
  (FFmpeg, Electron / Chromium and the npm packages ReCut uses), the bundled FFmpeg's licence, readme and build
  information, and Electron's and Chromium's licences.

### Fixed

- The Windows build bundled FFmpeg without its licence or a pointer to its source code. It now ships
  `FFMPEG-LICENSE.txt`, `FFMPEG-README.txt` and `FFMPEG-BUILD.txt` (which FFmpeg build it is, and where to download its
  source), plus `LICENSE` and `THIRD_PARTY_NOTICES.md`
  ([report](bugs/closed/2026-10-07-bundled-ffmpeg-licence-not-shipped.md)).

### Known issues

- Unchanged from 0.4.0: the performance gate's verdict depends on the speed of the machine
  ([report](bugs/closed/2026-10-07-perf-gate-verdict-not-reproducible.md)), moved media rebuilds its cache
  ([open report](bugs/closed/2026-10-05-moved-media-cache-miss.md)), unsigned builds, NSIS 3.0.4 (CVE-2025-43715, only
  when an installer runs as SYSTEM).

## [0.4.0] - 2026-10-07

The preview matches the export ([Roadmap](docs/ROADMAP.md) §2): every clip plays the audio stream export renders,
and every still image FFmpeg can decode shows in the monitors. Project files are unchanged (`formatVersion` 1).

### Added

- **Per-clip audio stream:** Clip Inspector › Audio › **Stream** picks which audio stream of a multi-stream file a clip
  plays (undoable; linked clips follow).
- **Still images in every format FFmpeg reads** (TIFF, TGA, EXR, PSD, HEIC, AVIF, JPEG XL, DPX and more) preview in
  the Program and Source monitors from a PNG proxy made on import. The import dialog's Images filter and the Graphics
  bin accept all of them.

### Changed

- **The preview plays each clip's selected audio stream**, the same one export renders. It used to play the first
  stream (or the one stream baked into the proxy). The Source monitor plays the media's Audio stream, and waveforms
  show the selected stream.
- **Proxies carry every audio stream**, so changing a stream no longer rebuilds the proxy. When FFmpeg cannot proxy
  one stream, the proxy keeps the ones it can. Proxies from earlier versions are still used and rebuilt only when a
  clip needs a stream they lack.
- **An animated GIF is imported as a video**, so it plays in the preview as it does in the export.

### Fixed

- On Windows, opening a project at startup (double-clicking a `.recut` file or `--project`) or saving could fail with
  "EPERM … prefs.json" while ReCut was reading its preferences
  ([report](bugs/closed/2026-10-07-startup-open-fails-prefs-rename-windows.md)).
- Export failed for AVIF and single-frame GIF stills ("Option loop not found")
  ([report](bugs/closed/2026-10-07-still-export-loop-option-non-image2.md)).
- TGA, EXR, PSD and JPEG XL files were imported as zero-length videos, and AVIF as a playable video
  ([report](bugs/closed/2026-10-07-still-classifier-mismatch.md)).
- An EXIF-rotated JPEG got its sideways size ([report](bugs/closed/2026-10-07-exif-rotated-still-probe-size.md)).
- A rotated AVIF previewed rotated but exported unrotated
  ([report](bugs/closed/2026-10-07-avif-preview-orientation-differs-from-export.md)).

### Development

- Releases and dev prereleases publish only when the installer, unit, end-to-end and launcher jobs all pass on
  Windows ([report](bugs/closed/2026-10-07-release-publishes-on-red-tests.md)). 0.3.0 was published while the Windows
  end-to-end suite was red; that suite is fixed
  ([report](bugs/closed/2026-10-07-windows-program-e2e-failing-since-pr18.md)).

### Known issues

- HEIC needs FFmpeg 7.1 or later (the Windows build bundles 9.0.2). With FFmpeg 6.1, a rotated AVIF is unrotated in
  preview and export alike. See [LIMITATIONS](docs/LIMITATIONS.md).
- The bundled FFmpeg's licence is not yet shipped with the Windows build; 0.4.1 fixes this
  ([report](bugs/closed/2026-10-07-bundled-ffmpeg-licence-not-shipped.md)).
- The performance gate's verdict depends on the speed of the machine
  ([report](bugs/closed/2026-10-07-perf-gate-verdict-not-reproducible.md)).
- Unchanged: moved media rebuilds its cache ([open report](bugs/closed/2026-10-05-moved-media-cache-miss.md)), unsigned
  builds, NSIS 3.0.4 (CVE-2025-43715, only when an installer runs as SYSTEM).

## [0.3.0] - 2026-10-07

Performance at franchise scale ([Roadmap](docs/ROADMAP.md) §1): a 2,500-clip project and a 3-hour, 6,700-clip
sequence at 23.976 fps now save, open, edit, scrub, scroll and play back without freezes. Project files are unchanged (`formatVersion` 1).

### Changed

- **Saving** streams the project to disk while it is being prepared, instead of sending one large message at the end.
  Saving takes about 215 ms for the 2,500-clip project (was about 2 s) and 250 ms with the 3-hour sequence (was
  550–630 ms), and the 75–115 ms freeze on every save is gone. The
  file is byte-for-byte identical; it is still written to a temp file and renamed, and the `.bak` is kept (now as a
  hard link where the disk supports it, otherwise a copy).
- **Autosave** is streamed the same way, in short slices during idle time, and waits for a pause in your work (about
  2 s; after 15 s of continuous work any short pause, and after 60 s it saves anyway). Autosaves no longer freeze
  scrubbing, scrolling or playback (they used to cause random 160–435 ms freezes).
- **Opening** a project takes about 710 ms for the 2,500-clip project (810 ms with the 3-hour sequence), in small
  pieces without freezing the window (it took about 4 s with a 3 s freeze on 5 October). The first edit after opening a big project no longer freezes for 340–370 ms.
- **Timeline**: edits paint in 17–28 ms (were 80–120); scrubbing runs at 57–60 fps at every zoom, the 3-hour
  sequence included (was 26–35); mouse-wheel scrolling responds in about 6 ms per step (was 10–12); switching to a
  big sequence takes about 50 ms (was 100–140). Only the
  clips in view are built, clips are reused when the view moves a page, and thumbnail work waits until you stop
  editing.
- **Program monitor**: while scrubbing it seeks only the layers you can see and never queues a new seek behind a
  pending one, so it now shows real frames while you scrub; during playback it redraws only when the picture
  changes.
- **Project panel** no longer re-sorts or redraws on every timeline edit.
- **Thumbnails** are cached by the app once loaded, and a cancelled thumbnail-strip job stops its ffmpeg process.
- **Deliberate rendering trade-offs** (approved for performance; geometry, timing and hit testing are unchanged):
  - Timeline waveforms are drawn as filled bars aligned to device pixels, one per device column, each covering the
    peak of every sample in it, so edges are hard instead of anti-aliased in exchange for cheaper painting.
  - The timeline playhead moves on its own GPU layer by whole-device-pixel steps, which cuts compositing cost about
    53% when scrubbing within the page and about 42% during playback.

### Fixed

- Edits made while a save was running could be marked as saved and lost
  ([report](bugs/closed/2026-10-06-edits-during-save-marked-saved.md)).
- An autosave made during a save could be ignored by crash recovery
  ([report](bugs/closed/2026-10-06-autosave-during-save-ignored-by-recovery.md)).
- At display scales of 125% and 150% the timeline playhead could be drawn one pixel off.

### Development

- `npm run perf:check` is the performance gate. Every benchmark row is a user-facing **gate** (pass/fail), an
  architecture **guardrail** (fails on a regression against `tests/perf/baseline.json`) or a **diagnostic** (reported
  only); see `docs/DEVELOPMENT.md` → Performance gate.
- The Electron perf bench no longer crashes partway ("Resulting promise was garbage collected"), measures edits to
  the next painted frame, measures scrub fps with its render counter off, and deletes its temp folder on exit.

### Known issues

- None of the performance gates fail (`npm run perf:check -- --runs 2`: 98 of 98 gates, 130 of 130 guardrails;
  [closed report](bugs/closed/2026-10-05-perf-budgets-2500-clips.md)). On a heavily loaded machine, the first visit
  to each page while scrubbing a multi-hour sequence at the closest zoom can still stutter briefly.
- Unchanged: moved media rebuilds its cache ([open report](bugs/closed/2026-10-05-moved-media-cache-miss.md)), unsigned
  builds, NSIS 3.0.4 (CVE-2025-43715, only when an installer runs as SYSTEM).

## [0.2.2] - 2026-10-06

Fixes chapter export. Project files are unchanged (`formatVersion` 1).

### Fixed

- Export kept the first chapter break only if a Chapter marker sat exactly at the start of the exported range.
  Otherwise the first marker's chapter was moved to 0:00 and its break was lost: a sequence whose only Chapter marker
  is "Act Two" at 30:00 exported one chapter, "Act Two", from the start. Export now adds an untitled chapter from 0:00
  to the first marker, so every break stays where it was placed. A marker exactly at the start adds no extra chapter
  ([report](bugs/closed/2026-10-06-first-chapter-break-lost-and-stale-roadmap.md)).

### Changed

- Roadmap §7 (MKV packaging) no longer lists chapter export as a prerequisite; it lists only what packaging still
  needs.

### Known issues

- Unchanged from 0.2.1: 2,500-clip performance budgets
  ([open report](bugs/closed/2026-10-05-perf-budgets-2500-clips.md)), moved media rebuilds its cache
  ([open report](bugs/closed/2026-10-05-moved-media-cache-miss.md)), unsigned builds, NSIS 3.0.4 (CVE-2025-43715,
  only when an installer runs as SYSTEM).

## [0.2.1] - 2026-10-05

Fixes the Windows installer crash in 0.2.0. Project files are unchanged (`formatVersion` 1).

### Fixed

- The Windows installer could crash on a fresh install (`ReCut-Setup-0.2.0.exe` exited with an access violation in
  NSIS's `System.dll`; about 1 in 3 fresh installs on GitHub's Windows Server 2025 runners, on AMD and Intel CPUs).
  The cause was a fixed-length read in electron-builder's per-user install script, fixed upstream in
  electron-builder 26.12; ReCut now builds with electron-builder 26.15.3. Verified with 130 install/uninstall cycles
  on AMD and Intel runners, with no crash
  ([report](bugs/closed/2026-10-05-nsis-installer-crash-system-dll.md)).

### Changed

- Uninstalling ReCut now removes its `.recut` file association instead of restoring the previous default app.
  Installing 0.2.1 over 0.2.0 upgrades in place (same install folder and shortcuts).
- CI now installs and uninstalls the Windows installer five times and launches the portable exe before publishing a
  build.

### Known issues

- Unchanged from 0.2.0: 2,500-clip performance budgets
  ([open report](bugs/closed/2026-10-05-perf-budgets-2500-clips.md)), moved media rebuilds its cache
  ([open report](bugs/closed/2026-10-05-moved-media-cache-miss.md)), unsigned builds. The installer is built with NSIS
  3.0.4, which has CVE-2025-43715 (privilege escalation only when an installer runs as SYSTEM; ReCut's per-user
  installer normally does not).

## [0.2.0] - 2026-10-05

First tagged release. Covers everything since the initial build, including the work published as the
`v0.1.0-win.N` Windows test builds. Project files are unchanged (`formatVersion` 1); 0.1.0 projects open as before,
and damaged or hostile files are now repaired on load (see Changed).

### Added

- Windows installer (`ReCut-Setup-<version>.exe`, per-user, Start-menu and desktop shortcuts, `.recut` file
  association) and portable exe (`ReCut-Portable-<version>.exe`), both with FFmpeg bundled. CI builds them on
  Windows, smoke-tests the unpacked app, silently installs the installer and smoke-tests the installed app.
- `Start ReCut.cmd`: runs ReCut from a cloned repository on Windows. Checks for Node.js (offers winget), installs
  dependencies, rebuilds when the commit changes and downloads FFmpeg if none is installed.
- App icon.
- FFmpeg 7, 8 and 9 support (FFmpeg 6 still works).
- Export converts to the frame rate chosen in the Export dialog. Before, the setting was ignored with a warning.
  Chunked exports add up to the same frame count as a single pass.
- Export writes the sequence's **Chapter** markers in the exported range as MP4 chapters
  ([report](bugs/closed/2026-10-05-export-ignores-chapter-markers-copies-source-metadata.md)).
- Export stall watchdog: an export with no FFmpeg progress for 2 minutes (`RECUT_EXPORT_STALL_MS`) stops with an
  error instead of hanging.
- SMPTE drop-frame timecode at 29.97 and 59.94 fps (`HH:MM:SS;FF`), in display and typed entry.
- Project repair on load: damaged or hostile project data is repaired, a repaired file is first copied to
  `<file>.pre-repair-<time>`, and a warning names the copy. A project that cannot be read falls back to its `.bak`
  and keeps the damaged file as `<file>.corrupt-<time>`. The recovery prompt says when an autosave needed repairs.
- Anamorphic (non-square pixel) sources: the sample aspect ratio is probed and used in preview, thumbnails and export.
- `bugs/` folder for filing and closing bug reports ([bugs/README.md](bugs/README.md)).
- This changelog and [docs/RELEASING.md](docs/RELEASING.md).

### Changed

- **Export asks before replacing a file.** An existing output or sidecar `.srt` is no longer overwritten silently:
  the Export dialog asks "<file> already exists. Replace it?". A file created while the export runs is never
  replaced.
- **The export output folder must be an absolute path.**
- **Exports no longer carry source metadata.** Before, a single-pass export copied the first source's title and other
  tags and its chapters. Now nothing is copied from the sources; the only chapters are the sequence's Chapter markers.
- **Timecodes at 29.97 and 59.94 fps read as drop-frame everywhere** (timeline, monitors, markers, inspector,
  transcript, scenes, compare, subtitles, storyline, continuity, dialogs): frame 1800 at 29.97 is `00:01:00;02`.
  Typed timecode in those fields is read as drop-frame; a skipped label such as `00:01:00;00` is rejected.
- **Timecode entry is strict:** digits only, at most four fields; anything else is rejected instead of guessed.
- **Relinking to a shorter file trims clips** that now run past its end and removes clips that start after it, as
  one undo step with a warning. Before, those clips froze on the last frame.
- Export output protection now covers every project source, not only the exported sequence's clips: bin media,
  proxies and imported subtitle files are refused as outputs or sidecars (case-insensitive, and by file identity).
- Subtitle export (Subtitles panel, SRT/VTT) goes through the main process, refuses project source files, writes
  atomically and reports the number of cues actually written.
- An In/Out range that cuts through a transition renders exactly what the full export shows for those frames.
- Burned-in subtitles appear on exactly the frames the editor shows (cues snapped to frames).
- Media paths are passed to FFmpeg as `file:` inputs; a non-absolute media path is refused.
- Opening or creating a project closes dialogs that belonged to the previous one.
- The Windows FFmpeg download uses stable URLs (gyan.dev release essentials, BtbN as fallback) and only release
  builds.
- Roadmap revised twice: stem separation, nested sequences, OCR, a performance gate, pre-export warnings, MKV
  packaging and a scoped first version of keyframes
  ([report](bugs/closed/2026-10-05-roadmap-revisions.md), [report](bugs/closed/2026-10-05-roadmap-revisions-grok-review.md)).

### Fixed

- Exports ignored Chapter markers and copied the first source's chapters and title
  ([report](bugs/closed/2026-10-05-export-ignores-chapter-markers-copies-source-metadata.md)).
- A failed final move during export could delete both the previous output and the new render. The previous file is now
  kept until the new one is in place, and a render that cannot be moved is kept as `<name>.recut-unsaved-<time>.mp4`.
- Exporting with a sidecar could overwrite an imported subtitle file of the same name; subtitle export could
  overwrite media, proxies or imported subtitles and could leave a truncated file on failure.
- Anamorphic sources rendered with the wrong shape or failed in concat/transitions; thumbnails were squeezed.
- In/Out exports cut a transition into a hard cut at the range boundary.
- Burned-in subtitles could appear one frame early or late.
- AC-3 export accepted sample rates the encoder rejects; it is limited to 32, 44.1 and 48 kHz.
- A very short range exported at a lower frame rate could lose its only video frame.
- Invalid frame rates (from probes, projects or dialogs) gave NaN timecodes; one rule (1 to 1000 fps) now applies
  everywhere and invalid sequence settings are ignored.
- Timeline edits: ripple operations could create negative clip starts; trims, rolls and slides could pull an edge past
  its position or below the minimum length; three-point edits, inserts and speed changes could round a frame past the
  media end; razor/split left transitions inconsistent; ripple trim and slip moved linked clips on locked tracks;
  back-to-back scene inserts left a one-frame gap; very large selections overflowed the stack.
- Compare cuts: asymmetric results and `-0` deltas; large comparisons are about 60 times faster.
- Subtitle files: cues before 0 wrote invalid SRT/VTT times; subtitle cue offsets could go negative.
- Timecode formatting: millisecond rounding, negative timecodes now parse back, 119.88 fps is recognised.
- Project load: overlapping clips, out-of-range positions, duplicate ids, deeply nested values and wrongly typed
  fields are repaired; a symlinked `.bak` is replaced rather than followed.
- Electron build on Windows failed (doubled drive letter in the repo root path).
- Tests: the export performance test asserted a stale input count
  ([report](bugs/closed/2026-10-05-export-perf-inputcount-stale.md)); the media-move cache test failed about half
  the time ([report](bugs/closed/2026-10-05-media-move-cache-mtime-precision.md)); several tests failed on Windows.
- Docs: INSTALL.md contradicted itself about whether the Windows installer is tested
  ([report](bugs/closed/2026-10-05-install-packaging-contradiction.md)).

### Known issues

- A 2,500-clip project still misses the edit, scrub, open/save and serialization budgets: edits lag 80-120 ms,
  scrubbing at working zoom runs at 32-35 fps, and opening freezes the window for about 3 s
  ([open report](bugs/closed/2026-10-05-perf-budgets-2500-clips.md)).
- Moving a media file to another folder or drive rebuilds its thumbnails, waveform and proxy
  ([open report](bugs/closed/2026-10-05-moved-media-cache-miss.md)).
- Builds are not code-signed; Windows SmartScreen asks for confirmation. macOS and Linux packages are not tested.
  See [docs/LIMITATIONS.md](docs/LIMITATIONS.md) for the full list.

## [0.1.0] - 2026-10-04

Initial build, from source only: Source/Program monitors, multi-track timeline with three-point editing, frame-exact
FFmpeg export (single pass and chunked), proxies, Transcript search, Subtitles, Scene Library, Storyline, Compare
Cuts and Continuity panels, autosave and recovery. Project file `formatVersion` 1. Not tagged; the Windows test builds
`v0.1.0-win.N` were made from later commits that are part of 0.2.0.
