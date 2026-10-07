# Installing ReCut

ReCut runs from source on Linux, macOS and Windows. Verified packaged builds: the **Windows installer and portable
exe** (built on Windows by CI with FFmpeg bundled; the unpacked app they are made from is smoke-tested, the installer
is silently installed and the installed app smoke-tested; the unit and end-to-end suites run on Windows on every
build and must pass before anything is published) and the **Linux unpacked** build (built and run locally). macOS
(dmg) and the Linux AppImage are configured but untested. Nothing is code-signed.

## Windows in one step

- **Installer:** download `ReCut-Setup-<version>.exe` from the release marked **Latest** on
  [GitHub Releases](https://github.com/jelloshooter848/ReCut/releases) and run it (per-user install, no admin rights,
  Start-menu and desktop shortcuts, `.recut` files open in ReCut, uninstall from *Settings › Apps*).
  `ReCut-Portable-<version>.exe` is the same app without installing. FFmpeg is bundled in both (GPL; see
  [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)).
  Builds are unsigned: if SmartScreen says "Windows protected your PC", choose **More info › Run anyway**.
- **From a cloned repository:** double-click `Start ReCut.cmd`. It runs `scripts/windows/start-recut.ps1`, which
  checks for Node.js 20+ (offers `winget install OpenJS.NodeJS.LTS`), runs `npm ci` when the lockfile changed,
  rebuilds when the checked-out commit changed, downloads FFmpeg into `resources\ffmpeg` if none is installed, and
  launches the app. `Start ReCut.cmd -Rebuild` forces a clean install and build.

