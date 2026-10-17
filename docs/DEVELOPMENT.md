# Developing ReCut

See [INSTALL](INSTALL.md) for prerequisites (Node 20/22, FFmpeg 6+). [ARCHITECTURE](ARCHITECTURE.md) explains how the
pieces fit together.

## Repository layout

```
shared/        Pure TypeScript shared by main and renderer. No DOM, no Node.
  model.ts       Data model (Project, MediaItem, Sequence, Track, Clip, ...), EXPORT_PRESETS
  time.ts        Rational fps (isValidFps), frames <-> seconds, timecode parse/format (SMPTE drop-frame), FPS_PRESETS
  timeline.ts    Pure timeline ops (insert/overwrite, trims, ripple, razor, slip/slide, transitions, cue resolution)
  project.ts     Project / sequence factories, normalizeProject() (load-time repair + migration), LiveView
  limits.ts      Value ranges for loaded projects and the UI (MAX_TIMELINE_FRAMES, zoom, Preferences ranges)
  media.ts       Sample aspect ratio validation and display size (export graph, preview compositor)
  pathKey.ts     Lexical path resolve + case folding for the renderer's "is this a source file?" check
  subtitles.ts   SRT / WebVTT parse + serialize
  ipc.ts         IPC channel names, request/response types, recut-media:// URL helpers
  ...            exportFormat, exportPlan, nest, keyframes, audioChannels, collect, ocr, whisper, update and more
                 (one line each in ARCHITECTURE › Shared code)
electron/      Main process
  main.ts        Window, single-instance lock, quit protocol, smoke test
  menu.ts        Application menu (sends command ids to the renderer)
  ipc.ts         ipcMain handlers (dialogs, project I/O, prefs, fs, media, jobs, export)
  preload.ts     contextBridge → window.recut
  project/       io.ts (atomic save, .bak, autosave/recovery, prefs), argv.ts (--project parsing),
                 collect.ts (Collect Project)
  media/         ffmpeg/ffprobe runners, probe, protocol + range, thumbs, waveform, proxy, channelProxy, sceneDetect,
                 subtitlesExtract, cache + identity (content keys)
  ocr/           Bitmap-subtitle OCR job, Tesseract worker pool, language installer
  whisper/       Speech-to-text job, bundled whisper-cli, model installer
  net/           Verified, resumable downloads (OCR languages, Whisper models)
  jobs/          JobQueue (lanes) + in-flight de-duplication
  export/        renderGraph.ts (pure graph builder), chunks.ts (chunk planner), exporter.ts (runs ffmpeg)
  safeMkdir.ts   Non-recursive, time-bounded output-folder creation
  pathSafety.ts  realpath / device+inode "same file as a project source?" checks (video and subtitle export)
  fs.ts          fs helpers for IPC, relink scan, guarded atomic subtitle export (writeSubtitleFile)
  updateCheck.ts Opt-in update notice (updateIpc.ts: its IPC)
  licences.ts    The licence files Help › About › Licences opens
src/           Renderer (React 18)
  main.tsx, App.tsx    Entry, shell, window.__recut automation hook
  state/         store.ts (single zustand + immer store), history.ts, mediaActions.ts (IPC-backed actions), selectors
  app/           bootstrap, editing commands (commands.ts), project lifecycle, transport registry, jobs router, dialogs
  keyboard/      Command ids, default bindings, binding engine, Keyboard Shortcuts dialog
  playback/      Clock, element pool, frame planner, SequencePlayer, SourcePlayer, SyncGroup, thumbnails
  panels/        One directory per panel (project, source, program, timeline, inspector, transcript, subtitles,
                 scenes, continuity, storyline, compare, export, jobs, markers, history) and dialog (collect, ocr,
                 whisper) + registry.ts
  components/    Layout (workspaces, tabbed zones, top bar) and UI primitives
  transcript/    Transcript index/search and TranscriptProvider implementations
  ocr/, whisper/ OCR and transcription dialog state and menu helpers
tests/         unit, e2e, attack, attack-qa, perf (see below); fixtures (a saved project per release, OCR language
               data), helpers
scripts/       dev.mjs, build-electron.mjs, make-test-media.sh, screenshot.mjs, make-project-fixture.mjs,
               third-party-notices.mjs, ocr-manifest.mjs, whisper-source.mjs, readme-media.mjs;
               linux/, mac/, windows/: get-ffmpeg and get-whisper per platform (Windows: also the launcher)
docs/          This documentation, attack reports (docs/attack), screenshots
```

Path aliases: `@shared/*` → `shared/`, `@/*` → `src/` (in `vite.config.ts` and the tsconfigs).

## Scripts

