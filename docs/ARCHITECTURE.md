# Architecture

ReCut is an Electron app with three layers:

- **Main process** (`electron/`): Node, window, OS dialogs, files and FFmpeg.
- **Renderer** (`src/`): React UI, editing state and real-time preview.
- **Shared** code (`shared/`): pure TypeScript for the data model, time math and timeline operations, used by both.

The renderer has no Node access. Everything goes through the `window.recut` preload bridge (`contextBridge`,
`electron/preload.ts`) and the IPC contract in `shared/ipc.ts`.

```mermaid
flowchart LR
  subgraph Renderer [Renderer: React + zustand/immer]
    UI[Panels: Project, Source, Program, Timeline, Inspector, Transcript, Subtitles, Scenes, Storyline, Compare, Continuity, Markers, History, Jobs/Export]
    Store[(useStore: Project + UI + history)]
    Cmd[Command registry + key bindings]
    Play[Playback engine: SequencePlayer / SourcePlayer / SyncGroup]
    UI <--> Store
    Cmd --> Store
    Play --> Store
  end
  subgraph Main [Main process: Node]
    IPC[ipc.ts handlers]
    IO[project/io.ts: atomic save, .bak, autosave, prefs]
    Q[JobQueue: media x2, background x1, export x1]
    Media[media/*: probe, thumbs, waveform, proxy, sceneDetect, subtitlesExtract]
    Exp[export/*: renderGraph, chunks, exporter]
    Proto[recut-media:// protocol with Range]
  end
  FF[(ffmpeg / ffprobe)]
  UI -- window.recut.invoke --> IPC
  IPC --> IO
  IPC --> Media
  IPC --> Exp
  Media --> Q
  Exp --> Q
  Q -- ev:jobs --> UI
  Media --> FF
  Exp --> FF
  Play -- "<video src=recut-media://local/...>" --> Proto
```

## Main process

