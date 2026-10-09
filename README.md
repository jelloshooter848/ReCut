# ReCut

ReCut is a desktop non-linear video editor built for **fan edits** of films and TV: recuts, trilogy merges, character-focused
cuts, "what if this subplot were gone" experiments. It works like Premiere: Source and Program monitors, a multi-track
timeline, and three-point editing. On top of that it adds tools for working across a whole franchise: find a line
of dialogue in any episode, keep a library of tagged scenes, compare two alternate cuts structurally, and always know
the original source timecode of every frame.

Free and open source (MIT), for Windows, Linux and macOS. Everything runs on your computer: no account, no cloud, no
upload. Electron + React + TypeScript; FFmpeg does all media work. See [CHANGELOG.md](CHANGELOG.md) for releases and
[docs/RELEASING.md](docs/RELEASING.md) for how versions are numbered.

![ReCut editing workspace](docs/screenshots/project.png)

## Highlights

**Find any line, in any film or episode.** Search the dialogue of a whole franchise at once (regex and whole-word too),
click a hit, and the Source monitor opens at that line, ready to mark In and Out.

![Searching a line of dialogue across two films](docs/screenshots/demo-transcript-search.gif)

**No subtitles? Transcribe it.** Whisper, built in, turns the speech in any file into a searchable transcript, entirely
on your computer.

![Transcribing a film with Whisper](docs/screenshots/demo-whisper.gif)

**Blu-ray and DVD subtitles become text.** Picture subtitles (PGS, VobSub, DVB) are read by built-in OCR, so disc rips
are searchable too.

![Reading picture subtitles with OCR](docs/screenshots/demo-ocr.gif)

**"What if this subplot were gone?"** Tag clips by character or plotline, switch a plotline off, see the new runtime at
once, and turn the experiment into the real cut in one step.

![Removing a plotline with What if](docs/screenshots/demo-what-if.gif)

**Compare alternate cuts.** Play two versions side by side on one clock and read what moved, what was trimmed, and
what exists in only one of them.

![Comparing two alternate cuts](docs/screenshots/demo-compare.gif)

**Compound clips and keyframes.** Fold a scene into one clip and edit it everywhere it is used; animate position,
scale, opacity and volume.

![A compound clip with keyframed scale and position](docs/screenshots/demo-nest-keyframes.gif)

Footage: *Tears of Steel* and *Sintel* © Blender Foundation, [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/)
(see [docs/screenshots](docs/screenshots/README.md)).

## Features

### Editing core
- Source / Program monitors with JKL shuttle (up to 8x), frame stepping, In/Out marks and typed timecode entry.
- Three-point **Insert** (`,`) and **Overwrite** (`.`) that honour sequence and source In/Out. On the first edit into
  an empty sequence, ReCut offers to change the sequence to match the clip.
- Multi-track timeline (video + audio tracks, linked A/V, source patching, lock / mute / solo), snapping,
  Lift / Extract, Ripple Delete, Add Edit, Ripple Trim to playhead (Q / W), nudge, copy / paste.
- Tools: Selection, Track Select, Ripple, Rolling, Slip, Slide, Razor, Hand. All edits are frame-exact.
- Out-of-sync badges on linked clips, a stereo peak meter on the Program monitor, and a History panel (200 undo steps).
- Transitions: Cross Dissolve, Dip to Black, Audio Crossfade (centred on the cut, using source handles).
- Clip speed (1 %–10 000 %), position / scale / rotation / opacity / crop, clip gain, level and fades, and track volume.
- **Keyframes** for position, scale, opacity and volume, Linear or Ease, shown as diamonds on the timeline. They stay
  with the picture through trims, splits, rolls and slides, and the export matches the preview.
- **Nested sequences and compound clips.** Make Compound Clip folds the selection into its own sequence; edits to it
  show everywhere it is used. Drag a sequence onto the timeline to nest it; Break Apart reverses it.

### Fan-edit tools
- **Series / season / franchise organisation.** On import, ReCut reads `S01E03`, `1x03` or `Season 1 Episode 3` and
  routes files into TV › Series › Season bins. Movies go to the Movies bin. You can also set collection / franchise
  identity.
