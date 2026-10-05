# ReCut

ReCut is a desktop non-linear video editor built for **fan edits** of films and TV: recuts, trilogy merges, character-focused
cuts, "what if this subplot were gone" experiments. It works like Premiere: Source and Program monitors, a multi-track
timeline, and three-point editing. On top of that it adds tools for working across a whole franchise: find a line
of dialogue in any episode, keep a library of tagged scenes, compare two alternate cuts structurally, and always know
the original source timecode of every frame.

Electron + React + TypeScript. FFmpeg does all media work. Version 0.1.0.

![ReCut editing workspace](docs/screenshots/project.png)

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

### Fan-edit tools
- **Series / season / franchise organisation.** On import, ReCut reads `S01E03`, `1x03` or `Season 1 Episode 3` and
  routes files into TV › Series › Season bins. Movies go to the Movies bin. You can also set collection / franchise
  identity.
- **Scene detection** (FFmpeg scene filter, adjustable threshold) with merge, split and tag of detected scenes.
- **Transcript search across a franchise.** Import SRT / WebVTT (sidecars next to a video are picked up
  automatically) or extract embedded text subtitles. Search by project, series, season, franchise, collection, source
  or sequence, with regex and whole-word options. Click a hit to load it in the Source monitor at that line.
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
  automatically. Proxies are used only for preview: export always reads the originals. Still images (PNG, JPEG, WebP,
  GIF, BMP) are drawn directly and never need one.
- **Relink.** Offline detection, a folder search that matches by name + size, and per-file Locate.
- **5.1.** 5.1 sources can be exported as 5.1 AC-3, or as a stereo downmix.
- **Export presets.** 1080p High Quality, 1080p Smaller File, 4K High Quality, 720p Preview, 1080p 5.1 Surround,
  and Match Sequence. H.264 / H.265, CRF or target bitrate, In→Out range, an FFmpeg command preview, and chunked
  rendering for very long timelines.
- Autosave, crash recovery, atomic saves with a `.bak` copy, and a JSON project format (`.recut`).

## Screenshots

| | |
|---|---|
| ![Shell](docs/screenshots/shell.png) Empty shell, Editing workspace | ![Project panel](docs/screenshots/project-panel.png) Project panel: bins, series, scenes |
| ![Source](docs/screenshots/source.png) Source monitor | ![Program](docs/screenshots/program.png) Program monitor |
| ![Timeline](docs/screenshots/timeline.png) Timeline | ![Inspector](docs/screenshots/inspector.png) Inspector with original source timecode |
| ![Transcript](docs/screenshots/transcript.png) Transcript search | ![Scenes](docs/screenshots/scenes.png) Scene library |
| ![Storyline](docs/screenshots/storyline.png) Storyline blocks and tag filters | ![Compare](docs/screenshots/compare.png) Compare cuts with structural diff |
| ![Continuity](docs/screenshots/continuity.png) Continuity notes | ![Jobs](docs/screenshots/jobs.png) Jobs and proxies |
| ![Export](docs/screenshots/export.png) Export dialog | ![Program maximized](docs/screenshots/program-maximized.png) Program monitor maximized |
| ![Still image](docs/screenshots/program-still.png) A PNG on V2 over video in the Program monitor | |

## Windows: install and run

- **Installer (easiest):** open the repository's [Releases](https://github.com/jelloshooter848/ReCut/releases) page,
  download `ReCut-Setup-<version>.exe` from the newest release and run it. It adds Start-menu and desktop shortcuts.
  FFmpeg is bundled, so nothing else is needed. `ReCut-Portable-<version>.exe` runs without installing.
  The app is not code-signed, so Windows may show "Windows protected your PC": click **More info › Run anyway**.
- **From a clone:** double-click **`Start ReCut.cmd`** in the repository folder. The first run checks for Node.js
  (offering to install it with winget), installs dependencies, builds the app and downloads FFmpeg into
  `resources\ffmpeg`; later runs just launch ReCut. Run it again after `git pull` and it rebuilds automatically.

Both are built and smoke-tested on a Windows machine by [`.github/workflows/windows.yml`](.github/workflows/windows.yml)
on every push.

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

## Legal

ReCut edits **media files you supply**. It does not download, rip or stream content, and it does not decrypt or
circumvent DRM or any other copy protection. It reads only files that FFmpeg can already open on your machine. You
are responsible for having the rights to the material you edit and for how you share the result.

## License

MIT. See `package.json`.
