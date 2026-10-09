# Export silently pads truncated or damaged sources: FFmpeg exits 0, its errors are thrown away

| Field | Value |
|---|---|
| Status | fixed |
| Severity | high (the export "succeeds" with a frozen, silent stretch and no warning; the user finds out after delivering the file) |
| Area | export (electron/export/exporter.ts runExport / runFfmpeg) |
| Reported by / date | Claude (agent), found while investigating a CI test failure, 2026-10-09 |
| Found on commit | 60c044d (ReCut 0.8.1) |
| Environment | Ubuntu 24.04.4 LTS container, FFmpeg 6.1.1-3ubuntu5, Node 22.22.0, source checkout |

## Report

### Summary
`runExport` discards FFmpeg's stderr when FFmpeg exits with code 0. FFmpeg exits 0 when a source ends early
(truncated download or copy), has a decode error partway through, or has corrupt packets, and the render graph pads
every clip to its full length (`tpad=stop_mode=clone`, `apad`). The export finishes, the file has the right
duration, and the part past the damage is one frozen frame and silence. ReCut shows "Export complete" with no
warning. A truncated file whose index survived (a faststart MP4, an MKV) still probes at its full length, so the
pre-export checks ("Clips run past the end of their media") see nothing either.

### Steps to reproduce
1. Make a 10 s source and cut it to half its bytes:
   ```
   ffmpeg -f lavfi -i testsrc2=size=320x240:rate=24:duration=10 -f lavfi -i sine=frequency=440:duration=10:sample_rate=48000 \
     -c:v libx264 -preset ultrafast -c:a aac full.mkv
   head -c $(( $(stat -c %s full.mkv) / 2 )) full.mkv > trunc.mkv
   ffprobe -v warning -show_entries format=duration -of csv=p=0 trunc.mkv   # 10.021000
   ```
2. Import `trunc.mkv`, put source 1–9 s on the timeline (V + A), export.
3. Or run `tests/unit/export-source-problems.test.ts` on 60c044d.

### Expected
The export finishes (the rest of the timeline is fine) and warns that `trunc.mkv` could not be read in full, naming
the file and the time.

### Actual
`runExport` resolves with `warnings: []`; the dialog shows "Export complete" with no warnings and the toast says
"Export finished: out.mp4". The 8 s output, measured with `volumedetect` and a frame hash per 0.5 s window:

```
t=1   mean_volume: -24.1 dB frame=fa070889
t=3   mean_volume: -24.1 dB frame=63771172
t=4.5 mean_volume: -91.0 dB frame=519bc55c
t=6   mean_volume: -91.0 dB frame=519bc55c
t=7.5 mean_volume: -91.0 dB frame=519bc55c
```

From 4.02 s (source 5.02 s, where the data ends) to 8 s: the same frame and digital silence.

### Evidence
What FFmpeg 6.1.1 prints at the exporter's `-loglevel warning` for an export-like command (`-ss 2 -t 6.25` on two
inputs, trim + tpad / apad), all with **exit 0**:

Faststart MP4 cut in half (moov intact, probes as 10 s):
```
[mov,mp4,m4a,3gp,3g2,mj2 @ 0x5605d27e0dc0] Packet corrupt (stream = 0, dts = 60928).
[NULL @ 0x5605d27e1640] Invalid NAL unit size (3011 > 1901).
[NULL @ 0x5605d27e1640] missing picture in access unit with size 1905
[in#0/mov,mp4,m4a,3gp,3g2,mj2 @ 0x5605d27e0cc0] corrupt input packet in stream 0
[mov,mp4,m4a,3gp,3g2,mj2 @ 0x5605d27e0dc0] stream 0, offset 0x7f2d6: partial file
[h264 @ 0x5605d2800fc0] Invalid NAL unit size (3011 > 1901).
[h264 @ 0x5605d2800fc0] Error splitting the input into NAL units.
[mov,mp4,m4a,3gp,3g2,mj2 @ 0x5605d28b5bc0] stream 1, offset 0x7f15c: partial file
[vist#0:0/h264 @ 0x5605d2884180] Decoding error: Invalid data found when processing input
```
MKV cut in half (probes as 10.02 s):
```
[matroska,webm @ 0x561cfac66dc0] File ended prematurely
    Last message repeated 2 times
[matroska,webm @ 0x561cfacb73c0] File ended prematurely
    Last message repeated 2 times
```
MP4 with 40 kB of garbage at 40 % (80 lines; by count):
```
18 [aist#1:1/aac @ 0x?] Error submitting packet to decoder: Invalid data found when processing input
17 [aac @ 0x?] channel element 2.13 is not allocated
 9 [h264 @ 0x?] Error splitting the input into NAL units.
 5 [vist#0:0/h264 @ 0x?] Error submitting packet to decoder: Invalid data found when processing input
 ...
```
MKV with garbage in the middle: `[matroska,webm @ 0x?] 0x00 at pos 457210 (0x6f9fa) invalid as first byte of an EBML number` (4 times).
A 4 s file where the project's probe says 10 s (replaced after import), read to 9 s: **nothing at all** on stderr.
A non-faststart MP4 cut in half: `moov atom not found` / `Invalid data found when processing input`, exit 1 (the
export already fails, and the import probe fails too).