Releases are produced by `.github/workflows/windows.yml`, which builds on `windows-latest`, bundles the current FFmpeg release (gyan.dev essentials, BtbN as fallback;
see `scripts/windows/get-ffmpeg.ps1`) together with its licence and source information (`FFMPEG-LICENSE.txt`, `FFMPEG-BUILD.txt`), smoke-tests both the unpacked app and a silent install (media protocol, FFmpeg encode + probe,
UI mounted), and publishes a release `v<version>` automatically when a release PR (version bump + changelog entry) is merged to
`main` (see [RELEASING.md](RELEASING.md)). Every other run is a test build: nothing is published to the Releases page,
and its installers are only the run's `ReCut-windows` artifact (Actions → the run → Artifacts → ReCut-windows, kept
14 days; see [RELEASING.md](RELEASING.md#test-builds)). On every build the same workflow also checks `Start ReCut.cmd`
from a fresh clone and runs the unit and end-to-end suites on Windows. Publishing is a separate last job that runs only
for a release and only when the build, smoke and install checks, both test suites and the launcher check have all
passed; a release run with any failure publishes nothing.

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | 20 or 22 (developed on 22) | npm comes with it. |
| FFmpeg + FFprobe | 6.0 or newer (developed on 6.1.1) | On `PATH`, set with `RECUT_FFMPEG` / `RECUT_FFPROBE`, or bundled in a package you build yourself (see [Bundling FFmpeg](#bundling-ffmpeg)). |
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

If FFmpeg or FFprobe is missing, ReCut still starts, but shows a warning banner at the top of the window until you
install it and restart. **How to install…** in the banner repeats these steps. While FFmpeg is missing, Import,
proxies and Export stop with a message that says what is missing and how to fix it, instead of a generic error.

ReCut looks for the binaries in this order (one resolver, used by import, thumbnails, proxies, export and
Preferences / About):

1. `RECUT_FFMPEG` / `RECUT_FFPROBE` (or `RECUT_FFMPEG_PATH` / `RECUT_FFPROBE_PATH`).
2. The bundled folder `<resources>/ffmpeg/` of a packaged app (`ffmpeg`, `ffprobe`, or `ffmpeg.exe`, `ffprobe.exe` on
   Windows), then `resources/ffmpeg/` in the working folder when you run from source.
3. `PATH`, then `/usr/local/bin`, `/usr/bin`, `/opt/homebrew/bin` and `/snap/bin` (apps started from a desktop
   launcher often get a short `PATH`).

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
npm run dist       # build + electron-builder         → AppImage (Linux), dmg (macOS), nsis installer + portable exe (Windows)
```

- **Verified on Windows, in CI:** the nsis installer and the portable exe (the `package.json` → `build.win` targets).
  `.github/workflows/windows.yml` builds them on `windows-latest` with FFmpeg bundled, smoke-tests the unpacked app,
  silently installs the installer and smoke-tests the installed app (see [Windows in one step](#windows-in-one-step)).
  The portable exe contains the same app but is not launched in CI. Both are unsigned.
- **Verified on Linux, locally:** `npm run package`, which produces `release/linux-unpacked/` with the `recut`
  executable.
- **Not verified:** the macOS dmg and the Linux AppImage. They are configured in `package.json` → `build` but have
  not been built or tested. Code signing (Windows) and notarisation (macOS) are not set up.
- A package you build yourself does **not** include FFmpeg unless `resources/ffmpeg/` exists when you build it, so
  its users install FFmpeg themselves as described above (on Windows, `Start ReCut.cmd` may already have downloaded
  it there). The Windows builds from CI are the only published builds that bundle FFmpeg: the workflow downloads it
  into `resources/ffmpeg/` before packaging. To ship it inside your own package, see [Bundling FFmpeg](#bundling-ffmpeg).

### Bundling FFmpeg

`package.json` → `build.extraResources` copies the folder `resources/ffmpeg/` into the packaged app as
`<resources>/ffmpeg/`. The folder is not in the repository (it is git-ignored). When it does not exist, the package is
built without FFmpeg. To bundle FFmpeg:

1. Download **static** builds of `ffmpeg` and `ffprobe` for the target platform, for example from johnvansickle.com
   (Linux), evermeet.cx (macOS) or gyan.dev / BtbN (Windows). Use builds that include libx264. On Windows,
   `scripts/windows/get-ffmpeg.ps1` does this step and step 2 for you, including the licence files below.
2. Put them in `resources/ffmpeg/` at the repository root, named exactly `ffmpeg` and `ffprobe` (`ffmpeg.exe` and
   `ffprobe.exe` on Windows). On Linux and macOS, run `chmod +x resources/ffmpeg/*`.
3. Put the FFmpeg licence and source information next to them in `resources/ffmpeg/` (see the licensing note below):
   `FFMPEG-LICENSE.txt` (the licence file that came with the build, unchanged), `FFMPEG-BUILD.txt` (where you
   downloaded it, the build name, the output of `ffmpeg -version`, the date, and where to get the corresponding
   source) and, if the build has one, its readme as `FFMPEG-README.txt`. Help › About › Licences opens these files.
4. Run `npm run package` or `npm run dist`. Everything in `resources/ffmpeg/` ends up in
   `release/linux-unpacked/resources/ffmpeg/` (or the matching folder of the dmg / installer), and ReCut uses the
   binaries unless `RECUT_FFMPEG` / `RECUT_FFPROBE` are set. `LICENSE` and `THIRD_PARTY_NOTICES.md` are packaged into
   `resources/` as well.

**Licensing.** ReCut itself is MIT-licensed (`LICENSE`). FFmpeg is a separate program that ReCut runs as a child
process; a bundled FFmpeg is distributed alongside ReCut under its own licence, and ReCut stays MIT. FFmpeg builds
with libx264 are GPL (the gyan.dev and BtbN builds above are GPL-3.0-or-later), so whoever distributes a package with
such a build bundled must, like any redistributor of GPL binaries, ship the GPL licence text with it and make the
corresponding source of that exact FFmpeg build (FFmpeg and the GPL libraries compiled into it) available, for
example with links in `FFMPEG-BUILD.txt` to the exact source release and the build provider's scripts, or by
publishing the source next to the package. `THIRD_PARTY_NOTICES.md` describes what the Windows releases ship. This is
a description of common practice, not legal advice.

Build one package per platform: the binaries are platform-specific.

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
| `RECUT_FFMPEG` | Absolute path to `ffmpeg`. Takes precedence over bundled and `PATH` lookups. Used everywhere (import, thumbnails, proxies, export, About). |
| `RECUT_FFPROBE` | Absolute path to `ffprobe`. |
| `RECUT_FFMPEG_PATH` / `RECUT_FFPROBE_PATH` | Aliases of the two above. |
| `RECUT_USER_DATA` | Overrides Electron's `userData` directory (prefs, untitled autosave, default cache). Useful for isolated test runs. |
| `RECUT_CACHE_DIR` | Cache root for thumbnails, waveforms, proxies and scene-detection results. Takes precedence over the `cacheDir` pref and `<userData>/cache`. |
| `RECUT_DISABLE_GPU=1` | Calls `app.disableHardwareAcceleration()`. Use it on machines or VMs with broken GPU drivers. |
| `RECUT_DEV_URL` | Loads the renderer from this URL instead of `dist/renderer` (set by `npm run dev` to the Vite server) and allows in-window navigation to its origin. |
| `RECUT_EXPORT_STALL_MS` | How long an export may go without FFmpeg progress before it is stopped with an error (default 120000, two minutes). Guards against FFmpeg builds that hang. |
| `RECUT_OCR_LANG_URL` | Test-only base URL for OCR language downloads (for example `http://127.0.0.1:8080/`). Accepted only for a loopback `http(s)://127.0.0.1`, `localhost` or `[::1]` address; any other value is ignored. |
| `RECUT_UPDATE_CHECK=0` | No "Check for new ReCut versions?" prompt and no daily update check for this installation (Preferences shows the setting as turned off). **Help › Check for Updates…** still works. The end-to-end tests set it. |
| `RECUT_UPDATE_URL` | Test-only URL asked instead of GitHub's latest-release API (for example `http://127.0.0.1:8080/latest`). Accepted only for a loopback `http(s)://127.0.0.1`, `localhost` or `[::1]` address; any other value is ignored. |
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
| Project | Wherever you save it: `*.recut` (JSON). Saves are atomic, and the previous version is kept as `*.recut.bak`. A project that had to be repaired on open is copied to `*.recut.pre-repair-<time>` first; a damaged one opened from its `.bak` is kept as `*.recut.corrupt-<time>`. |
| Autosave of a saved project | Next to it: `<project>.recut.autosave` |
| Autosave of a never-saved project | `<userData>/autosave/untitled.recut.autosave` |
| Cache (`thumbs/`, `waves/`, `proxies/`, `scenes/`, `ocr/` for OCR results) | `$RECUT_CACHE_DIR`, else `cacheDir` in `prefs.json`, else `<userData>/cache` |
| OCR language data (`<code>.traineddata`, one file per installed language; `*.part` while a download runs) | `<userData>/ocr/tessdata` |
| Panel layouts, the Jobs tab, Inspector collapsed sections, last export settings per project | Renderer `localStorage` (inside `userData`) |
| Export temp files | `<os tmpdir>/recut-export-<id>/` (filter script, burn-in subtitles, chunks), deleted after each export. The render itself is written next to the output as `<name>.recut-part-<random>.mp4` and renamed at the end; if that rename fails it is kept as `<name>.recut-unsaved-<time>.mp4`. |

Cache entries are keyed by file path + size + mtime, so a changed source file gets fresh thumbnails and proxies. You
can delete the cache folder at any time; it is rebuilt on demand. Thumbnails cached by builds before 5 October 2026
are regenerated once: the thumbnail cache version changed when anamorphic sources started getting their display
shape. Preferences › Application › **Cache folder** shows the current location and has a **Reveal** button. The
location cannot be changed from the UI: edit `cacheDir` in `prefs.json` or set `RECUT_CACHE_DIR`.

### Network access

ReCut works offline. The only network access it makes is an OCR language install you start yourself (**File › OCR
Languages…** › **Install**, the Read with OCR dialog's **Install <Language>** button, or Preferences › Application ›
OCR languages › **Manage…**): it downloads that one
language file from `raw.githubusercontent.com` (Tesseract `tessdata_fast`, pinned to one commit), checks its size
and SHA-256 against the list built into ReCut and only then saves it in `<userData>/ocr/tessdata`. Downloads use the
system proxy settings. Where the network is blocked, **Install from file…** accepts the same file downloaded
elsewhere, with the same SHA-256 check. Removing a language deletes its file; **Open folder** shows the folder.
Reading subtitles with OCR itself never uses the network.
