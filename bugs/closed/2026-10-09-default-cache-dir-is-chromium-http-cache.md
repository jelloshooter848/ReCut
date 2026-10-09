# Default cache folder is Chromium's HTTP cache folder on Windows and macOS; Chromium empties it at every start

| Field | Value |
|---|---|
| Status | fixed |
| Severity | high (Windows and macOS: every proxy, thumbnail, waveform, scene, OCR and Whisper result in the default cache folder is deleted at every start; all regenerable, but slow to rebuild) |
| Area | media/FFmpeg (cache) · packaging |
| Reported by / date | Claude (product-identity prep agent), 2026-10-09 |
| Found on commit | 0250084 (branch `claude/product-identity-prep`); present in every release up to 0.8.1 |
| Environment | Windows Server 2025 and macOS 14 GitHub runners, unpackaged app (Playwright e2e), Electron 33.4.11 (Chromium 130.0.6723.191) |

## Report

### Summary
The default cache folder is `<userData>/cache` (`electron/ipc.ts` `resolveCacheDir`). Chromium keeps its own HTTP cache
in `<sessionData>/Cache` (`<sessionData>` = `<userData>` unless changed). On Windows and on macOS (case-insensitive
file systems by default) these are **the same folder**. Chromium owns that folder and, **at every start**, deletes
every entry in it except its own `Cache_Data`: every proxy, thumbnail, waveform, scene, OCR and Whisper result the app
cached there is deleted. Linux (case-sensitive) is not affected: `cache` and `Cache` are two folders.

Users with a custom cache folder (Preferences › cache folder, `prefs.cacheDir`, or `RECUT_CACHE_DIR`) are not affected.

### Steps to reproduce
On Windows or macOS:
1. Create a user-data folder whose `cache` holds app data, e.g. `cache/proxies/k_540p_all.mp4`, with or without a
   `Cache_Data` beside it.
2. Start the app on it (`RECUT_USER_DATA` set, or through the user-data migration on `claude/product-identity-prep`).
3. Look in `cache/`.

`tests/e2e/user-data-migration.spec.ts` › "legacy folder only: …" on `claude/product-identity-prep` did exactly this.
`tests/e2e/default-cache.spec.ts` (this fix) does it on a profile without `Cache_Data`, on a restart of a profile the app
made (so with a Chromium-made `Cache_Data`), on a copy of that profile at a new path, and on a profile with Chromium's
leftovers.

On Linux, putting the profile on a case-insensitive mount reproduces it:
`ciopfs <back> <mnt>; RECUT_E2E_TMP=<mnt> xvfb-run -a npx playwright test -c tests/e2e/playwright.config.ts default-cache`.

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

macOS, with a realistic profile (started once by the app, so a Chromium-made `Cache/Cache_Data` existed, then moved to a
new path and started): run 37974614778, job 113969626666, after the start `cache: [Cache_Data]; proxies: [(ENOENT)]`.
Earlier macOS failures of the same test: jobs 113963498496 and 113958621034. Linux passed in every run.

### Suspected cause (hypothesis)
*As filed (superseded by the confirmed root cause below):* Electron points the HTTP cache at `<sessionData>/Cache`
unconditionally and does not read `--disk-cache-dir`; a disk-cache backend that fails to initialise cleans its
directory (`net/disk_cache/disk_cache.cc` `CleanupDirectory`); which conditions trigger the wipe was only partly known
(observed: a `Cache` folder without `Cache_Data`).

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

### Options weighed when filing
1. **Disable Chromium's HTTP cache** with `app.commandLine.appendSwitch('disable-http-cache')` before `ready`. Every
   cache path and every saved proxy path stays the same. Clean up the stale `cache/Cache_Data` once.
2. **Move Chromium's cache:** `--disk-cache-dir` is not read by Electron 33, so the only lever is
   `app.setPath('sessionData', …)`, which moves Local Storage, cookies and the rest with it: the `recut.*.v1`
   localStorage keys (layout, shortcuts, export settings) would need a migration.
3. **Rename the app's cache folder** (e.g. `<userData>/media-cache`): move the seven subfolders once and remap saved
   proxy paths. Touches every saved path and leaves Chromium's cache beside it.

Recommendation when filing: option 1. It was taken (see Resolution).

---

## Verification

| Field | Value |
|---|---|
| Verified by / date | Claude (cache-collision fix agent), 2026-10-09 |
| Verified on commit | 0cf4266 (`origin/main`, ReCut 0.8.1) |
| Verdict | confirmed; worse than reported (every start, not only a first start without `Cache_Data`) |