| Module | Responsibility |
|---|---|
| `main.ts` | Single-instance lock (a second launch with a `.recut` path opens it in the running window), window creation (bounds persisted in prefs), navigation lock-down, privileged `recut-media` scheme, quit protocol, `RECUT_SMOKE` self-test. |
| `menu.ts` | Native menu. Items send **command ids** over `ev:menu`; the renderer runs them through its command registry (aliases in `src/app/bootstrap.ts`). |
| `ipc.ts` | `ipcMain.handle` for dialogs, project I/O, prefs, fs helpers (stat, listDir, relink scan), media services, jobs and export. Validates arguments at the boundary. |
| `media/protocol.ts` + `range.ts` | `recut-media://local/<encodeURIComponent(path)>` streams local files with full HTTP `Range` / `HEAD` / 206 / 416 support so `<video>` can seek. |
| `media/ffmpeg.ts` | Resolves binaries (env → `<resources>/ffmpeg` → `PATH`), spawns ffmpeg/ffprobe with timeouts, cancellation and progress parsing. `ffmpegFileArg` turns every input / output path into `file:<absolute path>` and refuses a non-absolute one ("media path must be an absolute path"), so no project path is ever read as an FFmpeg protocol. Every media service (probe, thumbnails, filmstrips, waveform, proxy, scene detection, subtitle extraction) and the exporter use it. |
| `media/probe.ts` | ffprobe JSON → `MediaProbe` (streams, rotation, sample aspect ratio, start offsets, VFR flag) and the `browserPlayable` decision. |
| `media/thumbs.ts` | Thumbnails and filmstrips, un-squeezed to the display shape for non-square pixels. They run outside the job queue on a small **LIFO, cancellable** semaphore, so the current viewport wins and abandoned requests never start ffmpeg. |
| `media/waveform.ts` | Streams the audio to u8 mono peaks (O(peaks) memory, even for multi-hour files). Late-starting audio is padded. |
| `media/proxy.ts` | H.264 / AAC proxy transcode carrying every audio stream, one AAC track each in source order: `<cache>/proxies/<key>_<h>p_all.mp4`. If that run fails (a stream FFmpeg cannot decode or encode), it retries with the decodable streams (`<key>_<h>p_a<N>_a<M>….mp4`), then the media's selected stream alone (`_a<N>`), and returns the streams it carries (`ProxyResult.audioStreams`, recorded in `ProxyInfo.audioStreams`). Older single-stream proxies (`<key>_<h>p_a<N>.mp4`, `<key>_<h>p.mp4` = first stream) stay valid for their stream. Still images get `<key>_still.png` (first picture, upright, long side ≤ 3840). Writes a per-job `.part` file first, then renames it. |
| `media/sceneDetect.ts` | `select='gt(scene,T)'` + `showinfo` on a downscaled stream. Results are cached per threshold. |
| `media/subtitlesExtract.ts` | Embedded text subtitle stream → SRT. Bitmap codecs are rejected. |
| `media/cache.ts` | Cache root and `sha1(path + size + mtime)` keys. |
| `jobs/jobQueue.ts` | Three lanes: **media** (proxies, waveforms, extraction; concurrency 2), **background** (scene detection; 1), **export** (1). Progress, cancel and `AbortSignal` per job. Snapshots are pushed at most 10×/s on `ev:jobs`. `jobs/inFlight.ts` de-duplicates identical requests (same proxy output, same scene-detect key). |
| `export/renderGraph.ts` | Pure: `ExportRequest` → ffmpeg args + `filter_complex` script. Unit-tested. Also used by "Show FFmpeg command". |
| `export/chunks.ts` | Pure: decides when to chunk and where the chunk boundaries go. |
| `export/exporter.ts` | Runs the graph (single pass or chunked), parses `-progress`, handles cancel, renders into an exclusively created `<name>.recut-part-<random>.mp4` and moves it onto the output (kept as `<name>.recut-unsaved-<time>.mp4` if that fails), writes the `.srt` sidecar through a temp, cleans temp files. Refuses an output that is a project source file, and an existing output unless the request says `overwrite` (see [export-pipeline.md](export-pipeline.md#output-files)). |
| `safeMkdir.ts` | Creates the output folder level by level, without recursive or blocking mkdir. Refuses `/proc`, `/sys` and `/dev`. Gives up after 5 s. |
| `pathSafety.ts` | "Is this the same file as a project source?" for writes: `canonicalPath` (realpath), `fileIdentity` (device + inode) and `findSameFile`, case-folded on every platform. Used by video export and subtitle export. |
| `fs.ts` | fs helpers for IPC (stat, listDir, relink scan) and `writeSubtitleFile` (`subtitles:export`): writes only absolute `.srt` / `.vtt` paths, refuses project source files via `pathSafety.ts`, writes atomically. There is no generic write-file IPC. |
| `project/io.ts` | Atomic writes (temp + rename) that keep one `.bak` (written via temp + rename, so a symlink there is replaced, not followed), load + `normalizeProjectWithReport` (a repaired file is first copied to `<file>.pre-repair-<ts>`), `.bak` fallback with `fromBackup` for damaged files (the damaged file is kept as `<file>.corrupt-<ts>`), refusal of newer / non-ReCut format versions (never replaced by the `.bak`), autosave / recovery discovery, `prefs.json`, recent projects. |

## Shared code

| Module | Responsibility |
|---|---|
| `model.ts` | Data model types, `EXPORT_PRESETS`. |
| `time.ts` | Rational fps (`isValidFps`: integer terms ≤ 1,000,000, 1–1000 fps), frames ↔ seconds, timecode format / parse including SMPTE drop-frame (`formatSequenceTimecode`, `parseSequenceTimecode`). |
| `timeline.ts` | Pure timeline operations (see Store). |
| `project.ts` | Factories and `normalizeProjectWithReport` / `normalizeProject`: load-time repair and migration. |
| `limits.ts` | Ranges a loaded project must stay within (`MAX_TIMELINE_FRAMES` = 86,400,000, `MAX_SOURCE_SECONDS`, zoom, Preferences ranges, `MAX_PROJECT_DEPTH` = 64). The UI takes its ranges from here too. |
| `media.ts` | Sample aspect ratio rules (`saneSar`: positive safe integers, 1/16–16) and `videoDisplaySize` for the export graph and the preview compositor. |
| `pathKey.ts` | Lexical `path.resolve` + case folding for the renderer's early "is this a project source?" check (subtitle export). The main process repeats the check with realpath and inode (`electron/pathSafety.ts`). |
| `subtitles.ts`, `ipc.ts`, `ids.ts`, `peaks.ts` | SRT / VTT parse + serialize, the IPC contract and `recut-media://` helpers, ids, waveform peaks. |

## Renderer

### Store (`src/state/store.ts`)

One **zustand** store holds `project`, `ui` (selection, source clip, tool, dialogs, filters, ...), `playback`, `jobs`
and `history`. Project changes go through immer:

- `commit(label, recipe)` produces a new immutable `Project`, pushes the **previous project object** onto
  `history.past`, clears redo and marks the project dirty. Undo/redo swap whole project references. Structural
  sharing keeps this cheap: undo is about 0.4 ms on a 2,500-clip project, and history is capped at 200 entries.
  `carryViewState` keeps the current playhead, zoom and In/Out when undoing.
- `quiet(recipe)` changes the project without a history entry. It is used for async mirrors: probe results, proxy
  and scene-detect status, offline flags, the active sequence.
- `beginTransaction` / `updateTransient` / `endTransaction` turn a drag or a multi-step command into one undo step.
- Timeline logic is **pure** in `shared/timeline.ts` (insert/overwrite placement, trims, ripple, roll, slip, slide,
  razor, transitions reconciliation, story-block shifting, `resolveSubtitleCues`). Store actions call it on drafts.
- `sequence.view` is a `LiveView` class instance, which immer does not draft or freeze. `setView` mutates playhead
  and scroll **in place** and bumps `viewTick`, so playback and scrubbing do not create new `Project` objects and do
  not re-render panels that select `sequences`.

`src/state/mediaActions.ts` holds the IPC-backed actions: import with identity parsing, bin routing, sidecar
pickup and auto-proxies; probing; save/open/autosave; relink.

### Shell, panels, commands

- **Layout** (`src/components/layout`): four workspaces (Editing, Research, Audio, Compare) over six zones. Each zone
  has tabs, and panels can be moved between zones, maximized or reset. Layouts persist in `localStorage`.
- **Panel registry** (`src/panels/registry.ts`): every panel calls `registerPanel` from its `index.ts`. **Inactive
  tabs are unmounted** unless `keepAlive` is set. Only Source, Program, Timeline and Compare set it, because they own
  players, canvases or large DOM.
- **Command registry** (`src/keyboard/shortcuts.ts`): commands with id, title, category, `when` and `run`. Default
  chords live in `DEFAULT_BINDINGS` and `EXTRA_META`, and user overrides are saved in prefs. A single window
  key handler (`useShortcuts`) canonicalises chords from `KeyboardEvent.code`. It ignores text fields and dialogs.
  The menu, context menus, buttons and keys all call the same command ids.
- **Transport registry** (`src/app/transport.ts`): Source, Program and Compare each register a `Transport` (toggle,
  setRate, step, seek, mark, ...). Playback and mark commands act on the **active** transport, which follows
  focus. Clicking the Timeline makes the program side active.

### Playback engine (`src/playback`)

```
            PlaybackClock (performance.now, rate -8..8)
                   │
   ┌───────────────┴────────────────┐
SequencePlayer                  SourcePlayer (one <video>, JKL; native at 0<rate≤4, seek-stepped otherwise)
   │ each frame:
   │  planFrame(seq, media, frame)  ← pure planner: per-track indexes, transitions → layers (alpha) + audio (gain)
   │  MediaElementPool.acquire()    ← pooled <video> per (path, role), LRU capacity 12
   │  keep elements at sourceTime + ½ media frame (drift > 80 ms → re-seek)
   │  draw bottom→top on a 2D canvas (transform, crop, opacity, transition alpha), subtitles on top
   │  WebAudio: element → clip gain → track gain → master gain (→ AudioMeter tap)
SyncGroup: two SequencePlayers on one clock with a frame offset (Compare)
```

- `mediaSource.ts` chooses what to play: the proxy if proxies are on and one is ready, else the original if it is
  browser-playable, else a ready proxy, else nothing (reported as missing with a reason). It also applies the
  container start-time offset for originals.
- The canvas renders at the sequence size × **playback resolution** (Full, 1/2, 1/4).
- The Program monitor's "Offline / Needs proxy / Can't play" chips come from the planner's `missing` list.

### Data flow: an insert edit

```
key ','  →  useShortcuts → runCommand('edit.insert')
         →  insertSourceIntoSequence('insert')            (src/panels/source/insert.ts)
         →  maybeConformSequence()  (first clip into an empty sequence: "Change sequence to match clip?")
         →  resolveThreePointEdit() (sequence In/Out, playhead, source In/Out → atFrame, source range)
         →  store.insertFromSource()  → commit('Insert', d => timeline.placeClips(...); carry subtitle cues)
         →  new Project → React panels re-render; SequencePlayer.setSequence() → redraw
```

### Data flow: export

```
Export dialog → window.recut.startExport({ sequence, media, settings, subtitles, protectedPaths[, overwrite] })
  main: validate (absolute folder, not a project source, exists? → code 'exists' → dialog asks "Replace it?")
        → JobQueue('export') → exporter
        shouldChunk? ── no ─→ buildRenderGraph → ffmpeg -filter_complex_script → <name>.recut-part-<random>.mp4
                     └─ yes ─→ per-chunk video (.mp4, closed GOP) + audio (.wav f32) → concat demuxer join
        → move onto <name>.mp4, write .srt sidecar (temp + rename), delete temp dir
  progress: ffmpeg -progress → job.progress → ev:jobs → jobsStore → Export dialog / Jobs panel
```

## Timing model

- **Rational frame rates** (`{num, den}`, e.g. 24000/1001) everywhere. Timeline positions and durations are
  **integer frames**. Source positions are **seconds** (sources have their own rates). `clip.speed` is source
  seconds per timeline second.
- **Editor frame choice:** the monitors seek to `sourceTime + 0.5 / mediaFps` and show the frame covering it, i.e.
  media frame `floor(t × mediaFps + 0.5)`.
- **Frame-exact export** (`docs/export-pipeline.md`):
  - Each clip segment is cut in the graph from **absolute source timestamps** (`-copyts -start_at_zero`, `trim` on
    source seconds). `-ss` is only a decode shortcut with a small pre-roll.
  - `settb=AVTB` + `setpts` keep sub-frame phase, so `fps` picks the same frame the editor shows, also for off-grid
    in-points, mixed rates and VFR.
  - `tpad` + `trim=end_frame=N` make every segment exactly N frames. Tracks are re-stamped with
    `settb=den/num,setpts=N`.
  - **Centred transitions:** a D-frame transition covers `[cut − D/2, cut + D/2)` using source handles. Timeline
    positions never move. `xfade` / `acrossfade` consume the extended segments, and the sequence length is unchanged.
  - Audio is rebased to the clip's in-point (a late-starting stream keeps its offset), converted to the output
    layout, mixed with `amix normalize=0`, and padded or trimmed to the exact length.
  - An In/Out range edge inside a transition widens the rendered range, and the composite is trimmed back, so the
    range renders what the full export renders.
  - Anamorphic sources are un-squeezed before the fit scale, and everything is kept at SAR 1.
  - An export frame rate other than the sequence's resamples only the final composite (whole frames repeated or
    dropped); all timeline maths and the audio stay at the sequence rate.
- **Timecode display:** one rule everywhere (`formatSequenceTimecode`): SMPTE drop-frame `HH:MM:SS;FF` at exactly
  30000/1001 and 60000/1001, non-drop otherwise. Typed entry (`parseSequenceTimecode`) reads input the way the
  field displays it.
- **Chunked export:** above 150 inputs or 120 video segments, the range is split at clip edges that never fall inside
  a transition, a fade or a speed-changed audio clip. Video chunks are encoded with closed GOPs and joined with
  `-c copy`. Audio chunks are sample-exact float WAV with one final encode. This bounds FFmpeg memory on very long
  timelines.

## Proxy workflow

1. Import → probe → `browserPlayable === false` and **Use proxies** on → `startProxy` (media lane).
2. `jobsRouter.ts` mirrors queued / running / ready / failed into `media.proxy` (quiet writes) and invalidates pooled
   elements, so the monitors switch to the proxy.
3. The preview uses the proxy. **Export always uses originals** (the render graph never sees a proxy path).
4. On open, `verifyMediaOnline` re-checks originals (offline flags) and drops `ready` proxies whose file has gone.

## Relink

- On open, missing originals are flagged **offline**. A banner and the Relink dialog list them.
- **Search folder…** calls `fs:scanForRelink`, which walks the folder and matches by file name + size.
  **Locate…** relinks one file by hand. Applying matches updates `media.path` and re-probes.
- The first probe after a relink fits the clips to the new file: clips that run past its end are trimmed to it and
  clips that start after it are removed, in every sequence (store `fitClipsToRelinkedMedia`, one undo step and a
  warning toast with the counts).

## Autosave, recovery and quit

- **Autosave:** 5 s after the last committed change, at idle (`requestIdleCallback`), and at the configured
  interval (default 60 s). It is deferred while playing. It writes `<project>.recut.autosave`, or
  `<userData>/autosave/untitled.recut.autosave` for an unsaved project, from a renderer-serialised string.
- **Recovery:** at startup, an autosave newer than its project (or the untitled autosave) is offered (**Recover** /
  **Discard**). Corrupt autosaves are ignored. An autosave that needed repairs is still offered, and the prompt says
  it was repaired.
- **Save:** atomic temp + rename, keeping a `.bak`. A structurally damaged main file opens from `.bak` with a toast.
  A file that normalizes with repairs opens with a warning toast that names the `<file>.pre-repair-<ts>` copy. A file
  from a newer format version (or without one) is refused and never replaced by the `.bak`.
- **Open:** `mediaActions.openProject` is the one open path (File › Open, recent, OS open, command line). Loading or
  creating a project closes all modal dialogs of the previous one.
- **Quit:** main sends `ev:beforeQuit`. The renderer **acks** within 3 s (otherwise main force-quits, for a hung
  renderer), asks Save / Don't Save / Cancel if dirty, then confirms with `quit(true)`, or sends `quitCancel` to keep
  running.

## Performance design

- In-place `LiveView` playhead, so no project churn during playback or scrubbing.
- Hidden panels are unmounted. Panels select narrow slices.
- Timeline: viewport culling, plus a **level-of-detail lane** that draws clips narrower than a few pixels as merged
  bars on one canvas per track (`LodLane.tsx`). Filmstrips and waveforms are skipped for very narrow clips. Their requests
  wait for the view to settle and are aborted when the clip leaves the viewport. Thumbnail requests are served
  LIFO.
- Virtualized lists: Project tree, Transcript results, Scene library.
- Planner: per-track sorted indexes and transition maps cached per immutable track object (binary search per frame).
- Caches: thumbnails, filmstrips and waveforms (main-side disk cache plus renderer memory), proxies, scene results,
  all keyed by path + size + mtime.
- Job lanes keep long scene detections from starving proxies. In-flight de-duplication prevents double encodes.
- Projects are saved as compact JSON.

See `docs/attack/performance.md` for the measurements that drove these changes. That report predates most of them.

## Extension points

- **Transcript providers** (`src/transcript/providers.ts`): implement `TranscriptProvider` (`available`,
  `transcribe(mediaPath, opts, onProgress)` → `SubtitleCue[]`) and add it to `PROVIDERS`. It then appears under
  Transcript › Import › **Transcribe…**. `SubtitleFileProvider` (sidecar SRT/VTT) is the working example.
  `LocalWhisperProvider` is a disabled placeholder. A real local provider should run as a main-process job (the
  `'transcribe'` `JobKind` is reserved) that extracts audio with FFmpeg and streams progress.
- **Export presets:** add entries to `EXPORT_PRESETS` in `shared/model.ts` (partial `ExportSettings`). The dialog
  lists them, followed by **Match Sequence**.
- **Panels:** `registerPanel({ id, title, component, defaultZone, icon, keepAlive? })` in a new `src/panels/<name>/index.ts`
  imported from `src/panels/index.ts`. It then appears in every zone's "Show panel here" menu.
- **Commands:** `registerCommand({ id, title, category, defaultKeys, when, run })`. Commands show up in the Keyboard
  Shortcuts dialog automatically.
- **Project format:** bump `formatVersion` and migrate in `normalizeProject()` (`shared/project.ts`). See
  [project-format.md](project-format.md).