- **Scene detection** (FFmpeg scene filter, adjustable threshold) with merge, split and tag of detected scenes.
- **Transcript search across a franchise.** Import SRT / WebVTT (sidecars next to a video are picked up
  automatically) or extract embedded text subtitles. Search by project, series, season, franchise, collection, source
  or sequence, with regex and whole-word options. Click a hit to load it in the Source monitor at that line.
- **Speech-to-text (Whisper).** Media without subtitles gets a searchable transcript from the built-in whisper.cpp
  engine, entirely offline. Models (tiny to large-v3-turbo) are downloaded once, when you choose one, and checked
  against a fixed checksum.
- **OCR for Blu-ray and DVD subtitles.** Picture subtitles (PGS, VobSub, DVB, XSUB) are read into searchable text
  tracks by a built-in OCR engine (Tesseract). Languages are installed from inside ReCut; OCR then runs offline.
- **Scene library.** Reusable source ranges with characters, location, arc, tags, rating and colour. Filter, sort
  and group them, and drag them to the timeline.
- **Story tagging.** Tag clips with characters, plotlines, locations and tags. The Storyline panel can **Highlight** or
  **Solo** matching clips, and its **What if** buttons disable matching / non-matching clips and estimate the runtime.
  **Remove disabled** turns the experiment into the real cut (ripple, one undo step), and **Duplicate as cut** does the
  same in a new version of the sequence.
- **Storyline blocks.** Label acts and arcs as coloured blocks above the cut.
- **Alternate cuts and snapshots.** Duplicate a sequence as a versioned alternate cut, or take restorable snapshots.
- **Compare cuts.** Play two sequences side by side on one clock and read a structural diff
  (same / moved / trimmed / only in A / only in B).
- **Continuity notes.** Categorised issues that are pinned to a clip, can be resolved, are aggregated across sequences
  and can be copied as text.
- **Original source timecode.** The Inspector shows the source file's timecode at the playhead. The Program timecode
  can switch from SEQ to SRC, and Match Frame (`F`) jumps to the source.
- **Subtitles that follow clips.** Cues carried in from the source stay attached to their clip through moves, trims,
  ripples and speed changes. They export as SRT / VTT or can be burned in.

### Media
- **Proxies.** Media that Chromium cannot decode (HEVC, AC-3, DTS, MPEG-TS, ...) gets a 540p H.264 proxy
  automatically. It carries every audio stream, so the preview plays each clip's selected stream, as the export does.
  Proxies are used only for preview: export always reads the originals. Still images in PNG, JPEG, WebP, GIF and BMP
  are drawn directly; every other still FFmpeg decodes (TIFF, TGA, EXR, PSD, JPEG XL, AVIF, HEIC, ...) is previewed
  from a PNG made on import.
- **Relink.** Offline detection, a folder search that matches by name + size, and per-file Locate.
- **5.1.** 5.1 sources can be exported as 5.1 AC-3, or as a stereo downmix. Per clip you can play one source channel
  as mono or a downmix with your own centre and surround levels, and **Extract Centre Channel (Dialogue)** puts the
  centre channel on its own linked clip.
- **Export.** MP4 (H.264 / H.265), **MKV** with any number of audio tracks (for example 5.1 plus a stereo downmix, or
  a commentary track), soft subtitle tracks and chapters, **MOV** with ProRes or DNxHR for grading and finishing
  elsewhere, and **WAV / FLAC** audio only, as the mix or one file per track. Presets for each, CRF or target bitrate,
  In→Out range, an FFmpeg command preview, a Checks list that warns before you export, and chunked rendering for very
  long timelines. Exports are frame-exact.
- **Collect Project.** Copies the project and the media it uses into one folder, verified, so it moves to another
  drive or machine intact. Moved or renamed media keep their thumbnails, proxies, waveforms and OCR results.
- Autosave, crash recovery, atomic saves with a `.bak` copy, and a JSON project format (`.recut`). Every release opens
  projects saved by earlier releases from 0.3.0 on (they are kept as test fixtures and opened on every build).
