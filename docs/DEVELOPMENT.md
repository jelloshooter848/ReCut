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
electron/      Main process
  main.ts        Window, single-instance lock, quit protocol, smoke test
  menu.ts        Application menu (sends command ids to the renderer)
  ipc.ts         ipcMain handlers (dialogs, project I/O, prefs, fs, media, jobs, export)
  preload.ts     contextBridge → window.recut
  project/       io.ts (atomic save, .bak, autosave/recovery, prefs), argv.ts (--project parsing)
  media/         ffmpeg/ffprobe runners, probe, protocol + range, thumbs, waveform, proxy, sceneDetect, subtitlesExtract, cache
  jobs/          JobQueue (lanes) + in-flight de-duplication
  export/        renderGraph.ts (pure graph builder), chunks.ts (chunk planner), exporter.ts (runs ffmpeg)
  safeMkdir.ts   Non-recursive, time-bounded output-folder creation
  pathSafety.ts  realpath / device+inode "same file as a project source?" checks (video and subtitle export)
  fs.ts          fs helpers for IPC, relink scan, guarded atomic subtitle export (writeSubtitleFile)
src/           Renderer (React 18)
  main.tsx, App.tsx    Entry, shell, window.__recut automation hook
  state/         store.ts (single zustand + immer store), history.ts, mediaActions.ts (IPC-backed actions), selectors
  app/           bootstrap, editing commands (commands.ts), project lifecycle, transport registry, jobs router, dialogs
  keyboard/      Command ids, default bindings, binding engine, Keyboard Shortcuts dialog
  playback/      Clock, element pool, frame planner, SequencePlayer, SourcePlayer, SyncGroup, thumbnails
  panels/        One directory per panel (project, source, program, timeline, inspector, transcript, subtitles,
                 scenes, continuity, storyline, compare, export, jobs, markers, history) + registry.ts
  components/    Layout (workspaces, tabbed zones, top bar) and UI primitives
  transcript/    Transcript index/search and TranscriptProvider implementations
