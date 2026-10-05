# Moving a media file (same bytes, same mtime) rebuilds its thumbnails, waveform and proxy

| Field | Value |
|---|---|
| Status | open |
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