- An optional update notice (off until you agree; it never downloads or installs anything by itself).

## Screenshots

| | |
|---|---|
| ![Project panel](docs/screenshots/project-panel.png) Project panel: bins, series, scenes | ![Source](docs/screenshots/source.png) Source monitor with subtitles |
| ![Program](docs/screenshots/program.png) Program monitor | ![Timeline](docs/screenshots/timeline.png) Timeline |
| ![Inspector](docs/screenshots/inspector.png) Inspector with original source timecode | ![Keyframes](docs/screenshots/keyframes.png) Keyframes in the Inspector and on the timeline |
| ![Nested sequence](docs/screenshots/nested.png) A compound clip (nested sequence) | ![Channels](docs/screenshots/channels.png) Centre channel extracted from a 5.1 source |
| ![Transcript](docs/screenshots/transcript.png) Transcript search across a franchise | ![Scenes](docs/screenshots/scenes.png) Scene library |
| ![Storyline](docs/screenshots/storyline.png) Storyline blocks and tag filters | ![Compare](docs/screenshots/compare.png) Compare cuts with structural diff |
| ![Continuity](docs/screenshots/continuity.png) Continuity notes | ![Jobs](docs/screenshots/jobs.png) Jobs and proxies |
| ![Export](docs/screenshots/export.png) Export dialog | ![Export formats](docs/screenshots/export-formats.png) ProRes, DNxHR, MKV and audio-only formats |
| ![Collect Project](docs/screenshots/collect.png) Collect Project | ![Program maximized](docs/screenshots/program-maximized.png) Program monitor maximized |
| ![Still image](docs/screenshots/program-still.png) A still image on V2 over video | ![Shell](docs/screenshots/shell.png) Empty shell, Editing workspace |

## Windows: install and run

- **Installer (easiest):** open the repository's [Releases](https://github.com/jelloshooter848/ReCut/releases) page,
  download `ReCut-Setup-<version>.exe` from the release marked **Latest** and run it. It adds Start-menu and desktop shortcuts.
  FFmpeg is bundled, so nothing else is needed. `ReCut-Portable-<version>.exe` runs without installing.
  The app is not code-signed, so Windows may show "Windows protected your PC": click **More info › Run anyway**.
- **From a clone:** double-click **`Start ReCut.cmd`** in the repository folder. The first run checks for Node.js
  (offering to install it with winget), installs dependencies, builds the app and downloads FFmpeg into
  `resources\ffmpeg`; later runs just launch ReCut. Run it again after `git pull` and it rebuilds automatically.

Both are built and smoke-tested on a Windows machine by [`.github/workflows/windows.yml`](.github/workflows/windows.yml)
on every push.

## Linux: download and run

