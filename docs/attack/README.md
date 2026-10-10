# Attack reports

These reports were written by adversarial review rounds (senior editor + fan editor, UX critic, media pipeline engineer,
performance engineer, QA breakage) against earlier builds. Most findings have since been fixed; the reports are kept as
the record of what was found and why the code looks the way it does. Current open limitations live in
[`../LIMITATIONS.md`](../LIMITATIONS.md); current acceptance status lives in [`../acceptance.md`](../acceptance.md).

| Report | Repro / measurement suite | Status on the current code |
|---|---|---|
| [qa.md](qa.md) | `npx vitest run -c tests/attack-qa/vitest.config.ts` (93), `tests/attack-qa/*.spec.ts` (22) | All 84 original repro tests pass, including both quit-flow P0s and the four P1s; 9 hostile-file cases for 0.8.0 features (`hostile-080.test.ts`), one of them an `it.fails` for an open bug (below) |
| [media.md](media.md) | `npx vitest run -c tests/attack/vitest.config.ts` (118), `tests/attack/e2e` (4) | M-01…M-11 fixed; all 118 measurement tests (incl. 11 stills, 5 for 0.8.0 in `v080.test.ts`) and the 4 Chromium seek checks pass |
| [performance.md](performance.md) | `tests/perf/*` | P-01 (2,500-clip export) and P-02 (playback/scrub fps) fixed; most P2–P4 fixed. Numbers in the report are pre-fix |
| [editors.md](editors.md) | manual scenarios | P1s (timeline transport, three-point edits, auto-proxy) and most P2/P3 fixed |
| [ux.md](ux.md) | screenshots in `ux-shots/` | P1s (dialog focus/Enter, shortcut isolation, active monitor) and most P2s fixed |

## Last run: 8 October 2026 (0.8.0, commit 888c4d2)

The suites are not in CI. Before this they last ran on 5 October (with stills added on 7 October), before speech-to-text
(Whisper), MKV export, ProRes / DNxHR / WAV, channel selection, nested sequences, keyframes, Collect, the update notice,
the transition / fade fixes and the autosave fix. Run on Linux (4 cores), Node 22.22.0, FFmpeg 6.1.1, xvfb, each
suite on its own; media from `tests/attack/gen-media.sh` (plus the files `v080.test.ts` makes) in the scratch dir.

| Suite | Command | Result on main | After this run's changes |
|---|---|---|---|
| QA repro (vitest) | `npx vitest run -c tests/attack-qa/vitest.config.ts` | 84/84 pass | 93/93 (9 new) |
| QA repro (Electron) | `xvfb-run -a npx playwright test -c tests/attack-qa/playwright.config.ts` (after `npm run build`) | 22/22 pass, 1.7 min | 22/22 |
| Media measurements | `npx vitest run -c tests/attack/vitest.config.ts` | 113/113 pass, 46 s with media cached | 118/118 (5 new) |
| Chromium seek | `xvfb-run -a npx playwright test -c tests/attack/e2e/playwright.config.ts` | 4/4 pass | 4/4 |
| Performance gate | `npm run perf:check -- --skip-build` (one run) | 96/98 gates, 127/130 guardrails: FAIL | not re-run |

No existing attack test failed, so none needed updating. The performance gate's misses were all at the edge of their
budgets on a host that was not quiet (other jobs running, load 4.1 against 0.8–2.6 for the baseline) in a single run:
openProject round trip 1,080 ms and 1,092 ms incl. multi-hour (≤ 1,000 ms; 782–1,349 ms in the 7 October variance
report, `https://github.com/jelloshooter848/ReCut/blob/59eafc65917cf0d5ec5344079a5c84811bfcf80c/bugs/closed/2026-10-07-perf-gate-verdict-not-reproducible.md`), sequenceDuration 0.22 ms (≤ 0.2), planFrame
multi-hour max 8.0 ms (≤ 4; a max), filmstrip cold 3,007 ms (≤ 3,000). Classified as environment; a two-run
`npm run perf:check -- --runs 2` on a quiet machine is the way to confirm. One trend to watch there: the multi-hour
openProject main-side handler (a diagnostic) was ×1.35 its baseline.

New adversarial cases (0.8.0 features had none):

- `tests/attack-qa/hostile-080.test.ts`, hostile `.recut` files opened through `loadProjectFile`: a self-nesting
  sequence, a two-sequence cycle and a cycle inside snapshot data; a 40-deep nesting chain; nested references to a
  missing sequence and to `constructor` / `__proto__`; fan-out inside the depth limit; 100,000 keyframes with junk
  entries, out-of-range values and unknown / prototype property names; absurd channel selections and stream indices;
  a stored probe with absurd audio streams; a stored MKV probe with 500 audio and 500 subtitle streams. Each must
  load (repaired and reported) with no clip lost, build an export graph, and save / reload with nothing more to
  repair.
- `tests/attack/v080.test.ts`, real files: an MKV with 40 audio and 40 subtitle streams (probe lists all, the right
  stream is exported); channel selection on a 5.1 file whose centre alone carries a tone (FLAC: named channels; PCM in
  Matroska: no stored layout, numbered channels); a channel the stream does not have; a stored probe that claims 7.1
  for a mono file.

Bugs found:

| Bug | Severity | Status |
|---|---|---|
| [Stored probe audio streams trusted as is: a huge channel count freezes the channel menu](https://github.com/jelloshooter848/ReCut/blob/59eafc65917cf0d5ec5344079a5c84811bfcf80c/bugs/closed/2026-10-08-stored-probe-audio-streams-not-repaired.md) | medium | fixed |
| [Channel-selection warning presents a guessed layout as the stream's](https://github.com/jelloshooter848/ReCut/blob/59eafc65917cf0d5ec5344079a5c84811bfcf80c/bugs/closed/2026-10-08-channel-warning-names-guessed-layout.md) | low | fixed |
| [Nested fan-out within the depth limit makes flattening exponential](https://github.com/jelloshooter848/ReCut/blob/59eafc65917cf0d5ec5344079a5c84811bfcf80c/bugs/closed/2026-10-08-nested-fan-out-flatten-blowup.md) | medium | fixed |
