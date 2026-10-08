# A project's stored probe audio streams are trusted as is: a huge channel count freezes the channel menu

| Field | Value |
|---|---|
| Status | fixed |
| Severity | medium |
| Area | project I/O (load-time repair) / audio channel selection |
| Reported by / date | Claude (agent, attack-suite re-run), 2026-10-08 |
| Found on commit | 888c4d2 (main, 0.8.0) |
| Environment | Linux 6.18, Node 22.22.0, source build. No media decoding involved. |

## Report

### Summary
`normalizeProject` repairs every field of a stored video stream (`repairVideoStream`) but takes the stored audio
stream entries (`MediaProbe.audio`) as they are: only non-objects are dropped. The stored probe is what the app uses
until the file is probed again, and an offline file never is. Per-clip channel selection (0.8.0) builds the Inspector's
channel menu from `streamChannelIds(stream)`, which for a stream with no known layout allocates `c0`..`c<channels-1>`.
A project whose stored probe says `channels: 1e9` therefore makes the renderer allocate a billion strings (and then a
billion `<option>`s) when a clip on that stream is selected: the window freezes and runs out of memory. Non-integer
or negative channel counts, a string or negative stream index, and wrongly typed codec / layout / sample rate also
load unchanged.

### Steps to reproduce
1. Save a project with an offline media item whose `probe.audio` is
   `[{ "index": 1, "codec": "pcm", "channels": 1000000000, "layout": "", "sampleRate": 48000 }]` and an audio clip on
   stream 1 (`tests/attack-qa/hostile-080.test.ts` › "a stored probe with absurd audio streams …").
2. Open it and select the clip: the Inspector computes `streamChannelIds` for the channel menu.

### Expected
Unusable entries are repaired on load (and reported), and the channel menu never lists more channels than a
selection can address (`CHANNEL_ID` stores `c0`..`c99`).

### Actual
The entry loads unchanged; `streamChannelIds({ channels: 1e9, layout: '' })` allocates 1e9 ids. Measured on this
host: 1e5 → 14 ms, 1e6 → 163 ms, 1e7 → 1,647 ms; 1e9 crashes the vitest worker (out of memory).

### Evidence
```
100000 100000 14 ms
1000000 1000000 163 ms
10000000 10000000 1647 ms
```
`npx vitest run tests/unit/probe-audio-repair.test.ts` on 888c4d2: `Error: Worker exited unexpectedly`.

### Suspected cause (hypothesis)
`repairProbe` (shared/project.ts) runs `objList(pr.audio)` without a per-entry repair; `streamChannelIds`
(shared/audioChannels.ts) is unbounded.

### Scope
Every reader of `AudioStreamInfo.channels` / `index` on a loaded project: Inspector channel menu, export
`audioStreamIndex` / `clipChannelPan`, stream labels.

---

## Verification

| Field | Value |
|---|---|
| Verified by / date | Claude (agent), 2026-10-08 |
| Verified on commit | 888c4d2 |
| Verdict | confirmed |

Reproduced with the unit test and the attack-qa case above; the hypothesis was right.

---

## Resolution

| Field | Value |
|---|---|
| Closed by / date | Claude (agent, attack-suite re-run), 2026-10-08 |
| Fix | branch `claude/attack-suites-rerun` |
| Files changed | `shared/project.ts`, `shared/audioChannels.ts` |
| Regression test | `tests/unit/probe-audio-repair.test.ts` (3 tests); `tests/attack-qa/hostile-080.test.ts` › "a stored probe with absurd audio streams (channel counts, indices, types) is repaired, not trusted" |

### Root cause
Stored audio stream entries had no load-time repair, and the channel-id list had no bound.

### Fix
- `repairAudioStream` in `repairProbe`: an entry without a non-negative integer `index` is dropped (reported as
  "probed audio stream without a usable index removed"; clips on it fall back to the first stream with the export's
  existing warning, as for a stream the file no longer has); `codec` and `layout` must be strings, `channels` a
  non-negative safe integer (else 0), `sampleRate` a non-negative number (else 0); `language`, `title`,
  `layoutGuessed` are removed when wrongly typed.
- `streamChannelIds` lists at most 100 numbered channels, the most a stored selection can name (`c0`..`c99`).
Smallest fix: both halves are needed, since a valid but large integer (1e9) survives the repair.

### Before / after
`streamChannelIds({ channels: 1e9 })`: out of memory → 100 ids in < 1 ms. The hostile entries above: kept as is →
repaired / dropped and reported; a valid probe reports nothing.

### Regression test proof
Before: `tests/unit/probe-audio-repair.test.ts` → `Error: Worker exited unexpectedly`; the load test alone →
`expected [ …(5) ] to deeply equal [ …(3) ]`. After: 3/3 pass; `hostile-080.test.ts` 9/9.

### Tests run
`npm run typecheck` clean; `npm test` 1989 passed, 2 skipped (115 files); attack-qa vitest 93/93; attack vitest
118/118.

### Changed existing assertions
None.

### Compatibility risks
Projects written by ReCut always have integer indices and channel counts, so they load unchanged and report nothing.
A hand-edited file with a broken entry is now repaired (the original is kept as `<file>.pre-repair-<ts>` as for any
repair).

### Follow-ups
None.
