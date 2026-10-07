# Moving a media file (same bytes, same mtime) rebuilds its thumbnails, waveform and proxy

| Field | Value |
|---|---|
| Status | fixed |
| Severity | low (performance / disk; no wrong output. On a franchise project, relinking after a drive move redoes minutes of waveform and thumbnail work and leaves orphaned cache files) |
| Area | media/FFmpeg (derived-media cache) |
| Reported by / date | Claude (Claude Code session, working bugs/closed/2026-10-05-roadmap-revisions.md), 2026-10-05 |
| Found on commit | e89fc8b |
| Environment | Linux container, Node + vitest 2.1.9, FFmpeg 6.1.1-3ubuntu5, source (no packaged app) |

## Report

### Summary

The derived-media cache key hashes the file's absolute path together with its size and mtime. Moving or copying a
file to another folder or drive, unchanged, gives it a new key, so every cache lookup misses and the work is redone.
Users who reorganise media or move it to a new drive and use Relink pay for every thumbnail and waveform again, and
for a proxy whenever one is (re)generated.

### Steps to reproduce

`tests/unit/media-move-cache.test.ts` (passes on e89fc8b; it pins the current behaviour):

1. Generate a 4 s H.264 + AAC file in `driveA/Movies/feature.mp4`.
2. Produce a thumbnail (`getThumbnail`), a waveform (`getWaveform`) and a 120p proxy (`startProxyJob`) for it. A
   second request at the same path is a cache hit (`cached: true`, no new files).
3. Copy the file to `driveB/Archive/Movies/feature.mp4`, restore its mtime with `fs.utimesSync`, delete the original
   (a cross-drive move). Size and `Math.floor(mtimeMs)` are equal.
4. Request the same thumbnail, waveform and proxy for the new path.

### Expected

Same bytes, same size, same mtime: the cached thumbnail, waveform and proxy are reused.

### Actual

- `cacheKeyForPath(newPath) !== cacheKeyForPath(oldPath)`.
- Thumbnail: a new file in a new cache directory; the frame is extracted again.
- Waveform: no `waves/<newKey>.pk` before the call; the audio is decoded again and written under the new key.
- Proxy: the job reports `cached: false` and encodes a second proxy to a new output path.
- The cache now holds every derived file twice (4 files → 8); the old-key files are orphaned.

### Evidence

```
 ✓ tests/unit/media-move-cache.test.ts (1 test) 1830ms
   ✓ derived media after moving a source file (same bytes, same mtime) > hits the cache at the same path, and misses (regenerates) at the new path
```

Cost at scale, from the perf suite on e89fc8b: a cold waveform of a 20-min file takes 4.3 s (the 2026-10-04 report
measured 29.2 s for a 120-min file); a 48-frame filmstrip takes 4.6 s cold versus 6.7 ms warm; a 540p proxy of a 60 s
720p file takes 9.5 s.

### Suspected cause (hypothesis)

`electron/media/cache.ts:44-52` `cacheKeyForFile` hashes `path.resolve(filePath)` + size + `Math.floor(mtimeMs)`.
Thumbnails (`thumbs.ts:222`, `:266`), proxies (`proxy.ts:92`, `:148`), waveforms (`index.ts:64`) and scene detection
(`sceneDetect.ts:47`) all key on it.

### Scope

- In the app, an already-ready proxy survives Relink by accident: `relinkMedia` (`src/state/store.ts:643`) does not
  touch `media.proxy`, so the project keeps pointing at the old-key proxy file while it exists in the cache. A new
  proxy is encoded when the user regenerates it, changes the media's audio stream, or the old file is gone.
- Scene detection results are stored in the project, so they are not re-run on Relink; a manual re-detect misses.
- A content-identity key (for example size + mtime + a hash of the first and last few MB; the file name alone is
  not enough) would survive moves without hashing whole files. Do not hash whole sources (40 GB remuxes). Keep old-key
  entries readable or migrate them.
- Collect / Consolidate Project and relative media roots (`docs/ROADMAP.md` §16, §17) depend on this.
- Documented in `docs/LIMITATIONS.md` → Projects.

---

## Verification
<!-- Filled in by whoever works the bug. -->

| Field | Value |
|---|---|
| Verified by / date | Claude (Claude Code session, branch `claude/collect-project`), 2026-10-07 |
| Verified on commit | fb6c7a4 (origin/main when the branch was cut) |
| Verdict | Confirmed. Reproduces as reported, and also when the file is renamed and its mtime is not kept. |

