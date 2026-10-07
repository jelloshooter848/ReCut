# Mono sources preview 3 dB louder than they export (directly played files)

| Field | Value |
|---|---|
| Status | fixed |
| Severity | medium |
| Area | playback |
| Reported by / date | claude/mono-preview-level agent (suspicion from another agent, unmeasured), 2026-10-07 |
| Found on commit | 3adc6d3 |
| Environment | Linux 6.18 (xvfb), FFmpeg 6.1.1-3ubuntu5, Electron 33.4.11, source checkout |

## Report

### Summary
Suspected: a mono source is put into a stereo export at −3 dB per channel (FFmpeg's up-mix in the render graph), while
the Program monitor plays it at full level on both channels (Web Audio "speakers" up-mixing copies mono to L and R at
unity). Mono sources would then preview about 3 dB louder than they export, against Roadmap §2's rule that the
preview matches the export. Affects anyone editing mono dialogue, voice-over or music files.

### Steps to reproduce
1. Make a mono 1 kHz tone (peak 0.25, −15.05 dBFS RMS) and the same tone in stereo at unity on both channels.
2. Put each on its own sequence and play it in the Program monitor; measure L/R RMS of what the speakers get.
3. Export each to stereo AAC and measure L/R RMS with `astats`.

Scripted: `tests/e2e/mono-level.spec.ts` (preview) and `tests/unit/mono-level.test.ts` (export through `runExport`).

### Expected
The same per-channel level in the preview and in the export, for every path.

### Actual
Mono WAV played directly: preview −15.05 dBFS per channel, export −18.06 dBFS per channel (+3.01 dB in the preview).
Full table for every path under Verification.

### Evidence
Measurement tables under Verification.

### Suspected cause (hypothesis)
`electron/export/renderGraph.ts` `audioSegment`: `aformat=sample_fmts=fltp:channel_layouts=stereo` on a mono input
lets libswresample up-mix with its centre coefficient 1/√2. `src/playback/sequencePlayer.ts`: element source →
gain → master → `destination` (2 channels, explicit, speakers), which up-mixes mono at unity.

### Scope
Mono file played directly; mono via proxy; the mono stream of a multi-stream file; stereo sources for comparison;
`amix` (normalize=0) and any normalisation in the final mix.

---

## Verification

| Field | Value |
|---|---|
| Verified by / date | claude/mono-preview-level agent, 2026-10-07 |
| Verified on commit | 3adc6d3 |
| Verdict | partially confirmed: directly played mono streams preview +3.01 dB; mono through a proxy already matches |

**Paths read.**
- Export (`electron/export/renderGraph.ts`): each segment ends with `aresample=<SR>,aformat=sample_fmts=fltp:
  channel_layouts=stereo` (5.1 for a 5.1 export), so the up-mix happens per segment, before clip gain / volume / fades.
  Tracks are mixed with `amix=...:normalize=0` (no input scaling) and the final `aformat` is a no-op on stereo. Nothing
  else normalises.
- Proxies (`electron/media/proxy.ts` `buildProxyArgs`): `-ac <ch>` with `ch = min(req.audioChannels, 2)`, and the
  renderer never sets `audioChannels`, so every proxy stream is stereo, up-mixed by the same libswresample code. The
  −3 dB is baked into the proxy.
- Preview (`src/playback/sequencePlayer.ts`): `MediaElementAudioSourceNode` (the stream's own channel count) → gain
  (`max` mode, keeps mono) → master gain → `AudioContext.destination` (2 channels, `explicit`, `speakers`), which
  copies a mono input to L and R at unity (Web Audio spec, up-mixing "speakers": mono → stereo `L = M, R = M`).
  The planner (`src/playback/planner.ts`) chooses the proxy when proxies are on and one is ready, else the original
  when it is browser-playable. Audio-only files (WAV, MP3, M4A) and browser-playable videos without a proxy play
  directly.

**Measurements (same tone, peak 0.25 = −15.05 dBFS RMS per channel in the source).**

Export, real `runExport` (stereo AAC), per-channel RMS from `astats` (`tests/unit/mono-level.test.ts`):

| Source | Export L / R (dBFS) |
|---|---|
| stereo WAV (L = R = tone) | −15.05 / −15.05 |
| mono WAV | −18.06 / −18.06 |
| two-stream MP4, stereo stream #1 | −15.05 / −15.05 |
| two-stream MP4, mono stream #2 | −18.07 / −18.07 |
| mono AC-3 MKV | −18.07 / −18.07 |
| (the mono AC-3 MKV's proxy file, made with `buildProxyArgs`) | −18.07 / −18.07 |

Raw FFmpeg confirms the coefficient: `aformat=...:channel_layouts=stereo` on a mono −27.09 dBFS RMS tone gives
−30.10 dBFS on each channel (−3.01 dB = 1/√2); on 5.1 output it goes to the centre channel at unity.

Preview, Program monitor in Electron, master bus up-mixed to stereo exactly as the destination does, RMS over ~1 s of
playback (`tests/e2e/mono-level.spec.ts`, before the fix):

| Source | Preview L / R (dBFS) | Export | Preview − export |
|---|---|---|---|
| stereo WAV | −15.12 / −15.12 | −15.05 | ≈ 0 |
| mono WAV, direct | −15.05 / −15.05 | −18.06 | **+3.01 dB** |
| two-stream MP4, stereo #1, direct | −15.06 / −15.06 | −15.05 | ≈ 0 |
| two-stream MP4, mono #2, direct | −15.06 / −15.06 | −18.07 | **+3.01 dB** |
| mono AC-3 MKV through its proxy | −18.07 / −18.07 | −18.07 | 0 |

So the hypothesis holds for directly played mono streams and not for proxied ones. A side effect: the same mono
video sounded 3 dB louder with proxies off (or before its proxy was ready) than with proxies on.

---

## Resolution

| Field | Value |
|---|---|
| Closed by / date | claude/mono-preview-level agent, 2026-10-07 |
| Fix | branch `claude/mono-preview-level` |
| Files changed | `src/playback/mediaSource.ts`, `src/playback/planner.ts`, `docs/FORMATS.md`, `docs/ARCHITECTURE.md` |
| Regression test | `tests/unit/mono-level.test.ts` (10 tests), `tests/e2e/mono-level.spec.ts` |

### Root cause
Two up-mix conventions for the same mono stream: the export (FFmpeg / libswresample) puts mono on both channels at
1/√2, the preview's Web Audio destination at 1. Proxies were already stereo-encoded by FFmpeg, so only directly played
mono streams differed.

### Fix
The preview matches the export. `previewUpmixGain(media, usingProxy, stream)` (`src/playback/mediaSource.ts`) returns
1/√2 when the played stream is the original's and the probe says it has 1 channel, else 1, and `planFrame` folds it
into the clip's planned gain. No new nodes, no change to the export.

Why the preview side, not the export:
- The export's −3 dB equal-power up-mix is FFmpeg's convention and what the centre-channel work uses for "a single
  channel in stereo". It keeps a mono source at the same acoustic power as when it sits in the centre of a 5.1 export
  and is down-mixed to stereo (centre at 1/√2, the ITU / Web Audio / FFmpeg down-mix), so stereo and 5.1 exports of
  one sequence stay balanced.
- Changing the export would make every existing project re-export 3 dB louder on its mono material, and could push
  mixes that were levelled by ear (or by the meter) into clipping. Changing the preview only changes what is heard
  while editing, and makes it what the export has always delivered.
- Proxies already followed the export, so this also removes the 3 dB jump between proxies on and off.

### Before / after
Program monitor, per channel, preview − export: mono WAV direct +3.01 dB → 0.00 dB (−18.06 dBFS); mono stream of a
two-stream MP4 direct +3.01 dB → 0.00 dB (−18.07); mono through a proxy 0 → 0 (−18.07); stereo unchanged (−15.05 to
−15.12). Export output is unchanged.

### Regression test proof
`tests/unit/mono-level.test.ts` on the old `planner.ts` (helper present, not applied):
```
 × mono.wav: the preview plays at the export level
 × mono.wav (proxies on): the preview plays at the export level
 × multi.mp4 stream #2: the preview plays at the export level
 × previewUpmixGain > is folded into the planned gain, ...
AssertionError: channel 0: -15.05 dB vs -18.07 dB: expected 3.015912 to be less than 0.3
AssertionError: channel 0: -15.06 dB vs -18.07 dB: expected 3.0111880000000006 to be less than 0.3
      Tests  4 failed | 6 passed (10)
```
With the fix: 10/10 pass. `tests/e2e/mono-level.spec.ts` before the fix failed with `mono channel 0: expected
0.067 to be less than -2.5` (mono heard at the stereo level); after the fix it passes with the levels above.

### Tests run
`npm run typecheck`: clean. `npm test`: 1530/1530 (83 files, including `tests/unit/mono-level.test.ts` 10/10).
`npm run test:e2e` (xvfb, Linux): 68/68, including `tests/e2e/mono-level.spec.ts`. Windows and macOS not run.

### Changed existing assertions
None.

### Compatibility risks
None for projects or exports. Monitoring level of directly played mono material drops by 3 dB in the Program monitor
and Compare (both use `SequencePlayer`). The Source monitor plays the file without Web Audio and is unchanged (it has
no export counterpart). A mono stream whose probe is missing or reports no channel count keeps the old unity level.

### Follow-ups
- `bugs/closed/2026-10-07-program-meter-always-unavailable.md` (fixed on this branch): while measuring, the Program monitor's peak meter was
  found to be permanently "unavailable" in Electron (its tap throws on `ChannelSplitter.channelInterpretation`).
