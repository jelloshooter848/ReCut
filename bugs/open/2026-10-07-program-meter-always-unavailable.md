# Program monitor peak meter is always "unavailable" in the app

| Field | Value |
|---|---|
| Status | open |
| Severity | medium |
| Area | playback / UI |
| Reported by / date | claude/mono-preview-level agent, 2026-10-07 |
| Found on commit | 3adc6d3 |
| Environment | Linux 6.18 (xvfb), Electron 33.4.11 (Chromium), source checkout |

## Report

### Summary
The stereo peak meter on the Program monitor (`src/panels/program/AudioMeter.tsx`) never shows a level: as soon as
playback starts it switches to its disabled state ("Audio meter unavailable"). Users have no level meter at all, so
they cannot see clipping or judge levels while mixing.

### Steps to reproduce
1. Import any file with audio, put it on the sequence.
2. Press play in the Program monitor.
3. Look at the meter (`data-testid="program-meter"`).

Observed in `tests/e2e/mono-level.spec.ts` with a temporary probe after each of five plays:
```
[TEMP meter] pm-meter unavailable Audio meter unavailable
(x5)
```

### Expected
L / R peak bars that move with the audio; for a mono source both bars at the same level (the code comment says
"mono up-mixes to L+R").

### Actual
`class="pm-meter unavailable"`, `title="Audio meter unavailable"`, bars at the floor, on every play.

### Evidence
The same node setup in a page throws, from Chromium:
```
InvalidStateError: Failed to set the 'channelInterpretation' property on 'AudioNode': ChannelSplitter:
channelInterpretation cannot be changed from 'discrete'
```
`createTap` catches it and returns null, and `ensureTap` then sets `available = false`.

### Suspected cause (hypothesis)
`src/panels/program/AudioMeter.tsx` `createTap`: `splitter.channelInterpretation = 'speakers'`. The Web Audio spec
fixes a ChannelSplitterNode's `channelInterpretation` to `discrete` (and `channelCountMode` to `explicit`,
`channelCount` to its number of outputs), so setting it throws. Removing the line alone is not enough: with a
`discrete` input, a mono master bus would land on channel 0 only and the R bar would stay empty. A fix that worked in
the e2e measurement tap: master → GainNode (`channelCount = 2`, `channelCountMode = 'explicit'`,
`channelInterpretation = 'speakers'`) → ChannelSplitter(2) → two analysers. The unit tests only cover `peakToDb` /
`dbToPos`, and `tests/e2e/program.spec.ts` only checks the meter is visible, so this was not caught.

### Scope
Program monitor only (the Compare panel has no meter). Not a preview/export mismatch: the meter taps the bus and does
not change what is heard.

---

## Verification

| Field | Value |
|---|---|
| Verified by / date | |
| Verified on commit | |
| Verdict | |

---

## Resolution

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