- **Linux, case-insensitive mount.** With the profiles on a `ciopfs` (case-insensitive FUSE) mount, all three tests of
  `tests/e2e/default-cache.spec.ts` fail on `origin/main`, with exactly the CI symptom, including the restart of a
  profile that already has a Chromium-made `Cache_Data`:
  ```
  after the first start: cache entries missing; …/userData/cache: [Cache_Data]; userData: [Code Cache, …, cache, prefs.json];
  proxies: [(ENOENT)]; thumbs: [(ENOENT)]; waves: [(ENOENT)]; scenes: [(ENOENT)]; ocr: [(ENOENT)]; whisper: [(ENOENT)]; ids: [(ENOENT)]
  after a restart: cache entries missing; …/userData/cache: [Cache_Data]; … proxies: [(ENOENT)]; … ids: [(ENOENT)]
  ```
  On an ordinary (case-sensitive) Linux folder the first two pass and `userData` holds both `cache` and `Cache`.
- **Windows and macOS CI, test only (no fix):** see Regression test proof.

---

## Resolution

| Field | Value |
|---|---|
| Closed by / date | Claude (cache-collision fix agent), 2026-10-09 |
| Fix | commit acf32aa on branch `claude/fix-chromium-cache-collision` |
| Files changed | `electron/main.ts`, `electron/chromiumCache.ts` (new), `tests/e2e/default-cache.spec.ts` (new), `tests/unit/chromium-cache.test.ts` (new), this report |
| Regression test | `tests/e2e/default-cache.spec.ts` (3 tests); `tests/unit/chromium-cache.test.ts` (8 tests) |

### Root cause
Confirmed in the shipped sources (Electron v33.4.11, Chromium 130.0.6723.191) and by the reproduction above:

- Electron gives every persistent session's network context `http_cache_directory = <sessionData>/Cache`
  (`shell/browser/net/network_context_service.cc`, `chrome::kCacheDirname`) and
  `http_cache_enabled = can_use_http_cache()`, which is `!HasSwitch("disable-http-cache")` unless the session was made
  with a `cache` option (`shell/browser/electron_browser_context.cc`). Electron 33 does not read `--disk-cache-dir`.
- `content/browser/network_service_instance_impl.cc` `CreateNetworkContextInNetworkService` calls
  `MaybeCleanCacheDirectory(params)` for every network context, so at every app start. When `http_cache_enabled` is on
  and `http_cache_directory` is set, it posts `MaybeDeleteOldCache(<sessionData>/Cache)` and moves the cache to
  `Cache/Cache_Data`. `MaybeDeleteOldCache` enumerates the folder (not recursively) and calls `DeletePathRecursively`
  on every file and folder except a folder named `Cache_Data`. It is unconditional; its comment says it "can be
  removed once all caches have been moved to the new sub-directory, around M99".
- On Windows and macOS `<userData>/Cache` is `<userData>/cache`, so the seven cache subfolders are deleted at every
  start. Chromium's other startup step for the cache (`content/browser/network_sandbox.cc`, create the folder and grant
  sandbox access) is also gated on `http_cache_enabled`.

The hypothesis in the report (a backend failing to initialise and `CleanupDirectory`) was not the cause; that path
only cleans `Cache_Data` itself.

### Fix
- `electron/main.ts`: `app.commandLine.appendSwitch('disable-http-cache')` before `ready`. `MaybeCleanCacheDirectory`
  returns early when `http_cache_enabled` is off, and nothing else in Chromium creates or cleans `<sessionData>/Cache`.
  Checked on Linux: with the switch, a fresh profile has no `Cache` folder after a start (`Code Cache`, `GPUCache`,
  `DawnGraphiteCache`, `DawnWebGPUCache`, `Shared Dictionary` are different names); without it, `Cache/Cache_Data`
  appears. Every cache path and every saved proxy path stays the same.
- Nothing in the app relies on the HTTP cache: the renderer loads only `file://` and `recut-media://` (a custom
  protocol whose responses never go through the network service's HTTP cache; the renderer's in-memory image cache and
  its held thumbnails are unaffected), and the network users are the update check (`net.fetch`, once a day at most)
  and the OCR language / Whisper model downloads (`net.request` with `cache: 'no-store'`, so they already bypassed it).
  No code sends or checks `ETag` / `If-None-Match` / `If-Modified-Since`. In development the Vite dev server is
  loaded uncached, which only costs a little time.
