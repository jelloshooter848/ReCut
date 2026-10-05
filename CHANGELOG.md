# Changelog

All notable changes to ReCut are listed here, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow semantic versioning as described in
[docs/RELEASING.md](docs/RELEASING.md). The project file `formatVersion` is versioned separately and is unchanged
(still `1`) unless an entry says otherwise.

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
  ([open report](bugs/open/2026-10-05-perf-budgets-2500-clips.md)), moved media rebuilds its cache
  ([open report](bugs/open/2026-10-05-moved-media-cache-miss.md)), unsigned builds. The installer is built with NSIS
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
  ([open report](bugs/open/2026-10-05-perf-budgets-2500-clips.md)).
- Moving a media file to another folder or drive rebuilds its thumbnails, waveform and proxy
  ([open report](bugs/open/2026-10-05-moved-media-cache-miss.md)).
- Builds are not code-signed; Windows SmartScreen asks for confirmation. macOS and Linux packages are not tested.
  See [docs/LIMITATIONS.md](docs/LIMITATIONS.md) for the full list.

## [0.1.0] - 2026-10-04

Initial build, from source only: Source/Program monitors, multi-track timeline with three-point editing, frame-exact
FFmpeg export (single pass and chunked), proxies, Transcript search, Subtitles, Scene Library, Storyline, Compare
Cuts and Continuity panels, autosave and recovery. Project file `formatVersion` 1. Not tagged; the Windows test builds
`v0.1.0-win.N` were made from later commits that are part of 0.2.0.
