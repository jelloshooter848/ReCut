# Collect Project ignores channel proxies: "Include proxies" leaves them in the cache

| Field | Value |
|---|---|
| Status | fixed |
| Severity | medium |
| Area | project I/O (Collect Project) |
| Reported by / date | Claude (Collect round trips, 1.0 RC work), 2026-10-08 |
| Found on commit | 888c4d2 |
| Environment | Linux 6.18 (container), Node 22, FFmpeg 6.1.1; source checkout (unit test, no media decoding involved) |

## Report

### Summary
**File › Collect Project…** with **Include proxies** copies each media item's ready proxy (`MediaItem.proxy`) but not
its channel proxies (`MediaItem.channelProxies`, 0.8.0: the preview audio of a clip's channel selection, e.g. an
extracted centre channel). The collected project keeps pointing at the original computer's cache files, so the copy
references files outside the collected folder, and on another computer the preview audio of every channel selection
is rebuilt, which is what the option promises to avoid ("the copy opens without rebuilding them").

### Steps to reproduce
1. A project with a 5.1 movie clip; Clip › Extract Centre Channel (Dialogue). Wait until its preview audio is ready.
2. File › Collect Project…, **Include proxies** on, Collect.
3. Open the collected `.recut` and look at `media[<movie>].channelProxies['1.ch-FC'].path`.

Automated: `tests/unit/collect-plan.test.ts` › "channel proxies (preview audio of channel selections) follow the proxy
option like media proxies", and `tests/unit/collect-roundtrip.test.ts` (the 0.8.0 fixture with an extracted centre
channel and a downmix selection).

### Expected
The ready channel proxies are copied to `Proxies/` next to the media proxy, named after the media
(`Proxies/<media file>_ch1.ch-FC_v1.m4a`), and the collected project's `channelProxies[*].path` point at the copies.
Without the option they keep their cache paths (as media proxies do).

### Actual
`Proxies/` holds only the media proxy; `channelProxies[*].path` is still `<cache>/proxies/<key>_ch1.ch-FC_v1.m4a`.

### Evidence
```
 × planCollect > channel proxies (preview audio of channel selections) follow the proxy option like media proxies
   → expected [ 'Proxies/movie.mkv_540p_all.mp4' ] to deeply equal [ …(3) ]
 × collectedProxyName > keeps the stream and selection of a channel proxy (electron/media/channelProxy.ts channelProxyOutputPath)
   → expected 'movie.mkv_proxy.m4a' to be 'movie.mkv_ch1.ch-FC_v1.m4a'
 × Collect round trip of a 0.8.0 project ... > 'media used in sequences' with subtitles and proxies: every reference points into the collection
   → expected [ …(11) ] to deeply equal [ …(14) ]
   -   "Proxies/The Empire Strikes Back (1980).mkv_ch1.ch-FC_v1.m4a",
   -   "Proxies/The Empire Strikes Back (1980).mkv_ch1.dm-c-3-s-3_v1.m4a",
```

### Suspected cause (hypothesis)
`shared/collect.ts` predates channel proxies (0.7.0): `collectSources` only adds `m.proxy`, `rewriteCollectedProject`
only rewrites `m.proxy.path`, and `collectedProxyName`'s suffix pattern does not know the channel proxy file name, so
two channel proxies of one media would both be called `<media>_proxy.m4a` (numbered).

### Scope
Every path field of the model was checked by the round-trip test (`fileRefs` there plus a scan of every string in
the collected file); channel proxies were the only one 0.8.0 added. Whisper and OCR tracks have no file (their cues
are project data); nested sequences and keyframes hold no paths.

---

## Verification

| Field | Value |
|---|---|
| Verified by / date | Claude, 2026-10-08 |
| Verified on commit | 888c4d2 |
| Verdict | confirmed |

Reproduced with the unit tests above on 888c4d2 (all three failed as quoted). The suspected cause was right.

---

## Resolution

| Field | Value |
|---|---|
| Closed by / date | Claude, 2026-10-08 |
| Fix | branch `claude/collect-tests-080` (this commit) |
| Files changed | `shared/collect.ts` |
| Regression test | `tests/unit/collect-plan.test.ts` › "channel proxies (preview audio of channel selections) follow the proxy option like media proxies", › "keeps the stream and selection of a channel proxy"; `tests/unit/collect-roundtrip.test.ts`; `tests/e2e/collect.spec.ts` › "Collect round trip of 0.8.0 content" |

### Root cause
Collect was written for 0.7.0 content; `MediaItem.channelProxies` (0.8.0) was never added to its selection, naming
or rewrite.

### Fix
Channel proxies are treated exactly like media proxies (same option, same rules): `collectSources` adds every ready
channel proxy of a collected media item as a `proxy` source; `planCollect` already names and places proxies after
their media (and skips them when the media is not copied); `collectedProxyName` keeps the channel proxy's
`ch<stream>.<selection>_v<N>.m4a` suffix; `rewriteCollectedProject` rewrites `channelProxies[*].path` of copied
ones. Entries that are not ready (failed) are left as they are. Nothing else changes.

### Before / after
Before: the 0.8.0 round trip collected 11 files and left 2 channel proxy paths in the cache. After: 14 files, every
reference of the collected project (except the offline and the unused media item) is inside the folder and a
byte-identical copy. Without **Include proxies**, channel proxies keep their cache paths, as before.

### Regression test proof
Failing output on 888c4d2 is under Evidence. After the fix: `collect-plan.test.ts` 18/18,
`collect-roundtrip.test.ts` 4/4, `collect-project.test.ts` 7/7.

### Tests run
`npm run typecheck`: clean. `npm test`: 114 files, 1989 passed, 3 skipped. `tests/e2e/collect.spec.ts` under xvfb:
2/2 (including the new 0.8.0 round trip, which collects a real centre-channel proxy built by the app).

### Changed existing assertions
None.

### Compatibility risks
None for saved projects (no format change). A collected folder may now contain `.m4a` files under `Proxies/`.

### Follow-ups
None.