### Suspected cause (hypothesis)
`runFfmpeg` (electron/export/exporter.ts) keeps stderr only for the failure message: `if (code === 0) { resolve(); return; }`.
Nothing compares how far each input was actually read with what the graph needed.

### Scope
Single-pass and chunked exports (every chunk process and the join), all output formats, per-track audio exports.

---

## Verification

| Field | Value |
|---|---|
| Verified by / date | Claude (agent), 2026-10-09 |
| Verified on commit | 60c044d |
| Verdict | confirmed |

Reproduced with the commands above and with `tests/unit/export-source-problems.test.ts` (truncated MP4, truncated
MKV, short file with a stale probe, several sources, chunked export): every export resolves with `warnings: []` and
an 8 s output. The suspected cause is right; in addition, the stale-probe case shows that stderr alone is not
enough, because FFmpeg prints nothing when a file simply ends before the requested `-t`.

---

## Resolution

| Field | Value |
|---|---|
| Closed by / date | Claude (agent), 2026-10-09 |
| Fix | branch `claude/export-ffmpeg-warnings` (the commit that adds this file) |
| Files changed | electron/export/ffmpegWarnings.ts (new), electron/export/sourceCheck.ts (new), electron/export/exporter.ts, src/app/jobsRouter.ts, src/panels/export/ExportDialog.tsx, docs/USER-GUIDE.md, docs/LIMITATIONS.md, tests (below) |
| Regression test | tests/unit/export-source-problems.test.ts (9 tests); tests/unit/ffmpeg-warnings.test.ts (19 tests); tests/e2e/export-source-problems.spec.ts |

### Root cause
FFmpeg treats a short or damaged input as a recoverable condition (exit 0), and the render graph's padding (needed
for exact frame and sample counts) fills the gap. The exporter only looked at stderr on a non-zero exit.

### Fix
Two checks, both turned into export warnings (`ExportRunResult.sourceWarnings`, also first in `warnings`):

1. **Stderr classifier** (`electron/export/ffmpegWarnings.ts`). Every export FFmpeg run already used
   `-loglevel warning`; each stderr line now goes through `classifyFfmpegLine`:
   - harmless allow-list first (`HARMLESS_RULES`): deprecated pixel format, guessed channel layout, H.264 "number of
     reference frames … probably corrupt input" and "mmco: unref short failure" after a seek, HEVC/H.264 missing
     references of open-GOP leading pictures, "Last message repeated N times" (added to the previous problem's count);
   - problems (`PROBLEM_RULES`): "Invalid data found when processing input"; "error while decoding" / "Decoding error" /
     "Error submitting packet to decoder" / "Error splitting the input into NAL units" / "Invalid NAL unit size";
     "corrupt" ("Packet corrupt", "corrupt input packet", "corrupt decoded frame"); "partial file"; "File ended
     prematurely"; "moov atom not found"; Matroska "invalid as first byte of an EBML number" / "EBML header parsing
     failed"; "Truncating packet" / "Packet truncated" / "Header missing"; "Error during demuxing" / "I/O error" /
     "Read error";
   - output-side lines (`[out#…]`, `[vost#…]`, `[mux…]`, `[enc:…]`) and everything else are ignored.
   A problem is attributed to a file by FFmpeg's input index (`[in#N/…]`, `[vist#N:M/…]`, `[aist#N:M/…]`, FFmpeg ≤ 6.0
   `Error while decoding stream #N:M`), else by matching the demuxer / decoder name (`[matroska,webm @ …]`,
   `[h264 @ …]`) against the sources' probed container and codecs; when several files remain, one that ends early
   is preferred, otherwise the warning lists them. At most 2,000 problem lines are kept per run (the rest are counted).
2. **Source end check** (`planSourceEndChecks` + `electron/export/sourceCheck.ts`). For each source file and stream the
   graph reads (`[N:v:0]`, `[N:a:0]`, `[N:K]`), the furthest point read (`-ss` + `-t` − 0.25 s margin), capped at the
   probed duration (reads past it are already a pre-export warning). A demux-only ffprobe over the last 3 s before
   that point (`-read_intervals`, no decoding) finds where the data really ends; with no packets there it scans the
   whole stream (30 s timeout). Data ending more than 0.5 s early (`SOURCE_END_TOLERANCE_SEC`) is reported. Best
   effort: no ffprobe, a failure or a timeout skips the stream; cancel still cancels.