- **AppImage (x86-64):** download `ReCut-<version>-linux-x86_64.AppImage` from the release marked **Latest** on the
  [Releases](https://github.com/jelloshooter848/ReCut/releases) page, then
  `chmod +x ReCut-<version>-linux-x86_64.AppImage` and `./ReCut-<version>-linux-x86_64.AppImage`. FFmpeg is bundled,
  so nothing else is needed. If it says FUSE is missing, install `libfuse2` (`libfuse2t64` on Ubuntu 24.04 and later)
  or run it with `--appimage-extract-and-run`. See [docs/INSTALL.md](docs/INSTALL.md#linux-in-one-step).
- **From source:** see the quick start below.

The AppImage is built, tested and launched on Ubuntu 22.04 by the same workflow on every push to `main` and `dev` and
on every pull request into `dev`.

## macOS (Apple Silicon and Intel): download and run

- **dmg (macOS 12 or newer):** download the dmg for your Mac from the release marked **Latest** on the
  [Releases](https://github.com/jelloshooter848/ReCut/releases) page: `ReCut-<version>-macos-arm64.dmg` for Apple
  Silicon (M1 or newer) or `ReCut-<version>-macos-x64.dmg` for Intel. Not sure which? Apple menu › **About This Mac**:
  "Chip: Apple M…" means arm64; "Processor: Intel" means x64. Open the dmg and drag ReCut to Applications. The dmgs are
  signed and notarized, so ReCut opens normally. FFmpeg and the speech-to-text engine are bundled, so nothing else is
  needed. On Intel Macs speech-to-text runs on the CPU only (no Metal), so it is slower; Intel support may be retired
  after 1.0. See [docs/INSTALL.md](docs/INSTALL.md#macos).

Both dmgs are built, signed, notarized and launched from the mounted dmg by the same workflow on every push to `main`
and `dev` and on every pull request into `dev`, on an Apple Silicon runner (the Intel one under Rosetta 2). The newest
unreleased code is on the `dev` branch: its builds are the **ReCut-macos-arm64** and **ReCut-macos-x64** artifacts of
the latest green `dev` run (Actions › Windows build › filter by branch `dev` › the run › Artifacts); see
[macOS test builds](docs/INSTALL.md#macos-test-builds).

## Quick start (from source, any OS)

Requires Node.js 20+ (22 recommended) and FFmpeg 6+ (`ffmpeg` and `ffprobe` on `PATH`, or set `RECUT_FFMPEG` /
`RECUT_FFPROBE`). ReCut shows a banner at startup when it cannot find them. See [docs/INSTALL.md](docs/INSTALL.md),
which also explains how to bundle FFmpeg into a package.

```bash
git clone <this repo> ReCut && cd ReCut
npm install
npm run dev            # Vite + Electron with hot reload
# or
npm start              # production build, then launch
```

To try it without your own media, generate synthetic test files (requires FFmpeg):

```bash
scripts/make-test-media.sh ./test-media        # movies, TV episodes, SRTs, 5.1 / AC-3 / HEVC variants
```

Then press **Ctrl+I** (Cmd+I on macOS) to import, double-click a clip, mark **I** / **O**, and press **,** to insert it.
The [User Guide](docs/USER-GUIDE.md) walks through a complete fan edit.

## Documentation

| Doc | Contents |
|---|---|
| [INSTALL](docs/INSTALL.md) | Prerequisites, FFmpeg, building, packaging, environment variables, where data lives |
| [USER-GUIDE](docs/USER-GUIDE.md) | A complete fan edit, step by step |
| [SHORTCUTS](docs/SHORTCUTS.md) | Every default keyboard shortcut |
| [FORMATS](docs/FORMATS.md) | Import formats, preview vs proxy, audio layouts, subtitles, export formats |
| [LIMITATIONS](docs/LIMITATIONS.md) | Known limitations and open bugs |
| [ROADMAP](docs/ROADMAP.md) | Deferred capabilities and why |
| [ARCHITECTURE](docs/ARCHITECTURE.md) | Processes, store, playback engine, export pipeline, timing model |
| [DEVELOPMENT](docs/DEVELOPMENT.md) | Repo layout, scripts, tests, conventions |
| [project-format](docs/project-format.md) | The `.recut` JSON format |
| [export-pipeline](docs/export-pipeline.md) | How the FFmpeg render graph is built |

## Contributing

Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md), and ask questions or share ideas in
[GitHub Discussions](https://github.com/jelloshooter848/ReCut/discussions).

## Legal

ReCut edits **media files you supply**. It does not download, rip or stream content, and it does not decrypt or
circumvent DRM or any other copy protection. It reads only files that FFmpeg can already open on your machine. You
are responsible for having the rights to the material you edit and for how you share the result.

## License

ReCut is licensed under the [MIT License](LICENSE).

The Windows releases, the Linux AppImage and the macOS dmgs bundle FFmpeg (`ffmpeg` and `ffprobe`), which ReCut runs as a separate program. The bundled
builds include libx264 and are licensed under the GPL version 3 or later, not under ReCut's licence; each release
ships the FFmpeg licence and a record of the exact build with where to get its source. ReCut also ships Electron,
Chromium, the whisper.cpp speech-to-text engine, the Tesseract OCR engine and a few npm packages under their own
licences. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), or
**Help › About › Licences** in the app.
