# Whisper transcripts are early by the audio stream's start offset

| Field | Value |
|---|---|
| Status | fixed |
| Severity | medium (every cue early by the offset on files whose audio starts after the container start; a workaround is to shift the subtitle track) |
| Area | media/FFmpeg (electron/whisper/transcribeJob.ts) |
| Reported by / date | Claude (agent), found while fixing [2026-10-09-ts-late-video-export-early](../closed/2026-10-09-ts-late-video-export-early.md), 2026-10-09 |
| Found on commit | 0cf4266 |
| Environment | Ubuntu 24.04.4 LTS container, FFmpeg 6.1.1-3ubuntu5, source checkout |

## Report

### Summary
`transcribeJob.ts` extracts the stream with `-i file -map 0:<stream> … -f wav` and places cues at their offset in the
WAV. The WAV starts with the stream's first sample, not at the container start, so for a stream that starts late
(an audio track muxed with a delay, M-04) every cue is early by that delay. This is not specific to MPEG-TS: an MKV
gives the same.

### Steps to reproduce
1. ```
   ffmpeg -f lavfi -i testsrc2=s=320x240:r=25:d=6 -itsoffset 0.5 -f lavfi -i sine=frequency=1000:sample_rate=48000:duration=5 \
     -map 0:v -map 1:a -c:v libx264 -bf 0 -g 25 -c:a mp2 -f mpegts alate.ts
   ffmpeg -i alate.ts -map 0 -c copy alate.mkv
   ```
   (audio from 0.49 s after the container start)
2. Run the job's extraction command on each: `ffmpeg -i alate.mkv -map 0:1 -vn -sn -dn -ac 1 -ar 16000 -c:a pcm_s16le -f wav w.wav`
   and find the first sample above -26 dBFS.

### Expected
The tone starts about 0.5 s into the WAV (or the cue times add the stream's start offset).

### Actual
It starts at 0.010 s in both the TS and the MKV WAV, so a word spoken at source 2.0 s would be cued at about 1.5 s.
The full job (with a model) was not run.

### Suspected cause (hypothesis)
The extraction should keep the stream's offset (`-copyts`, the probed container start subtracted, and
`aresample=async=1:first_pts=0` to pad the lead, as the channel proxy does), or `segmentsToCues` should add the
stream's start offset.

### Scope
`transcribeJob.ts` only (the waveform pads the lead itself; the export and channel proxies keep the offset).

---

## Verification

| Field | Value |
|---|---|
| Verified by / date | Claude (agent), 2026-10-17 (the fix and its test are from c07893c on dev, [#157](https://github.com/jelloshooter848/ReCut/issues/157)) |
| Verified on commit | 30eb6c3 (claude/promote-0.9.0, the pick of c07893c onto the 0.9.0 cut) |
| Verdict | confirmed |

The regression test muxes the test audio into an MKV with `-itsoffset 0.5` and transcribes it with the fake engine:
without the fix its first cue starts at the same time as the plain file's (offset 0), so every cue was early by the
stream's delay, as reported. The suspected cause was right in its second form: the WAV starts with the stream's first
sample and the cue times did not add the stream's start offset.

---

## Resolution

| Field | Value |
|---|---|
| Closed by / date | Claude (agent), 2026-10-17 |
| Fix | c07893c on dev ([#157](https://github.com/jelloshooter848/ReCut/issues/157)), picked into rc for 0.9.0 as 30eb6c3; fixed in 0.9.0 |
| Files changed | electron/media/probe.ts, electron/whisper/transcribeJob.ts, shared/model.ts, shared/project.ts, tests/unit/whisper-job.test.ts |
| Regression test | tests/unit/whisper-job.test.ts::transcription job (fake engine) > a stream that starts after the file: cues and words are placed at its start offset (#157) |

### Root cause
`runTranscribe` extracts the chosen stream to a WAV that starts with the stream's first sample and placed each cue at
its offset in that WAV (plus the chunk's start). For a stream that starts after the container does, source time is
the WAV time plus the stream's start offset, which was never added.

### Fix
- The probe records an audio stream's start offset relative to the container start (`AudioStreamInfo.startTime`,
  optional, only when above 0; `streamStartOffset`, as for video). Project load validates it (finite, 0 to
  `MAX_SOURCE_SECONDS`) like the other optional stream fields.
- `runTranscribe` probes the file afresh and adds that offset to the base time passed to `segmentsToCues`, so cue and
  word times both move by it.
- `WHISPER_PIPELINE_VERSION` 7, so transcripts cached before the fix are not reused.

Adding the offset after transcription is smaller than changing the extraction (`-copyts` with padding): the audio
whisper hears is unchanged, so the text is the same.

### Before / after
On the test's MKV with the audio delayed 0.5 s: before, the first cue and its first word started at the same time as
on the undelayed file (0 s difference); after, both are 0.45 to 0.55 s later, matching the delay (words within
0.001 s of the cue's shift).

### Regression test proof
With `audioStart +` removed from the `segmentsToCues` call in electron/whisper/transcribeJob.ts (at 30eb6c3):

```
× transcription job (fake engine) > a stream that starts after the file: cues and words are placed at its start offset (#157)
AssertionError: expected 0 to be greater than 0.45
```

With the fix: `✓ … a stream that starts after the file: cues and words are placed at its start offset (#157)`.
Ubuntu 24.04.4 LTS container, FFmpeg 6.1.1-3ubuntu5.

### Tests run
On claude/release-0.9.0 (0.9.0 release prep on top of 30eb6c3): `npm run typecheck` clean; `npm test` 2284 passed,
6 skipped (bundled-engine and PowerShell tests).

### Changed existing assertions
None.

### Compatibility risks
`AudioStreamInfo.startTime` is optional: projects from earlier versions open unchanged, and older versions ignore
the field. Transcripts cached by earlier versions are made again on the next transcription (pipeline version 7);
transcript tracks already in a project are not moved, so a track made before the fix stays early until the media is
transcribed again.

### Follow-ups
None.