| Command | What it does |
|---|---|
| `npm run setup` | `scripts/setup-dev.mjs`: when missing, downloads FFmpeg into `resources/ffmpeg/` (skipped when `ffmpeg` and `ffprobe` are on `PATH` or `RECUT_FFMPEG` is set) and compiles the speech-to-text engine into `resources/whisper/` (skipped with a note when cmake is missing), using the `scripts/<os>/get-*` scripts below. A step that fails does not stop the app. `npm run dev` and `npm start` run it first; `RECUT_SKIP_SETUP=1` skips it. |
| `npm run dev` | Runs `npm run setup`'s checks, builds main/preload with esbuild, starts the Vite dev server on :5173, launches Electron with `RECUT_DEV_URL`. The renderer hot-reloads. Restart to pick up main-process changes. |
| `npm run build` | `vite build` → `dist/renderer` and `scripts/build-electron.mjs` → `dist/electron`. |
| `npm start` | Setup (as `npm run setup`), build, then `electron .` |
| `npm run typecheck` | `tsc --noEmit` for the renderer/shared project and for the electron project. |
| `npm test` | Vitest over `tests/unit/**/*.test.ts` (node environment). Some tests run real FFmpeg. |
| `npm run test:watch` | Vitest in watch mode. |
| `npm run test:e2e` | Build, then Playwright over `tests/e2e` (needs a display; use xvfb). |
| `npm run perf:check` | Performance gate: host calibration, node perf suite, build, Electron perf script, every budgeted row in three tiers (gates, guardrails against `tests/perf/baseline.json`, diagnostics), judged on the reference machine's scale; allow about 25 min; run it alone. See [Performance gate](#performance-gate-npm-run-perfcheck). |
| `npm run perf:compare -- <refA> <refB>` | Same-host A/B of two git refs (or checkouts): runs both perf suites interleaved on this machine and flags rows where B is worse than A beyond the noise. See [Same-host A/B](#same-host-ab-npm-run-perfcompare). |
| `npm run package` | Build, then `electron-builder --dir` → `release/<platform>-unpacked`. Windows installers are built by `.github/workflows/windows.yml`. |
| `npm run dist` | Build, then electron-builder installers (AppImage / dmg / nsis + portable exe). The Windows nsis installer and portable exe are built in CI by `.github/workflows/windows.yml`, which smoke-tests the unpacked app and a silent install (unsigned, FFmpeg bundled); its `linux` job builds the x86-64 AppImage with FFmpeg bundled (`scripts/linux/get-ffmpeg.sh`) and smoke-tests it; its `macos` job (a release gate) builds the Apple Silicon (arm64) and Intel (x64) dmgs with FFmpeg bundled (`scripts/mac/get-ffmpeg.sh --arch`) and smoke-tests each app inside its mounted dmg (the Intel one under Rosetta 2); on a release run both dmgs must be Developer ID signed and notarized (signing: `docs/MACOS-SIGNING.md`). |
| `scripts/linux/get-whisper.sh`, `scripts/windows/get-whisper.ps1`, `scripts/mac/get-whisper.sh` | Compile the speech-to-text engine (whisper.cpp, pinned and SHA-256-checked by `scripts/whisper-source.mjs`) into `resources/whisper/`, where the app finds it in development (working directory) and electron-builder bundles it. Needs cmake and a C++ compiler (Visual Studio 2022 or newer with the C++ workload on Windows, found with vswhere); a few minutes with 2 jobs. `WHISPER_WORK_DIR` (Linux / macOS) or `-WorkDir` (Windows) keeps the build for incremental rebuilds. Without it (for example when running from source with "Start ReCut.cmd"), Local Whisper says the engine is not included, the smoke test prints `whisper engine=absent`, and the engine tests are skipped. |

Run `npm run typecheck` and `npm test` before you send changes.

## Running headless

```bash
npm run build
xvfb-run -a npx electron --no-sandbox .                    # the app
RECUT_SMOKE=1 xvfb-run -a npx electron --no-sandbox .      # protocol smoke test, quits by itself
xvfb-run -a node scripts/screenshot.mjs out.png [--workspace Research] [--maximize center-bottom] [--eval '<js>']
```

For isolated runs, set `RECUT_USER_DATA` and `RECUT_CACHE_DIR` to temporary directories.

## Test media

```bash
scripts/make-test-media.sh <outdir> [short]
```

This generates copyright-free synthetic media: colour-scene "movies" with a burned-in name, timecode and frame
number, and one tone per scene. The set is:

- `movies/`: Galaxy Saga 1 (H.264/AAC), 2 (AC-3 audio), 3 (5.1), 0 (HEVC)
- `tv/Season 01/`: Station Eleven S01E01–E03
- `subs/`: matching SRTs, plus `broken.srt`
- a music file, an image, and `invalid.mp4`

`short` makes 4 s scenes. The default (`full`) makes 10 s scenes. `tests/attack/gen-media.sh <dir>` generates the
measurement set used by the media attack suite (frame counters, sync flashes and beeps, TS, VFR, rotated, multi-stream).

## Test suites

| Suite | Location | Run | Notes |
|---|---|---|---|
| Unit | `tests/unit` | `npm test` | Pure model/timeline/store/subtitle/transcript tests, plus real-FFmpeg export, probe and chunked-export checks. |
| End-to-end | `tests/e2e/*.spec.ts` | `npm run build && xvfb-run -a npx playwright test -c tests/e2e/playwright.config.ts` | Drives the built app through Playwright's Electron support. One worker. See `tests/e2e/README.md`. |
| Acceptance gauntlet | `tests/e2e/gauntlet.spec.ts` (+ `gauntlet-helpers.ts`) | `xvfb-run -a npx playwright test -c tests/e2e/playwright.config.ts tests/e2e/gauntlet.spec.ts` | Four scenario tests (basic movie edit, TV fan edit, large-media workflow, failure recovery). Each takes about 6–8 min. Logs go to `test-results/gauntlet/*.json`. Results are in `docs/acceptance.md`. |
| Media attack | `tests/attack` | `npx vitest run -c tests/attack/vitest.config.ts` and `xvfb-run -a npx playwright test -c tests/attack/e2e/playwright.config.ts` | Frame-exact and A/V-sync measurements on real FFmpeg output. Media goes to the scratch dir, or to `ATTACK_MEDIA_DIR` if set. Report: `docs/attack/media.md`. |
| QA repro suite | `tests/attack-qa` | `npx vitest run -c tests/attack-qa/vitest.config.ts` and `xvfb-run -a npx playwright test -c tests/attack-qa/playwright.config.ts` | One test per finding in `docs/attack/qa.md`. A failing test reproduces a bug that is still open. |
| Performance | `tests/perf` | `npm run perf:check` (the gate, see below), or each part: `NODE_OPTIONS=--expose-gc npx vitest run -c tests/perf/vitest.config.ts` and `xvfb-run -a -s "-screen 0 1920x1080x24" node tests/perf/electron-perf.mjs` (also `electron-probe.mjs`, `electron-cpuprof.mjs`, `electron-attrib.mjs`) | Builds a 2,500-clip project plus a 3 h multi-hour sequence (`bigProject.mjs`: `buildBigProject`, `buildLongSequence`). Variables: `RECUT_PERF_SCRATCH`, `RECUT_PERF_OUT`, `RECUT_PERF_MEDIA`, `RECUT_PERF_LONG_FILE`, `RECUT_PERF_PROFILE`, `RECUT_PERF_DISK_SHM` (the Electron scripts launch the app with `TMPDIR` on `/dev/shm` on Linux, because Playwright's `--disable-dev-shm-usage` would put Chromium's shared memory in disk-backed files under `/tmp`; `1` keeps the old behaviour, see `tests/perf/_launch-env.mjs`). Report: `docs/attack/performance.md`. |

The root Vitest config (`vite.config.ts` → `test.include`) only picks up `tests/unit`. Every other suite needs its
own `-c` config.

### Performance gate (`npm run perf:check`)

`npm run perf:check` calibrates the host (`tests/perf/calibrate.mjs`, about 15 s), runs the node perf suite, builds
the app, runs `electron-perf.mjs` under xvfb, then reads the JSON results
(`test-results/perf/{calibration,store,panels,main,export,electron}.json`). It prints the machine and its calibration
next to the baseline's, then every budgeted row in three sections, **Gates**, **Guardrails** and **Diagnostics**,
with value, the value normalized to the reference machine (when that applies), budget, baseline, ratio to the
baseline and the verdict (PASS/FAIL for gates and guardrails, a trend for diagnostics). It exits 1 if a gate or a
guardrail fails, if a suite exits non-zero, if a result file is missing, or if a guardrail row recorded in the
baseline is no longer measured. Diagnostics never change the exit code. Old result files are deleted before each run,
so a crashed suite cannot pass on stale data.

The code: `tests/perf/perf-check.mjs` (running, printing), `tests/perf/_gate.mjs` (the rules below; pure, tested by
`tests/unit/perf-gate.test.ts`), `tests/perf/calibrate.mjs` and `tests/perf/perf-compare.mjs`.

#### Tiers

Every budgeted row has a tier. The owner decided this policy on 6 October 2026:

| Tier | What it is | How it is judged |
|---|---|---|
| **gate** | User-facing hard gate: what the user directly feels. Project save time, project open / time to interactive, UI freezes (long tasks), edit commit → paint, scrub fps and re-renders per frame, sequence switch → paint, wheel scroll latency, playback fps and long tasks, keystroke / search latency, export completion. | Strict pass/fail on the bench's budget. `npm run perf:check` and Roadmap §1 completion both require every gate to pass. |
| **guardrail** | Architecture guardrail: internal costs that matter for the health of the architecture (normalizeProject, store commit times, memory and heap growth, element and audio-node growth, the autosave handler, history size, media-layer service times, render-graph build). | FAIL on a **material regression** against `tests/perf/baseline.json`, unless the PR explains it. A guardrail with a meaningful absolute budget (element creation ≤ pool size, a commit within one frame) also keeps that budget as pass/fail. A guardrail whose absolute target no longer means anything on its own marks it `reference` (shown as `ref <= …`): only the regression check applies. |
| **diagnostic** | Microbenchmark of a pure ingredient: full-project `structuredClone`, full-project `JSON.stringify` / `JSON.parse`, `serializeProject` alone, the main-side open-handler step, and similar. | Measured and reported with the trend against the baseline (`steady` / `slower` / `faster`, and whether it is within its reference budget). Never blocks. |

- **Material regression** (one constant, `REGRESSION_RULE` in `tests/perf/_gate.mjs`): the median of at
  least 2 runs is more than 1.5 × the baseline median, and more than an absolute noise floor above it (2 ms for
  `ms` rows, 8 MB for `MB` rows, none for counts), compared after normalization to the reference machine (see
  [Calibration](#calibration-and-the-reference-machine)). The floor exists because rows of a few milliseconds are not
  stable on identical code: in the two seed runs `searchTranscript regex` read 3.39 and 1.67 ms and
  `resolveSubtitleCues` 1.87 and 2.86 ms; a 0.04 → 0.07 ms change at timer resolution is not material either.
  With a single run an excess is printed as `UNCONFIRMED` and does not fail; run `--runs 2` before you call a
  regression or a fix. Guardrails with non-numeric values (`"16 / 0"`) are judged on their budget only.
- **A count with a baseline of 0 tolerates 1** (`REGRESSION_RULE.zeroBaseCount`; owner's decision, 7 October 2026).
  For a guardrail of the count / structural class (see [metric classes](#calibration-and-the-reference-machine)) whose
  baseline median is 0, the ratio rule leaves no room: 1 would fail. A median of up to 1 passes; 2 or more (also a
  median of 1.5) still fails as a regression. `pool: media elements (<video> + <audio>) created during 10 s
  playback` used to read 0–2 on unchanged code: the first playback creates the (file, slot) pairs that the earlier
  scrub rows happened to leave out of the pool. Since 9 October 2026 the row counts a replay of the same 10 s (the
  first playback, with its fps and long-task gates, runs unchanged before it), which starts with exactly the
  elements playback needs, so it reads 0 on unchanged code
  (`bugs/closed/2026-10-09-perf-pool-elements-created-during-playback.md`). Every other row is unchanged: time, rate and long-task rows with a baseline of 0, and
  count rows with a non-zero baseline (1 → 2 still fails), keep the ratio rule; the row's own budget still applies.
- **Nothing is deleted or loosened.** Re-scoping a row's tier is the only mechanism. Diagnostic rows (and
  `reference` guardrails) keep their old threshold in the row, shown as a reference, so history stays comparable.
- **Where the tier lives.** With the row, where it is recorded: `ms(section, metric, value, budget, note, tiering)`
  and `record(row, tiering)` in `tests/perf/_report.ts` (tiering = `GUARDRAIL`, `GUARDRAIL_REF` or `DIAGNOSTIC`), and
  the `tiering` argument of `ms` / `rec` in `electron-perf.mjs` (also `_electron-common.mjs`). A budgeted row
  without a tier is a **gate**, so nothing escapes the gate by omission.
- **Changing a row's tier** needs a stated reason in the PR (and an update of the table below). Do not move a row
  because it fails: the 3 h save round trip is a gate although it fails today.

#### Calibration and the reference machine

Cloud hosts of the same nominal class differ in real speed: identical code measured 1.5–2.3× slower on one 4-core
container than on another and failed 15 of 98 gates there
(`bugs/closed/2026-10-07-perf-gate-verdict-not-reproducible.md`). So every run measures the host first and judges its
rows on the scale of the **reference machine**, the machine the baseline was seeded on.

- **Calibration** (`tests/perf/calibrate.mjs`, run before each run into `<run dir>/calibration.json`; on its own:
  `node --expose-gc tests/perf/calibrate.mjs`). Three fixed workloads, each repeated after a warm-up; the score is the
  median wall time in ms (lower = faster), printed with its min–max and interquartile spread (`NOISY` when the
  interquartile range is over 15 % of the median: the host was not quiet):
  - `js`: pure JavaScript shaped like store and timeline work (a 9,000-clip sequence, copy-on-write ripple edits,
    binary search, `Map` index, filter / sort, `JSON.stringify` / `parse`, `structuredClone`, substring search),
    11 samples of 3 workloads, in Node.
  - `ffmpeg`: a fixed 1.5 s 720p libx264 `veryfast` encode on one thread (9 samples). One thread because the
    multi-threaded encode varied ±15 % between repeats on the 4-core container, one thread ±2 %.
  - `render`: inside Electron with software rendering, as the Electron bench runs: style and layout of 1,500
    absolutely positioned clip-like `div`s, forced synchronously, plus a 2D canvas raster flushed with `getImageData`
    (9 samples).
- **Ratio** `k = this host / reference` per category, from the median of the runs' calibrations (`k > 1`: this host
  is slower). Each row uses one category: FFmpeg work (the media layer: thumbnails, filmstrips, waveforms, proxies,
  export) uses `ffmpeg`; every other Electron row uses `render`; the Node suites' pure JavaScript (store, panels,
  render graph) uses `js`. A missing category falls back to `js`. Per category because they can differ: with busy
  neighbours on every core, Node slowed 2× but the Electron renderer, which Chromium runs at a raised priority, 1.1×.
- **Tolerance ±10 %** (`CALIBRATION_TOLERANCE`): within it the host counts as the reference machine and every row is
  judged raw (the calibration repeats within about ±5 % on one quiet host; the tolerance keeps that noise out of the
  verdicts). Beyond it, rows are normalized before they are judged.
- **Metric classes** (`metricClass` in `_gate.mjs`). Only time and rate rows are normalized:

  | Class | Rows | Normalized value |
  |---|---|---|
  | time | unit `ms` | `value / k` |
  | rate | unit `fps` | `min(cap, value × k)`; the cap is the display (60) or, for Program playback, the sequence rate (24). A rate within 5 % of its cap on a faster host (`k < 1`) says nothing about the reference machine and stays raw (`capped`). |
  | long-task count | `long tasks …` rows | The recorded task durations (`longTasks` on the row) re-counted against `50 ms × k` (the Long Tasks API reports tasks over 50 ms). On a faster host this is a lower bound: shorter tasks were never reported. The count itself is never scaled. |
  | count / structural | everything else: DOM nodes, renders and mutations per frame, page flips, IPC calls, pool elements, MB, frames out, strings | never normalized |

- **Gates**: the bench's own budget, applied to each run's normalized value; a gate passes when it passed in more
  than half of the runs. A row that failed for another reason (an in-page scrub that page-flipped) still fails.
  Budgets are not changed. When normalization applies, the summary says so (`VERDICTS NORMALIZED TO THE REFERENCE
  MACHINE (calibration js x1.80 …)`), prints the raw PASS/FAIL counts too, and every row whose raw verdict differs
  shows it (`(raw on this host: FAIL)`), so what a slow host's user would feel stays visible.
- **Guardrails**: budget and regression rule on the normalized value, so a slow host is not a regression and a fast
  host does not hide one (a 25 ms commit on a host 1.6× faster is 40 ms on the reference machine). **Diagnostics**:
  the trend of the normalized value.
- **Limits**: normalization models a host that is uniformly faster or slower. Waits that do not scale (the next
  vsync inside a `… -> paint` row) are scaled too, a little generous on a slow host, and a rate that drops to every
  other vsync (about 30 fps) on a slow host normalizes to its cap: rates are judged approximately. A faster host cannot show a
  regression hidden under a capped rate or a long task under 50 ms; use the reference machine or the same-host A/B
  below for those.

#### Baseline (`tests/perf/baseline.json`)

The baseline holds the median of every guardrail and diagnostic row, keyed by the stable row name
`<suite>|<section>|<metric>`, with the commit, date, run count, the machine (`nproc`, CPU, memory, kernel, Node,
FFmpeg version) and its `calibration` (each run's scores and their median): the machine it was seeded on is the
reference machine. `format: 2` added the calibration; a baseline without one makes every verdict raw. Write it from
at least two runs of each suite, alone on a quiet machine of the class the gate runs on (today the 4-core cloud
container):

```
node tests/perf/perf-check.mjs --update-baseline --reason "<why>" --machine-notes "<notes>" --from <run dir> <run dir> [...]
node tests/perf/perf-check.mjs --update-baseline --reason "<why>" --runs 2      # run, then write
```

`--from` takes the calibration from each run folder's `calibration.json`; if a run has none, the baseline is written
without calibration (a warning says so). **The baseline only changes in a PR that states why**: an accepted cost of a
feature (the regression is understood and worth it), locking in an improvement (so the guardrail protects it), or a
new reference machine. Reviewers send back a `baseline.json` change without that sentence. The exit code after
`--update-baseline` is the normal one (gates still count). Runs on any other host are normalized to the reference
machine, so no local baseline is needed; to judge a change against main on one host, use the A/B mode below.

#### Running it

- **Budgets live in the benches only.** A budgeted row is any row a bench records with a threshold (`ms(…, budget)`
  and `record({ threshold, pass })` in `tests/perf/*.perf.test.ts` via `_report.ts`, `ms` / `rec` in
  `electron-perf.mjs`). `perf-check.mjs` never re-derives a threshold. Change a budget in the bench, never in the
  gate, and do not loosen one without saying so in the PR.
- **Allow about 25 minutes.** On the 4-core cloud container one run took 14 min (node suite ~9 min including the
  chunked export of the whole 26-min sequence, build ~15 s, Electron ~4.5 min); budget more on a slower or busier
  machine, or when the test media and the 20-min long file are generated on first use. Run it **alone**: no other
  test suite, build or FFmpeg job on the machine at the same time. Before each step it waits (up to 90 s) for the
  load average to drop below half the cores, prints `nproc` and the load average, and warns when the machine is busy.
  On a host that calibrates slower than the reference machine, the node suite's test timeouts (15 min) are scaled by
  the slowest ratio (`RECUT_PERF_TIMEOUT_SCALE`), so the 8-minute full export does not time out there.
- **Treat ±30 % as noise on a single run.** On an idle 4-core container three runs agreed within about ±10 % for
  most rows, but with other jobs on the machine a single row has doubled on identical code (`serializeProject`
  344 → 704 ms; see the baseline in `bugs/closed/2026-10-05-perf-budgets-2500-clips.md`). A single run is not
  evidence of a regression or a fix, and rows within a few percent of their budget flip between runs. Compare
  medians of at least two runs: `npm run perf:check -- --runs 2` runs everything twice and reports the median per row
  with its min–max spread; a row passes its budget only when it passed in more than half of the runs.
- Options: `--skip-build` (dist/ is current), `--node-only`, `--electron-only`, `--no-calibrate` (judge raw), and
  `--from <dir> [<dir> …]` to aggregate result folders from earlier runs without running anything (for example one
  run with `RECUT_PERF_OUT=/tmp/run1`, a later one with `RECUT_PERF_OUT=/tmp/run2`, then
  `npm run perf:check -- --from /tmp/run1 /tmp/run2`); each folder's `calibration.json` comes along.

#### Same-host A/B (`npm run perf:compare`)

To judge a feature against main without re-seeding the baseline, measure both on the same machine, interleaved:

```
npm run perf:compare -- origin/main HEAD [--runs N] [--electron-only | --node-only] [--keep]
node tests/perf/perf-check.mjs --ab <checkoutA> <checkoutB> [--runs N] [--electron-only | --node-only] [--skip-build]
node tests/perf/perf-check.mjs --ab <checkoutA> <checkoutB> --from-a <dirs…> --from-b <dirs…>   # re-print earlier runs
```

`perf:compare` checks each ref out as a detached worktree under `$RECUT_PERF_SCRATCH/ab` (a ref that is a directory
is used as it is, e.g. a worktree with uncommitted changes), links this checkout's `node_modules` when the lockfiles
match (else runs `npm ci` there), and calls `perf-check.mjs --ab`. That builds each checkout once, then runs A, B, A,
B, … (`--runs` each, default 3; each side runs its own bench scripts; results in `<out>/ab/{A,B}/run-<k>`),
calibrating before each run so a change in the host's load shows. It prints, per budgeted row, A's and B's median
and min–max, B/A and the noise band, `max(10 %, A's own min–max spread / median, floor 2 ms | 8 MB | 2 fps)`.
**WORSE** means B is worse than A beyond the band in every run pair (A1/B1, A2/B2, …) and in the medians (worse =
higher time or count, lower rate); a difference in the medians only is reported as noise, and non-numeric rows report
`changed`. It exits 1 when a gate or guardrail row is WORSE. The default is 3 runs per side (owner's decision,
7 October 2026): with 2, rows flagged WORSE on this 4-core container that 3 runs showed clean (PR #49); `--runs N`
still overrides it. Both suites with the default 3 runs take about 1.5 hours, `--electron-only` about 40 minutes;
run it alone, like `perf:check`. The zero-baseline tolerance above is a guardrail rule against the baseline; the A/B
comparison has its own noise band and is unchanged.

#### Classification of every budgeted row

`{a, b}` lists the variants of a row recorded in a loop; each variant is its own row with the same tier. Suites:
`store`, `panels`, `main`, `export` = `tests/perf/*.perf.test.ts`; `electron` = `electron-perf.mjs`.

| Suite / section | Row | Tier | Reason |
|---|---|---|---|
| electron / io | saveProject round trip | gate | Project save time. |
| electron / long | saveProject round trip incl. multi-hour | gate | Save of the franchise-scale project with a 3 h sequence; user-facing (fails today, stays a gate). |
| electron / io | openProject round trip (main read+parse+normalize, IPC, renderer normalize+load) | gate | Project open / time to interactive. |
| electron / long | openProject round trip incl. multi-hour | gate | Open / time to interactive at 3 h scale. |
| electron / store | {insertFromSource overwrite, insertFromSource insert (ripple), razor all tracks, moveClips 1 clip overwrite, rippleDeleteSelected 1 clip, undo, redo} commit -> paint (median) | gate | Edit commit → paint. Measured to the next painted frame (one rAF, then a MessageChannel message); a double rAF is ≥ 33.3 ms at 60 Hz and could never meet 32 ms (owner's decision, 6 October 2026). |
| electron / long | multi-hour {insertFromSource insert (ripple), razor all tracks, moveClips 1 clip overwrite, undo} commit -> paint (median) | gate | Edit commit → paint at 3 h scale; next painted frame, as above (owner's decision, 6 October 2026). |
| electron / scrub | playhead scrub fps (rAF-driven setView) @ {zoom-to-fit (2500 clips mounted), no selection; zoom-to-fit, 50 clips selected; 1 px/frame (~120 clips mounted), no selection; 1 px/frame, 50 clips selected} | gate | Scrub fps. Measured in a timing pass with the render counter and MutationObservers off; the counter walks the whole fiber tree per commit (2–4.5 ms per frame) and was being measured too (owner's decision, 7 October 2026). |
| electron / scrub | long tasks during scrub … (same 4 variants) | gate | UI freeze while scrubbing; timing pass. |
| electron / scrub | DOM mutations per frame … and ClipView renders per frame … @ zoom-to-fit, {no selection; 50 clips selected} | gate | Re-renders per scrub frame (no page flips at zoom-to-fit); counting pass. |
| electron / scrub | DOM mutations per frame … (clips content) and ClipView renders per frame … @ 1 px/frame, {no selection; 50 clips selected} | guardrail (ref) | The view page-flips every few frames and must mount the newly visible clips, so 0 is not reachable; regression check against the baseline. The in-page rows are the 0 gates (owner's decision, 6–7 October 2026). The mutations value is the clips-content count, numeric so the regression check applies. |
| electron / scrub | page flips, playhead scrub fps, DOM mutations per frame, ClipView renders per frame, long tasks during scrub @ 1 px/frame, within the visible page, {no selection; 50 clips selected} | gate | The realistic drag: the playhead moves inside the visible page, no flips; every row fails if either pass flipped (added 6 October 2026). fps and long tasks from the timing pass, counts from the counting pass; page flips is an info row. |
| electron / long | playhead scrub fps and long tasks during scrub, multi-hour @ {zoom-to-fit, no selection; 1 px/frame, no selection; 1 px/frame, 50 clips selected; 1 px/frame, within the visible page, no selection / 50 clips selected} | gate | Scrub fps and freezes at 3 h scale; timing pass, as above. |
| electron / long | DOM mutations per frame and ClipView renders per frame, multi-hour @ {zoom-to-fit, no selection; 1 px/frame, within the visible page, no selection / 50 clips selected} | gate | Re-renders per scrub frame at 3 h scale where no page flips happen; counting pass. |
| electron / long | DOM mutations per frame (clips content) and ClipView renders per frame, multi-hour @ 1 px/frame, {no selection; 50 clips selected} | guardrail (ref) | Page-flip counts at 3 h scale, as for the 2,500-clip rows above (owner's decision, 6–7 October 2026). |
| electron / io | first edit 1 s after open -> paint (moveClips 1 clip overwrite) (2,500-clip sequence); long tasks during first edit after open -> paint (2,500-clip sequence) | gate | First edit after open → paint: the opened project is frozen in idle slices, so the first edit must not pay for it (added 7 October 2026). |
| electron / long | the same two rows incl. multi-hour (3 h sequence) | gate | First edit after open at 3 h scale. |
| electron / timeline | switch to big sequence -> first paint @ {zoom-to-fit, 1 px/frame, frame level 20 px/frame} | gate | Sequence switch → paint. |
| electron / timeline | long tasks in 2.5 s after switch @ {same 3} | gate | UI freeze after a switch. |
| electron / switch | switch sequence x20 -> paint (median) | gate | Sequence switch → paint. |
| electron / long | switch to multi-hour sequence -> first paint @ {zoom-to-fit, 1 px/frame}; switch to multi-hour x10 -> paint (median) | gate | Sequence switch → paint at 3 h scale. |
| electron / long | long tasks in 2.5 s after switch to multi-hour @ {zoom-to-fit, 1 px/frame} | gate | UI freeze after a switch. |
| electron / scroll | wheel x100 @ {1 px/frame, frame level 20 px/frame}: event -> store -> render (median) | gate | Wheel scroll latency. |
| electron / scroll | wheel x100 @ {same 2}: achieved frame rate; wheel x100 @ {same 2}: long tasks; real mouse.wheel x30 horizontal: long tasks | gate | Scroll smoothness and freezes. |
| electron / scroll | zoom-to-fit transition (setView zoom -> paint); zoom to frame level (setView zoom -> paint) | gate | Zooming is a direct interaction → paint, like a switch. |
| electron / playback | program fps {@ 1 px/frame timeline, @ zoom-to-fit (2500 clips mounted), after 20 switches + 10 maximize cycles, while autosave of the big project fires at t=3 s} (store playhead updates/s …) | gate | Playback fps. |
| electron / playback | long tasks {same 4} | gate | Playback stability (freezes while playing, including during autosave). |
| electron / long | program fps multi-hour @ 1 px/frame …; long tasks multi-hour @ 1 px/frame | gate | Playback fps and stability at 3 h scale. |
| electron / project, transcript, scenes | {project: search typing "series 3 e04", transcript: search typing "the" (8000 cues), transcript: search typing "the ship", scenes: filter typing "the" (400 records), scenes: filter typing "scene 1"}: worst keystroke -> next paint (Event Timing) | gate | Keystroke / search latency. |
| electron / project | chevron click event duration (Event Timing >=16ms entries; median) or chevron clicks over 16 ms (whichever is recorded) | gate | Click → response latency. |
| electron / project | long tasks while expanding | gate | UI freeze. |
| electron / project | scroll expanded list for 2 s: fps | gate | List scroll smoothness. |
| electron / scenes | scene library tab activate -> paint (400 records) | gate | Panel switch → paint (ambiguous; picked gate because the user waits on it like a sequence switch). |
| electron / ipc | previewExportCommand round trip (IPC + buildRenderGraph in main) | gate | Ambiguous; picked gate: the user waits on it in the Export dialog, so it is felt directly, not an ingredient. |
| export / export | full export 2500 clips: frames out / expected | gate | Export completion. |
| export / graph | video / audio segments, shared inputs | gate | Export correctness: every enabled clip reaches the render graph (wrong output otherwise). |
| store / commit | {insertFromSource overwrite, insertFromSource insert/ripple, razor all tracks, moveClips 1 clip overwrite, rippleDeleteSelected 1 clip} (median and p95), moveClips 1 clip insert/ripple, deleteSelected 1 clip, setClipEnabled, addTransitionAtCut, addMarker, setClipSpeed ripple | guardrail | Store commit time; the gate is commit → paint. Budget kept (one frame for the store's share is meaningful). |
| store / long | multi-hour {insertFromSource insert/ripple, razor all tracks, moveClips 1 clip overwrite, rippleDeleteSelected 1 clip} (median), multi-hour undo | guardrail | Store commit time at 3 h scale; budget kept. |
| store / history | undo, redo (median of 30 and max) | guardrail | Store commit time; budget kept. |
| store / view | setView playhead {no selection, 100 clips selected, all 2500 selected}, setView scroll | guardrail | Store cost per scrub / playback frame; budget kept. |
| electron / scrub, long | setView call cost … (median / max), every scrub variant | guardrail | Store cost per scrub frame in the app; the gate is scrub fps. Budget kept. |
| store / memory | heap growth over 300 commits (MB) | guardrail | Memory growth; 150 MB budget kept. |
| store / memory; electron / store | history.past.length after 300 commits | guardrail | History size (== limit 200 kept). |
| store / io | normalizeProject (median of 3) | guardrail, budget = reference | Architecture health of open; the 100 ms target means nothing on its own (the open round trip is the gate), so regression check only. |
| store / io | serializeForSave; loadProjectData (store set + pruneUi) | guardrail | Store side of save / open; budget kept. |
| store / frame, long | planFrame (median, max), planFrame with subtitle tracks, sequenceDuration, findClip by id, resolveSubtitleCues 8000 cues; planFrame multi-hour (median, max), sequenceDuration multi-hour | guardrail | Per-frame derived work under the playback gate; budget kept. |
| store / nest | flattenSequence after an edit {in the host, inside a nested sequence} (median); planFrame nested + keyframed (median, max) | guardrail | 0.8.0 content (added 8 October 2026): a duplicate of the 2,500-clip sequence with 20 compound clips (480 clips nested one level deep) and 638 keyframed clips. Program re-flattens on every edit, so the flatten rows take the store-commit budget (one frame, 16 ms; measured 2.7–4.3 ms); the planFrame rows take the per-frame budgets above (measured 0.03–0.05 / 2.1–3.4 ms). |
| panels / project | buildBinRows all expanded, buildSeriesRows all expanded, seriesTree, buildBinRows grid/chunkCards, mediaMatches x60, search keystroke -> rows rebuilt (max and mean) | guardrail | Computation share of the project panel; the keystroke → paint row in Electron is the gate. Budget kept. |
| panels / transcript | buildTranscriptIndex, searchTranscript {project scope, whole-word, regex, sequence scope}, keystroke search cost | guardrail | Computation share of transcript search (gate: keystroke → paint). Budget kept. |
| panels / scenes | collectFacets, filter+sort per keystroke (max and mean), groupScenes by character, sort by source | guardrail | Computation share of the scene library (gate: keystroke → paint). Budget kept. |
| panels / timeline | render culling loop @ {zoom-to-fit, 1 px/frame, frame level 20 px/frame} | guardrail | Per-render cost of the timeline; budget kept. |
| electron / timeline, long | DOM nodes in tracks content @ {3 zooms}; DOM nodes in tracks content, multi-hour @ {2 zooms} | guardrail | Element growth (virtualization); ≤ 5000 kept. |
| electron / timeline | IPC filmstrip / thumbnail / waveform calls in 3 s after switch @ {3 zooms} | guardrail | Bound on the IPC request storm; filmstrip ≤ 60 kept. |
| electron / project | thumbnail IPC calls in 2.5 s after scrolling 3000 scene rows | guardrail | Bound on thumbnail requests; ≤ 60 kept. |
| electron / pool | media elements (<video> + <audio>) created during 10 s playback @ 1 px/frame; media elements created by zoom-to-fit playback + 20 sequence switches | guardrail | Element growth; ≤ 16 (pool capacity) kept. |
| electron / pool | video elements … live … after 10 s playback / after 20 sequence switches / after that playback | guardrail | Live element bound; ≤ 16 kept. |
| electron / audio | MediaElementSources / GainNodes created by zoom-to-fit playback + 20 switches | guardrail | Audio-node growth; ≤ elements created kept. |
| electron / io, fairness | autosaveProject round trip (renderer -> main write); autosave main-side handler time; autosave round trip while playing | guardrail | Autosave runs in the background; what the user feels (stalls while playing) is gated by the playback-while-autosave rows. Budgets kept. |
| main / thumbs | thumbnail cache MISS (median, max), HIT (median, p95), filmstrip 48 frames cold / warm, filmstrip 48 frames produced, thumbnail MISS deep inside long file | guardrail | Media-layer service time; asynchronous, never blocks the UI (freezes are gated separately). Budgets kept. |
| main / waveform | waveform generate (cold), waveform cached read, waveform compute 60 s 720p source | guardrail | Media-layer service time; budgets kept. |
| main / fairness | thumbnail MISS {idle, while export encodes, while 2 scene detects run}, proxy 540p {idle, while export encodes}, proxy status 8 s after queueing behind 2 long scene detects, proxy queued behind scene detects, 20 concurrent thumbnail misses | guardrail | Job-queue fairness; budgets kept. |
| electron / main, fairness | thumbnail MISS / HIT via IPC, filmstrip 48 frames cold / warm via IPC, waveform via IPC (cold, cached), main RSS before / peak / after waveform, proxy status behind two 2 h scene detects, thumbnail MISS via IPC while 2 scene detects run / while export encodes | guardrail | The same media layer through IPC, plus main-process memory; budgets kept. |
| export / graph | buildRenderGraph 2500 clips; buildRenderGraph @ {100, 500, 1000} clips | guardrail | Render-graph build cost; budget kept. |
| export / ffmpeg | ffmpeg exit, wall time, peak RSS @ 100 clips (52 inputs) | guardrail | A graph of one export chunk's size (≤ `CHUNK_INPUT_THRESHOLD` = 150 inputs) must open within its memory; budgets kept. |
| export / export | full export 2500 clips: peak ffmpeg RSS (MB) | guardrail | Memory bound that keeps export completing; ≤ 1536 MB kept. |
| store / io | serializeProject (pretty JSON); JSON.parse; structuredClone(project) ~ IPC cost one way | diagnostic | Full-project serialize / parse / clone ingredients; save and open round trips are the gates. |
| store / long | serializeProject, JSON.parse, structuredClone(project) incl. multi-hour | diagnostic | Same ingredients with the 3 h sequence. |
| electron / io | JSON.stringify(project) in renderer; structuredClone(project) in renderer | diagnostic | Full-project stringify / clone ingredients. |
| electron / store, long | the edit rows above with the suffix ` (two frames, reference)` (7 + 4 rows) | diagnostic | The old double-rAF edit → paint measurement, kept as a reference so nothing is hidden; the gate is the next-painted-frame row (owner's decision, 6 October 2026). |
| electron / scrub, long | playhead scrub fps with the render counter on … (reference), every scrub variant | diagnostic | The fps of the counting pass: the old combined measurement, kept as a reference so nothing is hidden; the gate is the timing-pass fps (owner's decision, 7 October 2026). |
| electron / io, long | openProject main-side handler time (and incl. multi-hour) | diagnostic | Main-side open-handler step; open round trip is the gate. |
| export / ipc | ExportRequest JSON.stringify; ExportRequest structuredClone | diagnostic | Pure ingredient of one export request; export completion is the gate. |
| export / ffmpeg | ffmpeg exit, wall time, peak RSS @ {500 clips (252 inputs), 2500 clips (1258 inputs)} | diagnostic | Ambiguous; picked diagnostic: a single unchunked graph that export never builds (it chunks anything above 150 inputs), so it probes FFmpeg capacity, not a user path. |

## Automation hook

`src/main.tsx` installs `window.__recut` in the renderer:

```ts
window.__recut = { store, actions, selectors, runCommand }   // + jobsStore, subtitles, projectActions added by panels
```

- `store`: the zustand store (`__recut.store.getState().project`, `.ui`, `.playback`, and every action).
- `actions`: `src/state/mediaActions.ts` (`importMediaFiles`, `importSubtitleFile`, `saveProject`, `openProject`, ...).
- `runCommand(id)`: runs any keyboard command by id (`'edit.insert'`, `'file.new'`, ...).
- `window.recut` is the preload bridge (IPC), e.g. `window.recut.probe(path)` or `window.recut.quit(false)`.

Tests use the hook for setup and for steps that would need a native dialog. Everything else goes through real mouse
and keyboard input.

## Conventions

- **Frames vs seconds.** Timeline positions and durations are integer frames at the sequence's rational fps.
  Source positions (`clip.sourceIn`, scene bounds, cues) are seconds. Convert only with `shared/time.ts`.
- **Store-only mutation.** Never mutate the project outside store actions. Timeline logic lives as pure functions in
  `shared/timeline.ts`, which store actions call inside immer recipes.
- **Undoable vs quiet writes.** `commit(label, recipe)` creates an undo step. `quiet(recipe)` does not; use it for
  asynchronous job/status mirrors (probe results, proxy status, offline flags, scene-detect status). These must never
  become undo steps or clear redo. Drags use `beginTransaction` / `updateTransient` / `endTransaction`, so the whole
  drag is one undo step. View state (playhead, zoom, scroll, In/Out) is never undoable.
- **LiveView playhead.** `sequence.view` is a `LiveView` class instance, so immer neither drafts nor freezes it.
  `setView` moves the playhead and scroll **in place** and bumps `viewTick`, which avoids a new project object 60
  times a second. Read the playhead with `usePlayhead()` (`src/state/hooks.ts`). Do not select the
  whole `sequences` map just to get the playhead. Zoom and In/Out changes replace the view object.
- **Panels.** Register with `registerPanel({ id, title, component, defaultZone, keepAlive? })` in the panel's
  `index.ts`. Inactive tabs are **unmounted** unless `keepAlive` is set. Only Source, Program, Timeline and Compare
  set it. Keep panel state that must survive a tab switch in the store.
- **Commands.** Ids live in `src/keyboard/commandIds.ts` and default keys in `DEFAULT_BINDINGS`
  (`src/keyboard/shortcuts.ts`). Extra commands are in `EXTRA_META` (`src/app/commands.ts`). Menu items send
  command ids, and the aliases are in `src/app/bootstrap.ts`.
- **Transports.** Monitors register a transport (`src/app/transport.ts`). The focused monitor or the Timeline decides
  which one Space, JKL and I/O drive.
- **File ownership.** Parallel agents each own the files named in their task. Report changes needed elsewhere instead
  of making them. Do not add npm dependencies without saying so.