On fb6c7a4, with the electron/media sources of that commit, a move + rename that does not keep the mtime (`cp`
without `-p`) misses the thumbnail and the proxy (Linux container, Node 22.22.0, FFmpeg 6.1.1-3ubuntu5):

```
 FAIL  tests/unit/zz-before-fix.test.ts > a moved + renamed file (new mtime) reuses its thumbnail and proxy
AssertionError: expected { …(2) } to deeply equal { …(2) }
  Object {
-   "proxyCached": true,
-   "thumbnail": "/tmp/recut-before-3eWqzb/cache/thumbs/99f965830ac7d4f87736304978fbb5b09fe971c1/1000_160.jpg",
+   "proxyCached": false,
+   "thumbnail": "/tmp/recut-before-3eWqzb/cache/thumbs/581d89102dcc8f3afae970f8576720e7551b27de/1000_160.jpg",
  }
```

(A throw-away copy of the core of the regression test below, run once against the old `cache.ts`, `thumbs.ts` and
`proxy.ts` restored from fb6c7a4, then against the fixed files, where it passes; it was not committed.)

---

## Resolution
<!-- Required before moving the file to bugs/closed/. -->

| Field | Value |
|---|---|
| Closed by / date | Claude (Claude Code session, branch `claude/collect-project`, roadmap §16), 2026-10-07 |
| Fix | Derived media are keyed by a content identity (size + sampled fingerprint) instead of path + size + mtime; the old key stays a read-only fallback |
| Files changed | `electron/media/identity.ts` (new), `electron/media/cache.ts`, `electron/media/thumbs.ts`, `electron/media/waveform.ts`, `electron/media/proxy.ts`, `electron/media/sceneDetect.ts`, `electron/ocr/ocrJob.ts`, `electron/media/index.ts`; tests `tests/unit/media-move-cache.test.ts` (rewritten), `tests/unit/media-identity.test.ts` (new), `tests/unit/collect-project.test.ts` (new, Collect Project uses the fix); docs `docs/LIMITATIONS.md`, `docs/project-format.md`, `docs/ARCHITECTURE.md`, `docs/USER-GUIDE.md` |
| Regression test | `tests/unit/media-move-cache.test.ts` |

### Root cause

As suspected: `cacheKeyForFile` hashed `path.resolve(filePath)` with the size and `Math.floor(mtimeMs)`, and every
derived-media cache (thumbnails and filmstrips, waveforms, proxies, scene detection, OCR) used that key. Any change of
path, and any copy that does not keep the mtime, is a new key.

### Fix

- **Content identity** (`electron/media/identity.ts`): `fingerprintFile` is the SHA-1 of a version tag, the file size
  and nine 64 KiB blocks: the first, the last and seven evenly spaced between them (a file of at most 576 KiB is
  hashed whole). About 0.6 MB is read whatever the file size: no whole-file hashing of 40 GB remuxes. Neither the path
  nor the mtime is part of it. The probe's duration was considered and left out: it adds little over the sampled
  bytes and would tie every key to the FFmpeg version (an FFmpeg upgrade that rounds a duration differently would
  invalidate the whole cache).
- **Keys** (`electron/media/cache.ts`): `cacheKeyForPath` now returns the content key (`contentCacheKey(size,
  fingerprint)`, 40 hex characters like before, so every file-name scheme and `isThumbnailCacheFile` are unchanged).
  `cacheKeysForPath` returns it with the legacy key. A file is fingerprinted once per path + size + mtime: the result
  is kept in memory and in `<cache>/ids/<legacy key>` (a 40-byte file), so later sessions do not read the media again.
- **Legacy fallback, no mass invalidation** (`findCachedFile`): a lookup that misses under the content key tries the
  legacy key; a hit there is served and adopted under the content key with a hard link (no copy, no extra disk; on a
  file system without hard links the legacy file is simply served). Thumbnails (per frame), filmstrips, waveforms
  (`.pk` + `.json`), proxies (all-streams, fallback and still PNG), scene detection and OCR results all look up this
  way. New entries are written under the content key only. So a cache made by 0.9 and earlier keeps working at the
  same path, and once used it also survives later moves.
- **Reusable helper**: other caches keyed on a media file (the coming transcription cache) only need
  `cacheKeyForPath(path)`; `findCachedFile(await cacheKeysForPath(path), pathFor)` when they have pre-0.10 entries.

