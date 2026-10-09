# MKV "5.1 + stereo downmix" test: 440 Hz level 0.00078 (< 0.001) once on the macOS x64 leg

| Field | Value |
|---|---|
| Status | cannot-reproduce |
| Severity | medium |
| Area | export / tests |
| Reported by / date | Claude (CI triage), 2026-10-09 |
| Found on commit | 53a2a15 (`claude/fix-whisper-model-download`; export code identical to main 8830704) |
| Environment | GitHub Actions macos-14 (Apple Silicon), x64 leg: jellyfin-ffmpeg 8.1.3-1 `portable_mac64` under Rosetta 2, Node 22 (arm64) |

## Report

### Summary
`tests/unit/export-mkv.test.ts` › "5.1 + stereo downmix preset: AC-3 5.1 and AAC stereo of the same mix" failed on the
first attempt of windows.yml run [37945693118](https://github.com/jelloshooter848/ReCut/actions/runs/37945693118)
(job 113871241392, "macOS x64 dmg + smoke test"). The re-run (attempt 2, job 113875735536, same commit, same FFmpeg
archive) passed. If the export really produced that file, a user would get a stereo downmix with part of the dialogue
missing, and the export would still report success.

### Steps to reproduce
1. `npx vitest run tests/unit/export-mkv.test.ts` with the bundled macOS x64 FFmpeg on the x64 leg.
2. It passed in every run tried: see Verification. It failed once on CI.

### Expected
`tone(st, 440, 48000, 144000)` (the 440 Hz dialogue tone in the left channel of the AAC stereo downmix, 1–3 s of the
range) is about 0.00195, so the assertion `> 1e-3` holds.

### Actual
```
FAIL tests/unit/export-mkv.test.ts > MKV packaging export > 5.1 + stereo downmix preset: AC-3 5.1 and AAC stereo of the same mix
AssertionError: expected 0.0007768177669975493 to be greater than 0.001
 ❯ tests/unit/export-mkv.test.ts:287:42
```
The assertions before it passed: stream codecs and layouts, and both decoded tracks within 2048 samples of the range
length. The other 440 Hz checks in the same file passed in the same run (5.1 FLAC main mix, AAC main mix). These use the
same source and window, so the generated source file was fine. That attempt ran on a slow runner: the suite took
283 s against 201 s for the re-run, and `keyframes-long-expr` took 95 s against 27 s.

### Evidence
CI logs of both attempts (`mcp__github__get_job_logs`). Both attempts downloaded
`jellyfin-ffmpeg_8.1.3-1_portable_mac64-gpl.tar.xz` and ran "ffmpeg version 8.1.3-Jellyfin".

### Suspected cause (hypothesis)
Candidates when filed: (1) nondeterministic encoding (AAC encoder, threads, dither); (2) the window catching a fade
or encoder priming; (3) x64 under Rosetta 2 giving different float results; (4) a threshold too close to the real
value.

### Scope
The same `> 1e-3` whole-window pattern is in the other three tone checks of this file. Their measured level is also
about 0.00195.

---

## Verification

| Field | Value |
|---|---|
| Verified by / date | Claude (Claude Code session), 2026-10-09 |
| Verified on commit | 8830704 (main) + temporary probes 6d14f59, 8b2fbbe on `claude/fix-export-mkv-downmix-test` |
| Verdict | cannot reproduce: the export and the measurement are deterministic. The failing value is not run-to-run variation. |

What was run. Every probe built the exact export of this test: same graph and FFmpeg arguments, through `runExport`,
or the same arguments run directly. It decoded both tracks with the test's `samples()` and measured them with
`tone()`.

| Where | FFmpeg | Exports | Conditions | stereo L 440 Hz (`tone`) | Distinct results |
|---|---|---|---|---|---|
| CI macOS x64 (Rosetta 2), run [37950250856](https://github.com/jelloshooter848/ReCut/actions/runs/37950250856) | jellyfin 8.1.3 mac64 (the failing binary) | 300 | 50 rounds of 3 concurrent `runExport` + no `-t` + `-threads 1 -filter_threads 1`, alongside the full suite; plus 50 re-decodes of one file | 0.0019457921 | 1 (identical PCM MD5) |
| CI macOS x64 (Rosetta 2), run [37952116428](https://github.com/jelloshooter848/ReCut/actions/runs/37952116428) | same | 420 | 60 rounds of 7 concurrent exports (6 direct + 1 `runExport`) | 0.0019457921 | 1 |
| CI macOS arm64, run 37950250856 | jellyfin 8.1.3 macarm64 | 300 | as the first x64 row | 0.0019458646 | 1 |
| Linux container (4 cores) | jellyfin 8.1.3 linux64 | 30 + 30 + 200 | vitest loop; vitest loop pinned to one core with 3 busy loops; 200 direct runs 8 at a time | 0.0019418193 | 1 |
| Linux container | BtbN 9.0.2, Ubuntu 6.1.1 | 5, 3 | vitest loop | 0.0019419767, 0.0019460292 | 1 each |

- (1) Nondeterministic encoding is ruled out. 1,020 exports on the failing platform and binary, under up to 7-way
  contention, gave byte-identical audio. Single-threaded decoders and filters, and dropping the output `-t` (which
  turns off FFmpeg's encoder sync queue), gave the same bytes.
- (2) A fade or priming in the window is ruled out. 50 ms windows over 0–3.5 s show the 440 Hz tone steady at amplitude
  0.087–0.089 with constant phase. The 1–3 s window is 1 s from the start of the range (AAC priming) and 0.5 s from
  the end of the dialogue clip. The test has no fades.
- (3) Rosetta 2 does change the float results, but only slightly and always the same way: x64 gives 0.0019457921 and
  arm64 gives 0.0019458646, a 4e-5 relative difference.
- (4) A threshold too close to the real value is ruled out. The real level is 0.001946 in every build, 2.9 dB above
  the 0.001 threshold, and it does not vary. The failing value is 4.0 dB below the real level. That is more than 400
  times the largest difference between builds (0.01 dB).

What the failing value does fit: 0.0007768 / 0.0019458 = 0.399 = 0.632². `tone()` is a coherent (Goertzel) measure,
so this is what the window gives if the 440 Hz dialogue is present in only 63 % of it, for example a dialogue source
that goes silent at 2.264 s of the range. The synthetic case below (silence from 2.264 s) gives 0.0007755. The graph
pads every clip and output to its exact length (`apad`), so a source that ends early (FFmpeg logs "Error during
demuxing" and treats it as end of file, exit code 0) becomes silence in a full-length "successful" export. The
length checks would not see it. This is a hypothesis that fits the number. It was not observed: the failing run kept
no FFmpeg stderr and no output file, and none of the 1,020 exports did this. A 37 % uniform gain loss (-4 dB) fits
just as well, and no FFmpeg matrix in play gives that gain.

---

## Resolution

| Field | Value |
|---|---|
| Closed by / date | Claude (Claude Code session), 2026-10-09 |
| Fix | branch `claude/fix-export-mkv-downmix-test` (this commit) |
| Files changed | `tests/unit/export-mkv.test.ts`, this report |
| Regression test | `tests/unit/export-mkv.test.ts` › "5.1 + stereo downmix preset: AC-3 5.1 and AAC stereo of the same mix" |

### Root cause
Not found. The export, the decode and the measurement were deterministic in every run, on the failing platform and
binary. None of the four candidate causes holds (see Verification). The one failure was a real wrong measurement
of that run's output, or an environment fault on that runner. It was not jitter around a tight threshold. So the
threshold was not loosened: 0.00078 would have meant 37 % of the dialogue missing from the downmix.

### Fix
The test is now stricter and explains its own failures. Nothing in the export changed.
- The downmix check states the physically expected level. Every source is FFmpeg's `sine` at amplitude 1/8, made
  stereo with `-ac 2` (L = R = 0.0884). Stereo → 5.1 puts L in FL. FFmpeg's default 5.1 → stereo matrix
  (L = FL + 0.707 C + 0.707 BL, not normalised for float) gives L = FL. So `tone()` = 0.0884² / 4 = 1.953e-3, or
  -21.1 dBFS (`DOWNMIX_TONE`).
- 440 Hz (dialogue) and 660 Hz (music) are checked in both channels of the stereo downmix and in FL / FR of the 5.1
  track. Each 250 ms segment of 1–3 s must be within ±1 dB of that level. Measured segments are within ±0.05 dB on
  FFmpeg 6.1.1, 8.1.3 and 9.0.2. A wrong matrix is off by 3 dB or more (-7.7 dB for a normalised one), and a dropout
  is off by tens of dB in the segments it hits. The old check had no upper bound, allowed -2.9 dB, and passed with
  up to 28 % of the window silent.
- On failure the message lists every offending segment, then the full segment profile of both tracks, then the
  export's FFmpeg stderr (captured through `onSpawn`, since `runExport` drops stderr on success). A repeat of this
  failure would then show whether the tone stopped, had a gap or lost gain, in which track, and what FFmpeg logged.
  It would no longer be only a single number.

### Before / after
Synthetic check on a real decoded downmix (FFmpeg 8.1.3), 440 Hz part changed as described:

| Output | Whole-window `tone` | Old check (`> 1e-3`) | New check (±1 dB per 250 ms) |
|---|---|---|---|
| as exported | 0.001942 | passes | passes (all segments within 0.05 dB) |
| 440 Hz silent after 2.264 s (fits the CI value) | 0.0007755 | fails | fails: 2.25–2.50 s at -25 dB, 2.50–3.00 s below -180 dB |
| 440 Hz silent after 2.5 s (25 % of the window) | 0.001092 | **passes** | fails |
| 440 Hz at -2.5 dB (wrong gain) | 0.001092 | **passes** | fails (-2.5 dB in every segment) |

### Regression test proof
It cannot fail on the old code: the defect was not reproduced, and the old code gives the right level. To show the
failure output, the assertion was forced to fail with FFmpeg 8.1.3 (Linux):
```
segments from 1 s, 250 ms each:
  stereo L 440 Hz: -0.00 -0.04 -0.04 -0.03 -0.02 -0.02 -0.02 -0.03
  stereo L 660 Hz: -0.01 -0.01 -0.01 -0.01 -0.01 -0.01 -0.01 -0.01
  stereo R 440 Hz: -0.00 -0.04 -0.04 -0.03 -0.02 -0.02 -0.02 -0.03
  stereo R 660 Hz: -0.01 -0.01 -0.01 -0.01 -0.01 -0.01 -0.01 -0.01
  5.1 FL 440 Hz: 0.00 -0.03 -0.04 -0.02 -0.02 -0.01 -0.02 -0.03
  5.1 FL 660 Hz: -0.00 -0.00 -0.00 -0.00 -0.00 -0.00 -0.00 -0.00
  5.1 FR 440 Hz: 0.00 -0.03 -0.04 -0.02 -0.02 -0.01 -0.02 -0.03
  5.1 FR 660 Hz: -0.00 -0.00 -0.00 -0.00 -0.00 -0.00 -0.00 -0.00
FFmpeg stderr: [aist#3:0/pcm_s16le @ 0x55779c363e40] Guessed Channel Layout: stereo
```

### Tests run
- `npm run typecheck`: clean.
- `npm test`: 120 files, 2045 passed, 3 skipped.
- `tests/unit/export-mkv.test.ts` 30 times with FFmpeg 6.1.1 and 30 times with jellyfin FFmpeg 8.1.3 (Linux): 60/60
  passed (5/5 tests each).
- windows.yml on the branch: see the commit's CI run.

### Changed existing assertions
`expect(tone(st, 440, 48000, 144000)).toBeGreaterThan(1e-3)` became the per-segment ±1 dB check on 440 and 660 Hz in
both tracks. It is stricter in both directions. It was not wrong, but it was too coarse to say what went wrong.

### Compatibility risks
None. Test only.

### Follow-ups
- Suggestion, not a confirmed defect (no report filed): an export that loses source audio partway through (a demux error FFmpeg treats as end of file) is padded
  with silence and reported as a success. `runExport` drops FFmpeg's stderr when the exit code is 0, so the user gets
  no warning. Showing FFmpeg's error lines from a successful export as export warnings would make such a loss
  visible. It was not shown to be what happened here, so it is not changed in this commit.
- The other three whole-window `> 1e-3` tone checks in this file have the same coarse margin. They could use the same
  per-segment check.