tests/         unit, e2e, attack, attack-qa, perf (see below)
scripts/       dev.mjs, build-electron.mjs, make-test-media.sh, screenshot.mjs
docs/          This documentation, attack reports (docs/attack), screenshots
```

Path aliases: `@shared/*` → `shared/`, `@/*` → `src/` (in `vite.config.ts` and the tsconfigs).

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Builds main/preload with esbuild, starts the Vite dev server on :5173, launches Electron with `RECUT_DEV_URL`. The renderer hot-reloads. Restart to pick up main-process changes. |
| `npm run build` | `vite build` → `dist/renderer` and `scripts/build-electron.mjs` → `dist/electron`. |
| `npm start` | Build, then `electron .` |
| `npm run typecheck` | `tsc --noEmit` for the renderer/shared project and for the electron project. |
| `npm test` | Vitest over `tests/unit/**/*.test.ts` (node environment). Some tests run real FFmpeg. |
| `npm run test:watch` | Vitest in watch mode. |
| `npm run test:e2e` | Build, then Playwright over `tests/e2e` (needs a display; use xvfb). |
| `npm run perf:check` | Performance gate: node perf suite, build, Electron perf script, every budgeted row in three tiers (gates, guardrails against `tests/perf/baseline.json`, diagnostics; allow about 25 min; run it alone). See [Performance gate](#performance-gate-npm-run-perfcheck). |
| `npm run package` | Build, then `electron-builder --dir` → `release/<platform>-unpacked`. Windows installers are built by `.github/workflows/windows.yml`. |
| `npm run dist` | Build, then electron-builder installers (AppImage / dmg / nsis + portable exe). The Windows nsis installer and portable exe are built in CI by `.github/workflows/windows.yml`, which smoke-tests the unpacked app and a silent install (unsigned, FFmpeg bundled); the dmg and AppImage are untested. |

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
| Performance | `tests/perf` | `npm run perf:check` (the gate, see below), or each part: `NODE_OPTIONS=--expose-gc npx vitest run -c tests/perf/vitest.config.ts` and `xvfb-run -a -s "-screen 0 1920x1080x24" node tests/perf/electron-perf.mjs` (also `electron-probe.mjs`, `electron-cpuprof.mjs`, `electron-attrib.mjs`) | Builds a 2,500-clip project plus a 3 h multi-hour sequence (`bigProject.mjs`: `buildBigProject`, `buildLongSequence`). Variables: `RECUT_PERF_SCRATCH`, `RECUT_PERF_OUT`, `RECUT_PERF_MEDIA`, `RECUT_PERF_LONG_FILE`, `RECUT_PERF_PROFILE`. Report: `docs/attack/performance.md`. |

The root Vitest config (`vite.config.ts` → `test.include`) only picks up `tests/unit`. Every other suite needs its
own `-c` config.

### Performance gate (`npm run perf:check`)

`npm run perf:check` runs the node perf suite, builds the app, runs `electron-perf.mjs` under xvfb, then reads the
JSON results (`test-results/perf/{store,panels,main,export,electron}.json`) and prints every budgeted row in three
sections, **Gates**, **Guardrails** and **Diagnostics**, with value, budget, baseline, ratio to the baseline and
the verdict (PASS/FAIL for gates and guardrails, a trend for diagnostics). It exits 1 if a gate or a guardrail
fails, if a suite exits non-zero, if a result file is missing, or if a guardrail row recorded in the baseline is no
longer measured. Diagnostics never change the exit code. Old result files are deleted before each run, so a
crashed suite cannot pass on stale data.

#### Tiers

Every budgeted row has a tier. The owner decided this policy on 6 October 2026:

| Tier | What it is | How it is judged |
|---|---|---|
| **gate** | User-facing hard gate: what the user directly feels. Project save time, project open / time to interactive, UI freezes (long tasks), edit commit → paint, scrub fps and re-renders per frame, sequence switch → paint, wheel scroll latency, playback fps and long tasks, keystroke / search latency, export completion. | Strict pass/fail on the bench's budget. `npm run perf:check` and Roadmap §1 completion both require every gate to pass. |
| **guardrail** | Architecture guardrail: internal costs that matter for the health of the architecture (normalizeProject, store commit times, memory and heap growth, element and audio-node growth, the autosave handler, history size, media-layer service times, render-graph build). | FAIL on a **material regression** against `tests/perf/baseline.json`, unless the PR explains it. A guardrail with a meaningful absolute budget (element creation ≤ pool size, a commit within one frame) also keeps that budget as pass/fail. A guardrail whose absolute target no longer means anything on its own marks it `reference` (shown as `ref <= …`): only the regression check applies. |
| **diagnostic** | Microbenchmark of a pure ingredient: full-project `structuredClone`, full-project `JSON.stringify` / `JSON.parse`, `serializeProject` alone, the main-side open-handler step, and similar. | Measured and reported with the trend against the baseline (`steady` / `slower` / `faster`, and whether it is within its reference budget). Never blocks. |

- **Material regression** (one constant, `REGRESSION_RULE` in `tests/perf/perf-check.mjs`): the median of at
  least 2 runs is more than 1.5 × the baseline median, and more than an absolute noise floor above it (2 ms for
  `ms` rows, 8 MB for `MB` rows, none for counts). The floor exists because rows of a few milliseconds are not
  stable on identical code: in the two seed runs `searchTranscript regex` read 3.39 and 1.67 ms and
  `resolveSubtitleCues` 1.87 and 2.86 ms; a 0.04 → 0.07 ms change at timer resolution is not material either.
  With a single run an excess is printed as `UNCONFIRMED` and does not fail; run `--runs 2` before you call a
  regression or a fix. Guardrails with non-numeric values (`"16 / 0"`) are judged on their budget only.
- **Nothing is deleted or loosened.** Re-scoping a row's tier is the only mechanism. Diagnostic rows (and
  `reference` guardrails) keep their old threshold in the row, shown as a reference, so history stays comparable.
- **Where the tier lives.** With the row, where it is recorded: `ms(section, metric, value, budget, note, tiering)`
  and `record(row, tiering)` in `tests/perf/_report.ts` (tiering = `GUARDRAIL`, `GUARDRAIL_REF` or `DIAGNOSTIC`), and
  the `tiering` argument of `ms` / `rec` in `electron-perf.mjs` (also `_electron-common.mjs`). A budgeted row
  without a tier is a **gate**, so nothing escapes the gate by omission.
- **Changing a row's tier** needs a stated reason in the PR (and an update of the table below). Do not move a row
  because it fails: the 3 h save round trip is a gate although it fails today.

#### Baseline (`tests/perf/baseline.json`)

The baseline holds the median of every guardrail and diagnostic row, keyed by the stable row name
`<suite>|<section>|<metric>`, with the commit, date, run count and machine notes (`nproc`, CPU, Node, FFmpeg version).
Write it from at least two runs of each suite, alone on the machine:

```
node tests/perf/perf-check.mjs --update-baseline --reason "<why>" --from <run dir> <run dir> [...]
node tests/perf/perf-check.mjs --update-baseline --reason "<why>" --runs 2      # run, then write
```

**The baseline only changes in a PR that states why**: an accepted cost of a feature (the regression is understood
and worth it), or locking in an improvement (so the guardrail protects it). Reviewers send back a `baseline.json`
change without that sentence. The exit code after `--update-baseline` is the normal one (gates still count).
The baseline is machine-dependent: compare only runs on the same machine class (the seed is the 4-core cloud
container); on a different machine, write a local baseline and do not commit it.

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
- **Treat ±30 % as noise on a single run.** On an idle 4-core container three runs agreed within about ±10 % for
  most rows, but with other jobs on the machine a single row has doubled on identical code (`serializeProject`
  344 → 704 ms; see the baseline in `bugs/closed/2026-10-05-perf-budgets-2500-clips.md`). A single run is not
  evidence of a regression or a fix, and rows within a few percent of their budget flip between runs. Compare
  medians of at least two runs: `npm run perf:check -- --runs 2` runs everything twice and reports the median per row
  with its min–max spread; a row passes its budget only when it passed in more than half of the runs.
- Options: `--skip-build` (dist/ is current), `--node-only`, `--electron-only`, and `--from <dir> [<dir> …]` to
  aggregate result folders from earlier runs without running anything (for example one run with
  `RECUT_PERF_OUT=/tmp/run1`, a later one with `RECUT_PERF_OUT=/tmp/run2`, then
  `npm run perf:check -- --from /tmp/run1 /tmp/run2`).

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