**Collision risk** (documented in `identity.ts` and LIMITATIONS): two files get one identity only when they have the
same size and the same bytes in all nine blocks. For two independent media files that does not happen in practice
(compressed data differs everywhere). The real risk is a file changed in place without changing its size, where every
changed byte lies outside the sampled blocks (a hex patch, a tag editor rewriting a fixed-size field mid-file): it
keeps its old derived media until the cache folder is cleared. A preallocated file still being downloaded (mostly
zeros) is a similar case. Remuxes and re-encodes change the size or the sampled bytes (headers at the start, index at
the end). The old key had the opposite weakness (a same-size in-place change that keeps the mtime was also missed).

### Before / after

| | Before (fb6c7a4) | After |
|---|---|---|
| Same file, same path | hit | hit |
| Moved to another folder / drive (mtime kept) | miss: thumbnails, waveform, proxy, scenes, OCR redone; cache doubled | hit, no new files |
| Moved + renamed, mtime not kept (`cp`, rsync without `-t`) | miss | hit, no new files |
| Copied by Collect Project | (did not exist) | hit: the collected project opens without any rebuild |
| Cache written by an older version, same path | hit | hit (legacy fallback), adopted by hard link |
| Content changed (bytes in a sampled block, or size) | miss | miss |
| Cost of a key | one `stat` | one `stat`; the first time per path + size + mtime, ~0.6 MB read (then memory / `ids/` index) |

### Regression test proof

`tests/unit/media-move-cache.test.ts` (rewritten; it pinned the bug before):
1. Builds a thumbnail, a 3-frame filmstrip, the waveform, a 120p proxy and scene detection for `driveA/Movies/feature.mp4`
   (8 cache files).
2. Moves it to `driveB/Archive/Renamed/Feature (2001) remux.mp4` (copy + delete) with a **different** mtime.
3. Asserts: same content key (legacy key differs), the file is fingerprinted exactly once and then remembered; the
   thumbnail, the filmstrip and the proxy path are the same files, the waveform peaks are equal, the proxy job reports
   `cached: true`, scene detection returns the cached result; the cache holds the same 8 files with unchanged mtimes
   (nothing rewritten). Control: a changed byte in a sampled block gives a different key.
4. Second test: the entries are renamed to their legacy-key names (what 0.9 leaves behind) and the in-memory index is
   cleared; the thumbnail, waveform and proxy are still served without any FFmpeg run (`cached: true`), and the only
   new files are hard links (same inode) of the legacy ones.

`tests/unit/collect-project.test.ts` also checks that a collected copy's thumbnail and proxy are cache hits.

### Tests run

- `npm run typecheck`: clean.
- `npm test` (full unit suite, after merging origin/main 38c46ec): 85 files, 1551 tests passed.
- `npm run test:e2e` (under xvfb): 68 passed, including the new `tests/e2e/collect.spec.ts`.
- `tests/unit/media-move-cache.test.ts` (2), `tests/unit/media-identity.test.ts` (8), plus the existing cache users
  `media.test.ts`, `media-input-safety.test.ts`, `sceneDetect.test.ts`, `thumbs-cache-cancel.test.ts`,
  `proxy-fallback.test.ts`, `ocr-job.test.ts`: all pass.

### Changed existing assertions

`tests/unit/media-move-cache.test.ts`: its header said a fix should invert the "misses" assertions. They are inverted
(keys equal, thumbnail / waveform / proxy reused, file count unchanged), the move is made harder (rename, mtime not
kept), scene detection and the filmstrip are added, and a legacy-fallback test is added. The same-path control is kept.

### Compatibility risks

- **No project-format change.** Proxy paths stored in projects are absolute cache paths as before; a project that
  points at a legacy-key proxy keeps using it (the file is not moved; the adopted content-key name is a hard link).
- **Cache size**: unchanged for upgraded entries (hard links). The `ids/` index adds one 40-byte file per media path
  version seen.
- **First use after upgrade**: each media file is read once (~0.6 MB, 9 seeks) when its key is first needed. On a slow
  hard disk this adds tens of milliseconds per file to the first thumbnail of each file in a session with a new
  project; later sessions use the index.
- **Hard links in the cache folder**: on FAT / exFAT (a custom `cacheDir`) adoption is skipped and legacy entries are
  read in place; nothing breaks.
- The thumbnail `Cache-Control: immutable` reasoning holds as before: a changed file gets a new key, except in the
  documented collision case.

### Follow-ups

- The `ids/` index and legacy entries are never pruned; the app still has no cache cleanup (delete the cache folder).
- `docs/ROADMAP.md` "Road to 1.0" (milestone 0.10.0) and older CHANGELOG entries link to `bugs/open/…`; the link now
  lives under `bugs/closed/` (those sections are updated by the orchestrator / release PR).
