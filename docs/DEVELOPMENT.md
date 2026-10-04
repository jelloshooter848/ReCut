# Developing ReCut

See [INSTALL](INSTALL.md) for prerequisites (Node 20/22, FFmpeg 6+). [ARCHITECTURE](ARCHITECTURE.md) explains how the
pieces fit together.

## Repository layout

```
shared/        Pure TypeScript shared by main and renderer. No DOM, no Node.
  model.ts       Data model (Project, MediaItem, Sequence, Track, Clip, ...), EXPORT_PRESETS
  time.ts        Rational fps, frames <-> seconds, timecode parse/format, FPS_PRESETS
  timeline.ts    Pure timeline ops (insert/overwrite, trims, ripple, razor, slip/slide, transitions, cue resolution)
  project.ts     Project / sequence factories, normalizeProject() (load-time repair + migration), LiveView
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
| `npm run package` | Build, then `electron-builder --dir` → `release/linux-unpacked` (the only verified package). |
| `npm run dist` | Build, then electron-builder installers (AppImage / dmg / nsis). Not verified. |

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
| Performance | `tests/perf` | `NODE_OPTIONS=--expose-gc npx vitest run -c tests/perf/vitest.config.ts` and `xvfb-run -a -s "-screen 0 1920x1080x24" node tests/perf/electron-perf.mjs` (also `electron-probe.mjs`, `electron-cpuprof.mjs`, `electron-attrib.mjs`) | Builds a 2,500-clip project (`bigProject.mjs`). Variables: `RECUT_PERF_SCRATCH`, `RECUT_PERF_OUT`, `RECUT_PERF_MEDIA`, `RECUT_PERF_LONG_FILE`, `RECUT_PERF_PROFILE`. Report: `docs/attack/performance.md`. |

The root Vitest config (`vite.config.ts` → `test.include`) only picks up `tests/unit`. Every other suite needs its
own `-c` config.

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
