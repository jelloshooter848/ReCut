# Installing ReCut

ReCut runs from source on Linux, macOS and Windows. Verified packaged builds: the **Windows installer and portable
exe** (built on Windows by CI with FFmpeg bundled; the unpacked app they are made from is smoke-tested, the installer
is silently installed and the installed app smoke-tested; the unit and end-to-end suites run on Windows on every
build and must pass before anything is published) and the **Linux x86-64 AppImage** (built on Ubuntu 22.04 by CI with
FFmpeg bundled; the unit and end-to-end suites run on Linux on every build, and the AppImage itself is launched and
smoke-tested before anything is published) and the **macOS dmgs**, one for Apple Silicon and one for Intel (built
on macOS by CI with FFmpeg bundled, Developer ID signed and notarized, and launched from the mounted dmg before
anything is published; the unit and end-to-end suites run on macOS on every build). Only the macOS builds are
code-signed.

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
UI mounted), and publishes a release `v<version>` automatically when the release (version bump + changelog entry,
merged into `dev` first) is merged from `dev` into `main` (see [RELEASING.md](RELEASING.md)). Every other run is a test build: nothing is published to the Releases page,
and its installers are only the run's `ReCut-windows` artifact (Actions → the run → Artifacts → ReCut-windows, kept
14 days; see [RELEASING.md](RELEASING.md#test-builds)). On every build the same workflow also checks `Start ReCut.cmd`
from a fresh clone and runs the unit and end-to-end suites on Windows. Publishing is a separate last job that runs only
for a release and only when the build, smoke and install checks, both test suites and the launcher check have all
passed; a release run with any failure publishes nothing.

## Linux in one step

- **AppImage:** download `ReCut-<version>-linux-x86_64.AppImage` from the release marked **Latest** on
  [GitHub Releases](https://github.com/jelloshooter848/ReCut/releases), make it executable and run it:

  ```bash
  chmod +x ReCut-<version>-linux-x86_64.AppImage
  ./ReCut-<version>-linux-x86_64.AppImage
  ```

  Nothing is installed; delete the file to remove ReCut (your settings stay in `~/.config/ReCut`). FFmpeg and FFprobe
  are bundled inside the AppImage (GPL; see [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)), so you do not need a
  system FFmpeg. x86-64 (64-bit Intel / AMD) only; there is no ARM Linux build.
- **"AppImages require FUSE to run":** install the FUSE 2 library (`sudo apt install libfuse2` on Ubuntu 22.04 and
  Debian 12, `sudo apt install libfuse2t64` on Ubuntu 24.04 and later, `sudo dnf install fuse-libs` on Fedora), or run
  it without FUSE: `./ReCut-<version>-linux-x86_64.AppImage --appimage-extract-and-run`.
- **Desktop menu and `.recut` files:** the AppImage does not add itself to the application menu. A tool such as
  AppImageLauncher or Gear Lever can integrate it, using the `recut.desktop` entry inside the AppImage (which declares
  `.recut` projects as `application/x-recut`). From a terminal, `./ReCut-<version>-linux-x86_64.AppImage "My Edit.recut"`
  opens a project.
- **From source:** see [Install from source](#install-from-source) below (system FFmpeg from your distribution).

Linux builds come from the `linux` job of `.github/workflows/windows.yml` on `ubuntu-22.04`: it downloads a BtbN
`linux64-gpl` FFmpeg release-branch build with `scripts/linux/get-ffmpeg.sh` (which checks that it depends on nothing
but glibc 2.28 or newer, and writes `FFMPEG-LICENSE.txt` and `FFMPEG-BUILD.txt` next to it), runs the unit and
end-to-end suites with it, builds the AppImage and launches it with FUSE and with `--appimage-extract-and-run` (media
protocol, FFmpeg encode + probe with the bundled FFmpeg, licence files, OCR, UI mounted). The AppImage is attached to
each release next to the Windows files; every other run keeps it as the run's `ReCut-linux` artifact (see
[RELEASING.md](RELEASING.md#test-builds)).

## macOS

- **Download:** from the release marked **Latest** on
  [GitHub Releases](https://github.com/jelloshooter848/ReCut/releases), the dmg for your processor (open the Apple
  menu › **About This Mac**):
  - "**Chip:** Apple M1" (M2, M3, …) → Apple Silicon → `ReCut-<version>-macos-arm64.dmg`;
  - "**Processor:** … Intel …" → Intel → `ReCut-<version>-macos-x64.dmg`.

  Each contains only its own processor's programs (FFmpeg and the speech-to-text engine), so pick the matching one:
  the Intel build does not need Rosetta, and the Apple Silicon build does not run on an Intel Mac. (The Intel build
  would also run on Apple Silicon under Rosetta 2, but slower; use the arm64 one there.) Intel support may be retired
  after ReCut 1.0.
- **Requirements:** macOS 12 Monterey or newer.
- **Install:** open the dmg and drag **ReCut** into **Applications**. The release dmgs are signed with a Developer ID
  and notarized by Apple, so ReCut opens normally: macOS asks once whether to open an app downloaded from the
  Internet; click **Open**. FFmpeg and FFprobe are bundled inside the app (GPL; see
  [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)), so you do not need Homebrew or a system FFmpeg.
- **Intel Macs:** speech-to-text (Whisper) runs on the CPU only (no Metal), so transcription is slower than on Apple
  Silicon ([LIMITATIONS.md](LIMITATIONS.md)). The Intel build is tested in CI under Rosetta 2 on an Apple Silicon
  runner, not on Intel hardware.
- **`.recut` files** open in ReCut (double-click, or drag onto the Dock icon). Settings live in
  `~/Library/Application Support/ReCut`. To remove ReCut, move it from Applications to the Trash.
- **From source:** see [Install from source](#install-from-source) below (`brew install ffmpeg`).

<a id="macos-test-builds"></a>
### macOS test builds (CI artifacts)

Builds of commits that are not a release are kept only in CI, for 14 days: open the repository's **Actions** tab ›
**Windows build** › a run whose required jobs are green › **Artifacts** › **ReCut-macos-arm64** or
**ReCut-macos-x64** (you must be signed in to GitHub), and unzip it to get the dmg. Use the release marked **Latest**
unless you were asked to test something newer.

A test build is signed and notarized like a release when the project's signing secrets are set
([MACOS-SIGNING.md](MACOS-SIGNING.md)); otherwise it is ad-hoc signed, and the run's macos job summary says so. macOS
refuses the first launch of such a build ("Apple could not verify "ReCut" is free of malware…"): click **Done**, then
open **System Settings › Privacy & Security**, scroll to the message about ReCut and click **Open Anyway**, then
confirm with your password. On macOS 14 Sonoma and earlier you can instead right-click (Control-click) ReCut in
Applications and choose **Open**, then **Open** again. This is needed once. If macOS instead says the app "is damaged
and can't be opened" (a build whose signature was broken in transit), run
`xattr -dr com.apple.quarantine /Applications/ReCut.app` in Terminal and open it again.

macOS builds come from the `macos` job of `.github/workflows/windows.yml`, one matrix leg per processor
(`arm64`, `x64`), both on a `macos-14` (Apple Silicon) runner: `scripts/mac/get-ffmpeg.sh --arch <arm64|x64>`
downloads a pinned, checksum-verified FFmpeg build of that architecture (jellyfin-ffmpeg, the same FFmpeg 8.1 release
for both, with libx264, libx265 and libass), checks that it is that architecture only, loads only macOS's own
libraries and runs on macOS 12 or newer, and writes `FFMPEG-LICENSE.txt` and `FFMPEG-BUILD.txt` next to it;
`scripts/mac/get-whisper.sh --arch <arm64|x64>` builds the speech-to-text engine (Metal on arm64; CPU only, with
CPU-variant kernels, cross-compiled for x86_64 on Intel). The job runs the unit tests, builds the dmg, checks the code
signature of every binary in the app (plus Gatekeeper's verdict and the stapled notarization ticket), mounts the dmg
and smoke-tests the app inside it (media protocol, FFmpeg encode + probe with the bundled FFmpeg, licence files, OCR,
speech-to-text engine, UI mounted). The x64 leg runs all of this under Rosetta 2. A second job, `macos-e2e`, runs the
end-to-end suite on macOS (Apple Silicon only). Both are release gates: both dmgs are attached to each release next to
the Windows and Linux files, and a release run fails unless they are signed and notarized. Every other run keeps them
as the run's `ReCut-macos-arm64` and `ReCut-macos-x64` artifacts (see [RELEASING.md](RELEASING.md#test-builds)).

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | 20 or 22 (developed on 22) | npm comes with it. |
| FFmpeg + FFprobe | 6.0 or newer (developed on 6.1.1) | On `PATH`, set with `RECUT_FFMPEG` / `RECUT_FFPROBE`, or bundled in a package you build yourself (see [Bundling FFmpeg](#bundling-ffmpeg)). Not needed for the released Windows builds, Linux AppImage and macOS dmgs, which bundle it. |
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

The first `npm run dev` or `npm start` downloads FFmpeg into `resources/ffmpeg/` (unless it is on `PATH`) and compiles
the speech-to-text engine into `resources/whisper/` when cmake is installed (`scripts/setup-dev.mjs`; run it again with
`npm run setup`, skip it with `RECUT_SKIP_SETUP=1`). See [CONTRIBUTING.md](../CONTRIBUTING.md#development-setup).

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
- **Verified on Linux, in CI:** the x86-64 AppImage (`package.json` → `build.linux`, file name
  `ReCut-<version>-linux-x86_64.AppImage`). The `linux` job builds it on `ubuntu-22.04` with FFmpeg bundled and
  launches the AppImage itself (see [Linux in one step](#linux-in-one-step)). To build it yourself:
  `./scripts/linux/get-ffmpeg.sh && ./scripts/linux/get-whisper.sh && npm run build && npx electron-builder --linux AppImage --x64 --publish never`
  (`get-whisper.sh` compiles the speech-to-text engine from its pinned source: it needs cmake and a C++ compiler and
  takes a few minutes; without `resources/whisper/` the package has no transcription).
  `npm run package` produces `release/linux-unpacked/` with the `recut` executable.
- **Verified and released, built on macOS by CI:** the Apple Silicon and Intel dmgs (`package.json` →
  `build.mac`, file names `ReCut-<version>-macos-arm64.dmg` and `ReCut-<version>-macos-x64.dmg`, macOS 12 or newer),
  signed and notarized. See [macOS](#macos). To build the Apple Silicon one yourself on an Apple Silicon Mac:
  `./scripts/mac/get-ffmpeg.sh && ./scripts/mac/get-whisper.sh && npm run build && CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dmg --arm64 --publish never -c.mac.identity=- -c.mac.timestamp=none --no-config.mac.hardenedRuntime`
  (an ad-hoc signed build; with a Developer ID in your keychain, leave out everything after `--publish never`). For
  the Intel one, run `./scripts/mac/get-ffmpeg.sh --arch x64 && ./scripts/mac/get-whisper.sh --arch x64` instead
  (on Apple Silicon this needs Rosetta 2: `softwareupdate --install-rosetta --agree-to-license`) and `--x64` instead of
  `--arm64`. `resources/ffmpeg/` and `resources/whisper/` hold one architecture at a time, so fetch them again before
  building the other dmg. Signing and notarization in CI: [MACOS-SIGNING.md](MACOS-SIGNING.md). Windows code
  signing is not set up.
- A package you build yourself does **not** include FFmpeg unless `resources/ffmpeg/` exists when you build it, so
  its users install FFmpeg themselves as described above (on Windows, `Start ReCut.cmd` may already have downloaded
  it there). The Windows builds, the Linux AppImage and the macOS dmgs from CI are the published builds that bundle
  FFmpeg: the workflow downloads it into `resources/ffmpeg/` before packaging. To ship it inside your own package, see
  [Bundling FFmpeg](#bundling-ffmpeg).

### Bundling FFmpeg

`package.json` → `build.extraResources` copies the folder `resources/ffmpeg/` into the packaged app as
`<resources>/ffmpeg/`. The folder is not in the repository (it is git-ignored). When it does not exist, the package is
built without FFmpeg. To bundle FFmpeg:

1. Download **static** builds of `ffmpeg` and `ffprobe` for the target platform, for example from BtbN (Linux and
   Windows), jellyfin-ffmpeg (macOS, Apple Silicon and Intel) or gyan.dev (Windows). Use builds that include libx264.
   On Windows, `scripts/windows/get-ffmpeg.ps1` does this step and steps 2 and 3 for you, including the licence files
   below; on x86-64 Linux, `scripts/linux/get-ffmpeg.sh` does (it also checks that the binaries need nothing but
   glibc); on a Mac, `scripts/mac/get-ffmpeg.sh` does, for Apple Silicon or with `--arch x64` for Intel (it also
   checks that the binaries are that architecture only, load only macOS's own libraries and run on macOS 12).
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
publishing the source next to the package. `THIRD_PARTY_NOTICES.md` describes what the Windows, Linux and macOS releases
ship. This is
a description of common practice, not legal advice.

Build one package per platform: the binaries are platform-specific.

## First launch

1. ReCut opens the **Editing** workspace with an empty project, the default bins (Audio, Graphics, Misc, Movies,
   Scenes, Timelines, Subtitles, TV), and **Timeline 01** (1920×1080, 23.976 fps, stereo, 48 kHz).
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
| `RECUT_SMOKE_FILE` | The file the smoke test fetches (default `/usr/bin/ffmpeg`, or the Electron executable on Windows; the Linux CI job passes the AppImage itself). |
| `RECUT_SMOKE_OUT` | Also writes the smoke test's `smoke:` lines to this file (a Windows GUI app has no console). |
| `RECUT_WHISPER_CLI` | Absolute path to a `whisper-cli` to use instead of the bundled speech-to-text engine (tests, developers). ReCut never looks for one on `PATH`. |
| `RECUT_WHISPER_MODEL_URL` | Test-only base URL for Whisper model downloads, like `RECUT_OCR_LANG_URL` (loopback addresses only; any other value is ignored). |

Test and benchmark scripts use their own variables (`ATTACK_MEDIA_DIR`, `RECUT_PERF_*`). See
[DEVELOPMENT](DEVELOPMENT.md).

## Where data lives

`userData` is Electron's per-user app directory for the app name **ReCut**, unless `RECUT_USER_DATA` overrides it:
`~/.config/ReCut` (Linux), `~/Library/Application Support/ReCut` (macOS), `%APPDATA%\ReCut` (Windows).

| Data | Location |
|---|---|
| Preferences (recent projects, shortcut overrides, window bounds, last export folder, update-check setting, optional `cacheDir`) | `<userData>/prefs.json` |
| Project | Wherever you save it: `*.recut` (JSON). Saves are atomic, and the previous version is kept as `*.recut.bak`. A project that had to be repaired on open is copied to `*.recut.pre-repair-<time>` first; a damaged one opened from its `.bak` is kept as `*.recut.corrupt-<time>`. |
| Autosave of a saved project | Next to it: `<project>.recut.autosave` |
| Autosave of a never-saved project | `<userData>/autosave/untitled.recut.autosave` |
| Cache (`thumbs/`, `waves/`, `proxies/`, `scenes/`, `ocr/` for OCR results, `whisper/` for transcription results, `ids/` for content keys) | `$RECUT_CACHE_DIR`, else `cacheDir` in `prefs.json`, else `<userData>/cache` |
| OCR language data (`<code>.traineddata`, one file per installed language; `*.part` while a download runs) | `<userData>/ocr/tessdata` |
| Whisper models (`ggml-<model>.bin`; `*.part` while a download runs) and transcription temp folders (`tmp/`, removed after each job) | `<userData>/whisper/models`, `<userData>/whisper/tmp` |
| Panel layouts, the Jobs tab, Inspector collapsed sections, last export settings per project | Renderer `localStorage` (inside `userData`) |
| Export temp files | `<os tmpdir>/recut-export-<id>/` (filter script, burn-in and soft subtitles, chapters, chunks), deleted after each export. The render itself is written next to the output as `<name>.recut-part-<random>.<ext>` (`.mp4`, `.mkv`, `.mov`, `.wav`, `.flac`) and renamed at the end; if that rename fails it is kept as `<name>.recut-unsaved-<time>.<ext>`. |

Cache entries are keyed by the file's content (its size and a fingerprint of sampled blocks), so a changed source file
gets fresh thumbnails and proxies, and a moved or renamed one keeps them. You can delete the cache folder at any time;
it is rebuilt on demand. Thumbnails cached by builds before 5 October 2026 are regenerated once: the thumbnail cache
version changed when anamorphic sources started getting their display shape. Preferences › Application › **Cache
folder** shows the current location and has a **Reveal** button. The location cannot be changed from the UI: edit
`cacheDir` in `prefs.json` or set `RECUT_CACHE_DIR`.

### Network access

ReCut works offline. It uses the network only for three things, each of which you start or allow yourself:

- **An OCR language install** (**File › OCR Languages…** › **Install**, the Read with OCR dialog's **Install
  <Language>** button, or Preferences › Application › OCR languages › **Manage…**): it downloads that one language
  file from `raw.githubusercontent.com` (Tesseract `tessdata_fast`, pinned to one commit), checks its size and SHA-256
  against the list built into ReCut and only then saves it in `<userData>/ocr/tessdata`. Where the network is
  blocked, **Install from file…** accepts the same file downloaded elsewhere, with the same SHA-256 check. Removing a
  language deletes its file; **Open folder** shows the folder. Reading subtitles with OCR itself never uses the
  network.
- **A Whisper model install** (**File › Transcription Models…** › **Install**): it downloads that one model from
  `huggingface.co` (redirected only to Hugging Face's file storage), pinned to one commit, checks its size and SHA-256
  the same way and saves it in `<userData>/whisper/models`. **Install from file…** works offline. Transcribing never
  uses the network.
- **The update check**, only after you agree to it or choose **Help › Check for Updates…**: one request to
  `api.github.com` for the latest release (see [USER-GUIDE › Updates](USER-GUIDE.md#updates)). Nothing is downloaded.

Downloads and the update check use the system proxy settings.
