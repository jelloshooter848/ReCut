# Channel-selection warning presents a guessed layout as the stream's ("the stream (5.1) has no Centre (FC) channel")

| Field | Value |
|---|---|
| Status | fixed |
| Severity | low |
| Area | export warnings / audio channel selection |
| Reported by / date | Claude (agent, attack-suite re-run), 2026-10-08 |
| Found on commit | 888c4d2 (main, 0.8.0) |
| Environment | Linux 6.18, Node 22.22.0, FFmpeg 6.1.1-3ubuntu5, source build |

## Report

### Summary
Matroska stores no channel layout for PCM audio, so the probe guesses one from the channel count
(`layoutGuessed: true`, `layout: '5.1'`) and, by design, offers numbered channels (`c0`..`c5`) only. When a clip
on such a stream carries a named selection (a project made before a relink, or a hand-edited file), the export and
the Export dialog's check say `the stream (5.1) has no Centre (FC) channel`, which contradicts itself: a 5.1 stream
has a centre. Extract Centre Channel already words this case correctly ("6 channels in an unknown layout").

### Steps to reproduce
1. Make a 5.1 PCM Matroska file (`tests/attack/v080.test.ts` makes `centre_only51_pcm.mkv`).
2. Put an audio clip of it on the timeline with `channelSelection: { mode: 'channel', channel: 'FC' }` and export.

### Expected
The warning says the layout is unknown and the channels are numbered.

### Actual
```
Clip "centre_only51_pcm.mkv@24a": Centre (FC) cannot be used (the stream (5.1) has no Centre (FC) channel); exporting the stream's normal mix.
```

### Evidence
`tests/unit/channel-problem-guessed-layout.test.ts` on 888c4d2:
`expected 'the stream (5.1) has no Centre (FC) c…' to be 'the stream (6 channels in an unknown …'`.

### Suspected cause (hypothesis)
`channelSelectionProblem` (shared/audioChannels.ts) prints `stream.layout` without checking `layoutGuessed`.

### Scope
The export warning (renderGraph `clipChannelPan`), the Export dialog check (`src/panels/export/settings.ts`) and the
Clip Inspector's problem text all use `channelSelectionProblem`.

---

## Verification

| Field | Value |
|---|---|
| Verified by / date | Claude (agent), 2026-10-08 |
| Verified on commit | 888c4d2 |
| Verdict | confirmed |

Reproduced with a real PCM 5.1 Matroska export and the unit test.

---

## Resolution

| Field | Value |
|---|---|
| Closed by / date | Claude (agent, attack-suite re-run), 2026-10-08 |
| Fix | branch `claude/attack-suites-rerun` |
| Files changed | `shared/audioChannels.ts` |
| Regression test | `tests/unit/channel-problem-guessed-layout.test.ts` (3 tests); `tests/attack/v080.test.ts` › "PCM 5.1 in Matroska (no stored layout) …" |

### Root cause
The reason text used the guessed layout string as if ffprobe had reported it.

### Fix
For a guessed layout the reason reads `the stream (6 channels in an unknown layout) has no Centre (FC) channel; its
channels are numbered` (the "numbered" note only for a named channel). Known layouts are unchanged.

### Before / after
See Actual; after: `… Centre (FC) cannot be used (the stream (6 channels in an unknown layout) has no Centre (FC)
channel; its channels are numbered); exporting the stream's normal mix.`

### Regression test proof
Before: 2 of 3 fail (output above). After: 3/3; `tests/attack/v080.test.ts` 5/5.

### Tests run
`npm run typecheck` clean; `npm test` 1989 passed, 2 skipped; `centre-channel*.test.ts`, `audio-streams.test.ts`
58/58.

### Changed existing assertions
None.

### Compatibility risks
Warning text only.

### Follow-ups
The Clip Inspector's "Normal mix (5.1)" menu label (`src/panels/inspector/ClipInspector.tsx:409`) also shows the
guessed layout; cosmetic, not changed here.