- `electron/chromiumCache.ts` `removeStaleChromiumCache`, called once per start from `main.ts` after the cache folder
  is resolved: removes what Chromium left in the folder in earlier versions. Rules:
  - only when the folder the app uses (RECUT_CACHE_DIR, else the preference, else the default) is the default folder
    `<userData>/cache` (resolved paths, exact comparison; a chosen folder elsewhere, or `<userData>/Cache` typed in
    another case, is left alone);
  - only directories directly inside it named `Cache_Data` (Chromium's backend folder) or `old_Cache_Data_000` …
    `old_Cache_Data_999` (a backend folder Chromium renamed for deletion: `net/disk_cache/cache_util.cc`
    `GetPrefixedName`, `old_<name>_%03d`); never a file or a symbolic link of that name, never anything else;
  - Chromium's backend file names (blockfile `index`, `data_<n>`, `f_<hex>`; simple cache `index`, `index-dir/`,
    `<hex>_0`, `<hex>_1`, `<hex>_s`, `the-real-index`) only ever exist inside the backend folder in Chromium 96 and
    later and go with it, so they are not matched at the top of the folder, where they could only be someone else's;
  - errors are logged, never thrown; the call is not awaited.
  On Linux `cache/Cache_Data` never existed, so it is a no-op there.

### Before / after
- Before, Windows and macOS: every start empties the default cache folder except `Cache_Data`.
- After: the seven cache subfolders survive every start, a restart and a move of the profile; `Cache_Data` and
  `old_Cache_Data_NNN` are removed from the default cache folder once. Linux: unchanged behaviour for the app's cache;
  Chromium no longer creates `<userData>/Cache`.

### Regression test proof
- Linux on a case-insensitive mount (`ciopfs`, `RECUT_E2E_TMP`): before, 3/3 fail (messages in Verification); after,
  3/3 pass. Ordinary Linux folder: before, tests 1 and 2 pass and test 3 fails (`Chromium's HTTP cache in the app's
  cache folder; …/userData/cache: [Cache_Data, ids, ocr, old_Cache_Data_000, proxies, scenes, thumbs, waves, whisper]`);
  after, 3/3 pass.
- CI, tests only (no fix), commit 96cb159,
  [run 37977371417](https://github.com/jelloshooter848/ReCut/actions/runs/37977371417): **3/3 fail on Windows (job
  113979722062) and on macOS (job 113979722182)**, every other e2e test passes (100). Windows, the restart case (a
  profile the app made, so with a Chromium-made `Cache_Data`):
  ```
  after a restart: cache entries missing; C:\Users\RUNNER~1\AppData\Local\Temp\recut-e2e-defcache-Z3pNBn\userData\cache: [Cache_Data];
  userData: [Cache, Code Cache, …, prefs.json]; proxies: [(ENOENT)]; thumbs: [(ENOENT)]; waves: [(ENOENT)];
  scenes: [(ENOENT)]; ocr: [(ENOENT)]; whisper: [(ENOENT)]; ids: [(ENOENT)]
  ```
  The first push of the test (commit a545a71, [run 37976420078](https://github.com/jelloshooter848/ReCut/actions/runs/37976420078),
  tests in serial mode, so only the first ran) failed the same way: Windows job 113975764693 and macOS job
  113975764833, `cache: [Cache_Data]; proxies: [(ENOENT)]`.
- CI with the fix, commit acf32aa, [run 37978830505](https://github.com/jelloshooter848/ReCut/actions/runs/37978830505):
  e2e green on Windows (job 113983863768), macOS (job 113983863892, 103/103, including `default-cache.spec.ts` 3/3,
  the Whisper model install, `ocr-languages.spec.ts` and `update.spec.ts`) and Linux (job 113983863714); unit tests,
  installer, launcher and the macOS arm64 dmg smoke test green.
- On the red run Linux failed only test 3 (job 113979721846, 102 passed): no cleanup without the fix, while
  `cache` and `Cache` are separate folders there.

### Tests run
Linux (this sandbox), on the fix: `npm run typecheck` clean; `npm test` 2097 passed, 2 skipped (123 files; the new
`tests/unit/chromium-cache.test.ts` 8/8); the full e2e suite under xvfb 100 passed, 3 skipped (`whisper.spec.ts`: no
speech-to-text engine built here), including `default-cache.spec.ts` 3/3, `ocr-languages.spec.ts` 2/2 (language
download with the HTTP cache off) and `update.spec.ts` 2/2 (update check). `default-cache.spec.ts` also 3/3 with
`RECUT_E2E_TMP` on a case-insensitive `ciopfs` mount. The Whisper model download e2e runs on the CI jobs that have the
engine (Windows, macOS, Linux).

### Changed existing assertions
None.

### Compatibility risks
- No saved path changes; projects, proxies and preferences are untouched.
- Chromium's HTTP cache is off: network requests are never answered from a disk cache. The app's network use (update
  check, model and language downloads) did not use it.
- A user who chose `<userData>/cache` itself as the cache folder in Preferences gets the same cleanup as the default
  (it is the same folder).

### Follow-ups
- On Linux, profiles from earlier versions keep a stale `<userData>/Cache/Cache_Data` (Chromium's own folder, not the
  app's). It is no longer used or grown; removing it is left to Chromium or the user.
- If ReCut ever needs Chromium's HTTP cache, it must first move it out of `<userData>/Cache` (`sessionData`), or this
  bug returns.
