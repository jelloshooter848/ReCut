# Default cache folder is Chromium's HTTP cache folder on Windows and macOS; Chromium can clear it

| Field | Value |
|---|---|
| Status | open |
| Severity | medium |
| Area | media/FFmpeg (cache) · packaging |
| Reported by / date | Claude (product-identity prep agent), 2026-10-09 |
| Found on commit | 0250084 (branch `claude/product-identity-prep`) |
| Environment | Windows Server 2025 and macOS 14 GitHub runners, unpackaged app (Playwright e2e), Electron 33.4.11 (Chromium 130.0.6723.191) |

## Report

### Summary
The default cache folder is `<userData>/cache` (`electron/ipc.ts` `resolveCacheDir`). Chromium keeps its own HTTP cache
in `<sessionData>/Cache` (`<sessionData>` = `<userData>` unless changed). On Windows and on macOS (case-insensitive
file systems by default) these are **the same folder**. Chromium owns that folder and, at least when it finds no valid
`Cache_Data` inside, clears it at startup: every proxy, thumbnail, waveform, scene, OCR and Whisper result the app
cached there is deleted. Linux (case-sensitive) is not affected: `cache` and `Cache` are two folders.

Users with a custom cache folder (Preferences › cache folder, `prefs.cacheDir`, or `RECUT_CACHE_DIR`) are not affected.

### Steps to reproduce
On Windows or macOS:
1. Create a user-data folder whose `cache` holds app data but no `Cache_Data`, e.g. `cache/proxies/k_540p_all.mp4`
   (what a fresh profile, a profile whose `Cache_Data` a cleaner removed, or a copied profile without it looks like).
2. Start the app on it (`RECUT_USER_DATA` set, or through the user-data migration).
3. Look in `cache/`.

`tests/e2e/user-data-migration.spec.ts` › "legacy folder only: …" did exactly this before its legacy profile was made
realistic (it now runs the app once on the profile first, so Chromium creates `Cache/Cache_Data`).

### Expected
`cache/proxies/k_540p_all.mp4` is still there; the app's cache and Chromium's HTTP cache never share a folder.

### Actual
`cache/` holds only Chromium's `Cache_Data`; `cache/proxies` is gone.

### Evidence
CI run 37972815585, job 113963498134 (End-to-end tests on Windows), the e2e assertion's evidence message after the
first start on the moved profile:

```
expected exists=false; C:\Users\RUNNER~1\AppData\Local\Temp\recut-e2e-udm-cetKRU\real\appdata\MigrationTestApp:
[autosave, blob_storage, cache, Code Cache, DawnGraphiteCache, DawnWebGPUCache, DevToolsActivePort, GPUCache,
Local Storage, lockfile, Network, prefs.json, Shared Dictionary, user-data-migration.json, whisper];
cache: [Cache_Data]; proxies: [(ENOENT)]
```

The same test failed the same way on macOS (job 113963498496, and 113958621034 on the run before) and passed on Linux
in every run. The migration itself had moved the folder intact (the other files, e.g. `whisper/models/…`, were there).

### Suspected cause (hypothesis)
Read from the shipped sources (Electron v33.4.11, Chromium 130.0.6723.191):
- Electron sets the HTTP cache directory unconditionally: `shell/browser/net/network_context_service.cc`
  `file_paths->http_cache_directory = path.Append(chrome::kCacheDirname)` (`"Cache"`), where `path` is the browser
  context path, `DIR_SESSION_DATA` (`shell/browser/electron_browser_context.cc`). The only cache switches Electron reads
  there are `--disk-cache-size` and `--disable-http-cache`; **`--disk-cache-dir` is a Chrome-layer switch and is not
  read by Electron 33** (confidence: high, from the source; not tested).
- Chromium's disk-cache backends treat their directory as theirs: when a backend fails to initialise, `CacheCreator`
  calls `CleanupDirectory(path)` (`net/disk_cache/disk_cache.cc`), which renames the whole directory to
  `old_<name>_000` and deletes it recursively (`net/disk_cache/cache_util.cc` `CleanupDirectoryInternal`); the
  blockfile backend (Windows) can also `DeleteCache(path, /*remove_folder=*/false)`, deleting every file and folder in
  it (`net/disk_cache/blockfile/backend_impl.cc`).
