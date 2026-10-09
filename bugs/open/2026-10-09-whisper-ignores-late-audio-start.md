# Whisper transcripts are early by the audio stream's start offset

| Field | Value |
|---|---|
| Status | open |
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
