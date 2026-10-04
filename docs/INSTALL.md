# Installing ReCut

ReCut runs from source on Linux, macOS and Windows. Only the **Linux unpacked** packaged build has been verified so
far (see [Packaged builds](#packaged-builds)).

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | 20 or 22 (developed on 22) | npm comes with it. |
| FFmpeg + FFprobe | 6.0 or newer (developed on 6.1.1) | Must be on `PATH`, or set `RECUT_FFMPEG` / `RECUT_FFPROBE`. Not bundled. |
| libx264 in your FFmpeg build | | Required for proxies and H.264 export. |
| libx265 | optional | Only for H.265 / HEVC export. |
| libass (`subtitles` filter) | optional | Only for burned-in subtitles. |
| xvfb | Linux CI only | For headless runs and end-to-end tests. |

### Installing FFmpeg

- **Ubuntu / Debian:** `sudo apt install ffmpeg`. The distro build includes libx264, libx265 and libass.
- **Fedora:** enable RPM Fusion, then run `sudo dnf install ffmpeg`. The Fedora-repo `ffmpeg-free` build lacks libx264.
- **Arch:** `sudo pacman -S ffmpeg`
- **macOS (Homebrew):** `brew install ffmpeg`
- **Windows:** `winget install Gyan.FFmpeg` (or `choco install ffmpeg`, or a "full" build from gyan.dev). Then make sure
  the `bin` folder is on `PATH`.

Check the install with `ffmpeg -version` and `ffprobe -version`. Once ReCut is running, **Preferences** (Ctrl+, / Cmd+,)
shows the FFmpeg and FFprobe paths it found and the FFmpeg version, or "not found".

ReCut does **not** stop at startup when FFmpeg is missing. Import, thumbnails, proxies and export fail with
"ffmpeg binary not found (set RECUT_FFMPEG or install ffmpeg)".

## Install from source

```bash
git clone <repo-url> ReCut
cd ReCut
npm install
npm run dev        # development: Vite dev server + Electron, renderer hot reload
```

Production build and launch:

```bash
npm run build      # renderer → dist/renderer, main/preload → dist/electron
npx electron .     # or: npm start (build + launch)
```

Headless (Linux, no display):

```bash
npm run build
xvfb-run -a npx electron --no-sandbox .
```

## Packaged builds

```bash
npm run package    # build + electron-builder --dir  → release/linux-unpacked/recut
npm run dist       # build + electron-builder         → AppImage (Linux), dmg (macOS), nsis installer (Windows)
```

- **Verified:** `npm run package` on Linux, which produces `release/linux-unpacked/` with the `recut` executable.
- **Not verified:** the `npm run dist` targets (AppImage, dmg, nsis). They are configured in `package.json` → `build`
  but have not been built or tested. Code signing and notarisation are not set up.
- Packaged builds **do not include FFmpeg**. electron-builder only packs `dist/**` and `package.json`. Install FFmpeg
  separately as described above. The media layer also looks for binaries in `<resources>/ffmpeg/`, so you can drop
  `ffmpeg` / `ffprobe` there yourself. The exporter does not look there (see [LIMITATIONS](LIMITATIONS.md)), so set
  `RECUT_FFMPEG` or keep FFmpeg on `PATH`.

## First launch

1. ReCut opens the **Editing** workspace with an empty project, the default bins (Audio, Graphics, Misc, Movies,
   Scenes, Sequences, Subtitles, TV), and **Sequence 01** (1920×1080, 23.976 fps, stereo, 48 kHz).
2. Press **Ctrl+I** (Cmd+I) or click **Import…** in the Project panel. Proxies are on by default, so files the
   preview cannot decode get a proxy automatically.
3. If an earlier session ended without saving, ReCut offers to **recover** the newer autosave.

Opening a project from the command line:

```bash
recut /path/to/My Edit.recut            # packaged
recut --project "/path/to/My Edit.recut"
npx electron . --project "/path/to/My Edit.recut"   # from source
```

ReCut is single-instance. Launching it again with a project path opens that project in the running window.

## Environment variables

All are optional. They are read by the main process (`electron/`).

| Variable | Effect |
|---|---|
| `RECUT_FFMPEG` | Absolute path to `ffmpeg`. Takes precedence over bundled and `PATH` lookups. Used by media services and by the exporter. |
| `RECUT_FFPROBE` | Absolute path to `ffprobe`. |
| `RECUT_FFMPEG_PATH` / `RECUT_FFPROBE_PATH` | Aliases of the two above, honoured by the media services (`electron/media/ffmpeg.ts`) only. **The exporter ignores `RECUT_FFMPEG_PATH`.** |
| `RECUT_USER_DATA` | Overrides Electron's `userData` directory (prefs, untitled autosave, default cache). Useful for isolated test runs. |
| `RECUT_CACHE_DIR` | Cache root for thumbnails, waveforms, proxies and scene-detection results. Takes precedence over the `cacheDir` pref and `<userData>/cache`. |
| `RECUT_DISABLE_GPU=1` | Calls `app.disableHardwareAcceleration()`. Use it on machines or VMs with broken GPU drivers. |
| `RECUT_DEV_URL` | Loads the renderer from this URL instead of `dist/renderer` (set by `npm run dev` to the Vite server) and allows in-window navigation to its origin. |
| `RECUT_SMOKE=1` | Smoke test: disables the GPU, checks that the `recut-media://` protocol serves byte ranges / HEAD / 404 / 416, prints `smoke:` lines to stdout and quits after about 2 s. |
| `RECUT_SMOKE_FILE` | The file the smoke test fetches (default `/usr/bin/ffmpeg`, or the Electron executable on Windows). |

Test and benchmark scripts use their own variables (`ATTACK_MEDIA_DIR`, `RECUT_PERF_*`). See
[DEVELOPMENT](DEVELOPMENT.md).

## Where data lives

`userData` is Electron's per-user app directory for the app name **ReCut**, unless `RECUT_USER_DATA` overrides it:
`~/.config/ReCut` (Linux), `~/Library/Application Support/ReCut` (macOS), `%APPDATA%\ReCut` (Windows).

| Data | Location |
|---|---|
| Preferences (recent projects, shortcut overrides, window bounds, last export folder, optional `cacheDir`) | `<userData>/prefs.json` |
| Project | Wherever you save it: `*.recut` (JSON). Saves are atomic, and the previous version is kept as `*.recut.bak`. |
| Autosave of a saved project | Next to it: `<project>.recut.autosave` |
| Autosave of a never-saved project | `<userData>/autosave/untitled.recut.autosave` |
| Cache (`thumbs/`, `waves/`, `proxies/`, `scenes/`) | `$RECUT_CACHE_DIR`, else `cacheDir` in `prefs.json`, else `<userData>/cache` |
| Panel layouts, the Jobs tab, Inspector collapsed sections, last export settings per project | Renderer `localStorage` (inside `userData`) |
| Export temp files | `<os tmpdir>/recut-export-<id>/`, deleted after each export |

Cache entries are keyed by file path + size + mtime, so a changed source file gets fresh thumbnails and proxies. You
can delete the cache folder at any time; it is rebuilt on demand. Preferences › Application › **Cache folder**
shows the current location and has a **Reveal** button. The location cannot be changed from the UI: edit
`cacheDir` in `prefs.json` or set `RECUT_CACHE_DIR`.