One warning per file, at most `MAX_SOURCE_WARNINGS` (5) plus "…and N more problems reported by FFmpeg." The Export
dialog's done view lists them under **Warnings** (it already listed `result.warnings`); the toast shows the first
source warning (15 s) instead of "Export warnings: …".

### Before / after
Before: all of the cases above → `warnings: []`, "Export complete", no toast warning.
After (FFmpeg 6.1.1):
- truncated MP4: `Export finished, but "trunc.mp4" ends early: its data stops at about 4.97 s, but the export reads it up to 9.00 s, so that part of the output is frozen and silent. FFmpeg reported: Packet corrupt (stream = 0, dts = 60928) (and 6 more messages). Check the file or relink it.`
- truncated MKV: `Export finished, but "trunc.mkv" ends early: its data stops at about 5.02 s, but the export reads it up to 9.00 s, so that part of the output is frozen and silent. FFmpeg reported: File ended prematurely. Check the file or relink it.`
- stale probe (FFmpeg silent): `Export finished, but "short.mp4" ends early: its data stops at about 4.00 s, but the export reads it up to 9.00 s, so that part of the output is frozen and silent. Check the file or relink it.`
- damaged middle: `Export finished, but FFmpeg reported a problem reading "corrupt.mp4": <first message> (and N more messages). Part of the output may be silent or frozen. Check the file or relink it.`

The output file itself is unchanged (still complete, same duration); only the report changes. The end check adds one
short ffprobe per source file and stream at the end of the export (about 80 ms each here, four at a time).

### Regression test proof
`tests/unit/export-source-problems.test.ts` on 60c044d (exporter unchanged):
```
× a truncated MP4 read past the cut: the export finishes and warns, naming the file
  → expected [] to have a length of 1 but got +0
× a truncated MKV read past the cut: the export finishes and warns that it ends early, at about 5 s
  → expected [] to have a length of 1 but got +0
× a file shorter than the project thinks (FFmpeg prints nothing): the export warns that it ends early
  → expected [] to have a length of 1 but got +0
× several sources: only the damaged one is named, and only reads past its cut count
  → expected [] to have a length of 1 but got +0
× chunked export: the warning still appears
  → expected [] to have a length of 1 but got +0
× clean sources (MP4 and MKV, read to their end): no warnings
  → expected undefined to deeply equal []
✓ reading only the intact part of a truncated file: no warnings
```
(The damaged-middle case was added afterwards.) With the fix: 9/9 pass.

### Tests run
- `npm run typecheck`: clean.
- `npm test`: 122 files, 2,088 passed, 3 skipped, on the code as committed. A rerun after the docs change failed 6
  tests in export.test.ts, collect-roundtrip and autosave-stream with ENOSPC / "Not enough free space": the test
  machine's disk had filled up (see Follow-ups); the code had not changed.
- No false positives: with a temporary log of every export's `sourceWarnings` and problem lines, the 193 exports of
  the unit suites that call runExport and the 75 exports of `tests/attack` (TS with a start offset, VFR, rotated,
  multi-stream sources; 118/118) and `tests/attack-qa` (94/94) all had empty `sourceWarnings` and not a single problem line.
- e2e (xvfb): export.spec.ts (now also asserts no warnings for the clean export), export-mkv.spec.ts,
  export-intermediates.spec.ts and the new export-source-problems.spec.ts passed in a full local run; the full run's
  unrelated failures were renderer crashes from a full disk (see Follow-ups). CI: windows.yml on the branch.

### Changed existing assertions
None. Added `sourceWarnings` / `warnings` emptiness checks to export.spec.ts, export-mkv.spec.ts and
export-intermediates.spec.ts.

### Compatibility risks
`ExportRunResult` gains `sourceWarnings`; `warnings` may now start with source warnings (consumers only display it).
Saved projects, export settings and output files are unchanged.

### Follow-ups
- The local test machine ran out of disk (about 39 GB usable, `resv_strict`; 13 GB of agent scratch data and about
  12 GB of `/tmp/recut-*` test leftovers from 10-04 to 10-08), which crashed renderers in unrelated e2e specs
  (program, source, timeline, transcript, update) and broke later runs. Not an app bug; the leftovers need a cleanup.
- Damage that decodes without any FFmpeg message (garbled pictures) and ends less than 0.5 s early are not reported
  (docs/LIMITATIONS.md).
- The export's own text still says "relink it", but Relink lists offline media only; the user guide explains how to
  replace an online file. A "Replace file…" for online media would make that one step.
