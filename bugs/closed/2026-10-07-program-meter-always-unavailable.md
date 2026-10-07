# Program monitor peak meter is always "unavailable" in the app

| Field | Value |
|---|---|
| Status | fixed |
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
| Verified by / date | claude/mono-preview-level agent, 2026-10-07 |
| Verified on commit | 2ffacca |
| Verdict | confirmed |

Reproduced with the new e2e test (`tests/e2e/mono-level.spec.ts`, second test), which plays a mono WAV in the Program
monitor and reads the meter's canvas while playing: `pm-meter unavailable: L 0.000, R 0.000`. The suspected cause was
right: the `channelInterpretation` setter on the ChannelSplitter throws, `createTap` returns null.

---

## Resolution

| Field | Value |
|---|---|
| Closed by / date | claude/mono-preview-level agent, 2026-10-07 |
| Fix | branch `claude/mono-preview-level` |
| Files changed | `src/panels/program/AudioMeter.tsx` |
| Regression test | `tests/e2e/mono-level.spec.ts` › the Program meter shows a mono source on both bars at the level heard |

### Root cause
`createTap` set `channelInterpretation = 'speakers'` (and `channelCount` / `channelCountMode`) on a
ChannelSplitterNode. The Web Audio spec fixes a splitter's input to `discrete` / `explicit` / its output count, so
Chromium throws InvalidStateError; `createTap` caught it and the meter disabled itself on every play.

### Fix
The tap is master → GainNode (unity, `channelCount = 2`, `explicit`, `speakers`) → ChannelSplitter(2) → two
analysers, and `destroyTap` disconnects the new node. The gain node mixes the bus to stereo the way the destination
does (mono to L and R, 5.1 down-mixed), so the bars show what the speakers get, including the 1/√2 mono up-mix
from `bugs/closed/2026-10-07-mono-preview-level.md`. The output path is untouched (the tap is a side branch).

### Before / after
Mono WAV, 1 kHz tone, peak 0.25 played at 1/√2 (−15.05 dBFS peak, 0.749 of the −60..0 dB bar):
before `pm-meter unavailable`, L 0.000, R 0.000; after `pm-meter`, L 0.738, R 0.738.

### Regression test proof
On the old `AudioMeter.tsx`:
```
[meter] pm-meter unavailable: L 0.000, R 0.000
  ✘  2 tests/e2e/mono-level.spec.ts:180:5 › the Program meter shows a mono source on both bars at the level heard
    Error: expect(received).not.toContain(expected)
    Expected substring: not "unavailable"
    Received string:        "pm-meter unavailable"
```
With the fix: `[meter] pm-meter: L 0.738, R 0.738`, 2/2 passed.

### Tests run
TESTS_RUN

### Changed existing assertions
None.

### Compatibility risks
None: no saved data or export output involved. The meter now runs (rAF loop while playing, two 1024-sample analysers),
which it was designed to do.

### Follow-ups
None.