- The run above shows the result (`cache` emptied, `Cache_Data` created). I did not find the exact line that deletes
  the siblings of `Cache_Data` (the `Cache_Data` subfolder name is not in the files I could fetch), so **which conditions
  trigger the wipe is only partly known**:
  - observed: a `Cache` folder without `Cache_Data` (first start on such a profile) — confidence high;
  - likely: a `Cache_Data` that fails to open (corruption, a cache-format or backend change after an Electron upgrade,
    a cleaner tool or the user deleting part of it), if the reset targets `Cache` rather than `Cache_Data` —
    confidence low to medium, not reproduced.
- Real profiles that started normally have `Cache/Cache_Data`, which is presumably why this has not been reported.

### Scope
What lives under the default `cacheDir` (`electron/media/cache.ts` `CACHE_SUBDIRS`) and is at risk:

| Folder | Content | Regenerable? |
|---|---|---|
| `proxies/` | media proxies, still-image proxies, channel (preview audio) proxies | yes (re-transcode; slow for long media) |
| `thumbs/` | thumbnails and filmstrips | yes |
| `waves/` | waveform peaks | yes |
| `scenes/` | scene-detection results | yes (re-run detection) |
| `ocr/` | OCR results of bitmap subtitles | yes (re-run OCR; minutes per stream) |
| `whisper/` | Whisper transcription results | yes (re-run transcription; can take a long time on CPU) |
| `ids/` | content-key index | yes |

Nothing non-regenerable is stored under `cacheDir`: projects, autosaves, preferences, OCR languages and Whisper models
live elsewhere in `<userData>` (`autosave/`, `prefs.json`, `ocr/`, `whisper/models`), and transcripts or OCR text the
user imported are saved in the project file. The loss is time (regeneration) and, after a wipe, "N proxy files are
missing" on the next open. Also affected: `cacheSizeBytes` counts Chromium's `Cache_Data` on Windows and macOS.

### Proposed fix (not implemented here; its own PR)
Options:
1. **Disable Chromium's HTTP cache** with `app.commandLine.appendSwitch('disable-http-cache')` in `electron/main.ts`
   before `ready` (Electron reads it in `ElectronBrowserContext`: `use_cache_ = !HasSwitch(kDisableHttpCache)`). The
   app loads only local files (`file://`, `recut-media://`); its network use (update check, OCR language and Whisper
   model downloads through `net.request`/`net.fetch`) gains nothing from an HTTP cache, and big model downloads stop
   being copied into one. Chromium then never opens `<userData>/Cache`. Clean up the stale `cache/Cache_Data` once
   (only when the cache folder is the default one). Every cache path and every saved proxy path stays the same.
2. **Move Chromium's cache:** `--disk-cache-dir` is not read by Electron 33 (above), so the only lever is
   `app.setPath('sessionData', …)`, which moves Local Storage, cookies and the rest with it: the `recut.*.v1`
   localStorage keys (layout, shortcuts, export settings) would need a migration. Not recommended.
3. **Rename the app's cache folder** (e.g. `<userData>/media-cache`): move the seven subfolders once, and remap saved
   proxy paths from `<userData>/cache/…` (the remap from the user-data migration, `electron/legacyPathRemap.ts`, can
   take one more root). Works, but touches every saved path and leaves Chromium's cache beside it.

**Recommendation: option 1**, with a regression test: an e2e run on a profile whose `cache` has data and no
`Cache_Data` (the old shape of `tests/e2e/user-data-migration.spec.ts` › "legacy folder only") must keep
`cache/proxies`, on the Windows and macOS e2e jobs. Check before merging that the downloads and the update check still
work with the HTTP cache disabled (their e2e tests cover both).

---

## Verification
<!-- Filled in by whoever works the bug. -->

| Field | Value |
|---|---|
| Verified by / date | |
| Verified on commit | |
| Verdict | |

---

## Resolution
<!-- Required before moving the file to bugs/closed/. -->

| Field | Value |
|---|---|
| Closed by / date | |
| Fix | |
| Files changed | |
| Regression test | |

### Root cause

### Fix

### Before / after

### Regression test proof

### Tests run

### Changed existing assertions

### Compatibility risks

### Follow-ups
