# Attack reports

These reports were written by adversarial review rounds (senior editor + fan editor, UX critic, media pipeline engineer,
performance engineer, QA breakage) against earlier builds. Most findings have since been fixed; the reports are kept as
the record of what was found and why the code looks the way it does. Current open limitations live in
[`../LIMITATIONS.md`](../LIMITATIONS.md); current acceptance status lives in [`../acceptance.md`](../acceptance.md).

| Report | Repro / measurement suite | Status on the current code |
|---|---|---|
| [qa.md](qa.md) | `npx vitest run -c tests/attack-qa/vitest.config.ts` (84), `tests/attack-qa/*.spec.ts` | All 84 repro tests pass, including both quit-flow P0s and the four P1s |
| [media.md](media.md) | `npx vitest run -c tests/attack/vitest.config.ts` (102), `tests/attack/e2e` (4) | M-01…M-11 fixed; all 102 measurement tests and the 4 Chromium seek checks pass |
| [performance.md](performance.md) | `tests/perf/*` | P-01 (2,500-clip export) and P-02 (playback/scrub fps) fixed; most P2–P4 fixed. Numbers in the report are pre-fix |
| [editors.md](editors.md) | manual scenarios | P1s (timeline transport, three-point edits, auto-proxy) and most P2/P3 fixed |
| [ux.md](ux.md) | screenshots in `ux-shots/` | P1s (dialog focus/Enter, shortcut isolation, active monitor) and most P2s fixed |
