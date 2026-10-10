# ReCut performance attack report

Scope: working tree at HEAD `d13dd2b` (2026-10-04 15:39 UTC; `dist/` rebuilt 15:42), measured 15:40–16:45 UTC.
Every number below comes from a script in `tests/perf/` (how to run is at the end). Nothing in `src/`, `shared/` or
`electron/` was modified.

Test project (built through `window.__recut.store` / `useStore` by `tests/perf/bigProject.mjs`): 60 media (clones of the 7
real files from `scripts/make-test-media.sh … full`, distinct ids, names and identities), 3,000 detected scenes, 8,000
subtitle cues on 30 tracks, 400 scene records, one sequence with **2,500 clips on 4V + 4A tracks, 300 transitions,
200 markers** (37,560 frames at 24 fps), plus 10 duplicated sequences with snapshots (12 sequences in total).
Project JSON: 27.3 MB compact, 66.9 MB as written to disk.

Machine: shared cloud container, xvfb, software GL. Other agents ran Playwright suites and ffmpeg in parallel during some runs,
so absolute timings carry roughly ±30 % noise; every failing row below fails by a much larger factor than that.

## Verdict

**Not usable on a large project.** The pure data layer holds up: undo/redo stays at 0.4 ms, 300 commits grow the heap by
only 5.6 MB, history is capped at 200, normalizeProject takes 92 ms, buildRenderGraph takes 19 ms, transcript and
project search keystrokes paint in 32–40 ms, and the main process stays flat (+5 MB after 500 thumbnails, a 2-hour
waveform's ffmpeg child peaks at 124 MB). The renderer is the problem:

* **P1: Export of the 2,500-clip sequence cannot succeed.** ffmpeg gets one `-i` per clip segment and is killed at
  6.2 GB RSS (it already needs 3.3 GB at 500 clips).
* **P1: Playback and scrubbing run at 1.7–7 fps.** Every playhead step re-renders about 4,400 components in hidden
  panels (Continuity 2,655, Compare 1,320, Project 231, Markers 88). `view.playhead` lives inside `Sequence`, so each
  playhead step creates a new `project.sequences` object, and every tab stays mounted while hidden.
* Every edit takes 270–820 ms from commit to paint. Today's `reconcileTransitions` change made the store commits
  themselves 5–10× slower.
* At zoom-to-fit the timeline mounts all 2,500 clips: 30,000 DOM nodes, 1,250 canvases, a 3.5 s first paint, and a
  thumbnail-request storm that takes 47 s to drain.
* Autosave of the big project takes 1.6 s, or 6 s while playing, and drops playback to about 1 fps.

Counts: P1 ×2, P2 ×4, P3 ×5, P4 ×2 (13 findings).

## Measurements

Thresholds are the budgets the scripts assert: 60 fps interactions → ≤16 ms per frame, ≤32 ms commit to paint, playback
≥23 fps for 24p, and ≤100 ms for "instant" UI.

| # | Area | Metric | Value | Threshold | Result |
|---|------|--------|-------|-----------|--------|
| 1 | Store | insertFromSource overwrite, commit (median / p95) | 28.9 / 37.6 ms | ≤16 / ≤50 ms | FAIL |
| 1 | Store | insertFromSource insert-ripple, commit (median) | 101.7 ms | ≤16 ms | FAIL |
| 1 | Store | razor all tracks, commit (median) | 22.7 ms | ≤16 ms | FAIL |
| 1 | Store | moveClips 1 clip overwrite / insert, commit (median) | 66.1 / 146.0 ms (was 5.8 / 17.4 at `8a80dc3`) | ≤16 ms | FAIL |
| 1 | Store | rippleDeleteSelected / deleteSelected 1 clip (median) | 66.6 / 57.4 ms (was 8.7 / 6.4) | ≤16 ms | FAIL |
| 1 | Store | setClipSpeed ripple (median) | 90.5 ms (was 14.8) | ≤16 ms | FAIL |
| 1 | Store | setClipEnabled / addTransitionAtCut / addMarker | 0.22 / 0.42 / 0.59 ms | ≤8 ms | PASS |
| 1 | Store | setView playhead (no selection / 2,500 selected) | 0.06 / 0.40 ms | ≤1 ms | PASS |
| 1 | Store | undo / redo (median, max) | 0.42 / 0.42 ms, max 2.9 | ≤16 ms | PASS |
| 1 | Store | heap growth over 300 mixed commits (node, after GC) | +5.6 MB; past.length capped at 200 | ≤150 MB | PASS |
| 1 | Store | renderer: 300 commits with UI mounted | 25.3 s total, 31 long tasks (max 1,579 ms) | — | FAIL |
| 1 | IO | project JSON size compact / pretty (on disk) | 27.3 / 66.9 MB; snapshots alone 11.8 MB | — | — |
| 1 | IO | serializeProject (pretty) / JSON.parse | 319 / 181 ms | ≤100 ms | FAIL |
| 1 | IO | normalizeProject | 91.5 ms | ≤100 ms | PASS |
| 1 | IO | structuredClone(project) in renderer (one IPC send) | 340 ms | ≤100 ms | FAIL |
| 1 | IO | autosave round trip (idle) / main-side write | 1,593 / 614 ms | ≤500 / ≤300 ms | FAIL |
| 1 | IO | save / open round trip | 2,861 / 3,174 ms (open: one 2,502 ms long task) | ≤500 / ≤1,000 ms | FAIL |
| 2 | Timeline | switch to big sequence → first paint @ zoom-to-fit / 1 px/frame / 20 px/frame | 3,516 / 567 / 980 ms | ≤100 ms | FAIL |
| 2 | Timeline | DOM nodes in tracks @ zoom-to-fit / 1 px/frame / 20 px/frame | 30,417 / 1,051 / 159 | ≤5,000 | FAIL / PASS / PASS |
| 2 | Timeline | clips / filmstrip imgs / wave canvases @ zoom-to-fit | 2,500 / 1,250 / 1,250 | — | — |
| 2 | Timeline | filmstrip IPC calls in the 3 s after zoom-to-fit | 265 (storm drains in 46.9 s) | ≤60 | FAIL |
| 2 | Timeline | zoom-to-fit transition / zoom to frame level (setView → paint) | 1,310 / 270 ms | ≤100 ms | FAIL |
| 2 | Timeline | playhead scrub (1 setView per rAF) @ zoom-to-fit / 1 px/frame | 7.3 / 4.1 fps | ≥50 fps | FAIL |
| 2 | Timeline | component renders per playhead step (1 px/frame, steady state) | 4,376 (timeline 41; hidden panels 4,335) | ≤50 | FAIL |
| 2 | Timeline | ClipView renders / DOM mutations in clips per playhead frame @ zoom-to-fit | 0 / 0 (memo holds) | 0 | PASS |
| 2 | Timeline | ClipView renders / DOM mutations per scrub frame @ 1 px/frame | 20.5 / 43.9 | 0 | FAIL |
| 2 | Timeline | wheel scroll ×100 @ 1 px/frame: event→render median / fps / long tasks | 57.6 ms / 16.2 fps / 92 | ≤8 ms / ≥50 / 0 | FAIL |
| 2 | Timeline | real mouse.wheel ×30: long tasks | 30 (max 73 ms) | 0 | FAIL |
| 2 | Timeline | filmstrip IPC during 100 wheel steps @ 1 / 20 px/frame | 6 / 65 | — | — |
| 2 | Timeline | edit commit → paint: insert / razor / move / ripple delete / undo (median) | 309 / 297 / 431 / 819 / 280 ms | ≤32 ms | FAIL |
| 3 | Project | 3,000 scene rows expanded: scroll fps / long tasks | 58.8 fps / 0 | ≥50 | PASS |
| 3 | Project | search keystroke → next paint (worst, Event Timing) | 40 ms | ≤50 ms | PASS |
| 3 | Project | buildBinRows all expanded / search rebuild (max) | 1.9 / 15.4 ms | ≤16 ms | PASS |
| 3 | Transcript | search "the" over 8,000 cues: keystroke → paint (worst) | 32 ms; pure search 2.4 ms | ≤50 ms | PASS |
| 3 | Transcript | search "the" with *sequence* scope (2,500 clips) | 42–76 ms per run, re-run on every playhead move | ≤16 ms | FAIL |
| 3 | Scenes | filter keystroke → next paint ("the" / "scene 1") | 120 / 96 ms; 400 rows mounted | ≤50 ms | FAIL |
| 3 | Scenes | sort by source (localeCompare with options) | 20.4 ms | ≤16 ms | FAIL |
| 4 | Playback | Program fps over 10 s @ 1 px/frame timeline | 5.0 fps (54 long tasks, max 2,035 ms) | ≥23 fps | FAIL |
| 4 | Playback | Program fps @ zoom-to-fit | 1.7 fps (max long task 937 ms) | ≥23 fps | FAIL |
| 4 | Playback | Program fps after 20 switches + 10 maximize cycles | 1.8 fps | ≥23 fps | FAIL |
| 4 | Playback | `<video>` live / created after 10 s, after 20 switches, after 10 maximize cycles | 16 / 876, 16 / 1,088, 16 / 1,088 | live ≤16 | PASS (churn noted) |
| 4 | Playback | GainNodes after 10 s → after 20 switches | 275 → 365 (never pruned) | bounded | FAIL |
| 4 | Playback | sequence switch → paint ×20 (median / max) | 517 / 1,364 ms | ≤100 ms | FAIL |
| 4 | Main | main RSS baseline → after 500 thumbnails → after 20 proxies → end | 213 → 218 → 383 → 414 MB | no leak | PASS |
| 4 | Main | waveform of 120-min file (cold) / ffmpeg child peak / cached | 29.2 s / 124 MB / 5.7 ms | ≤60 s | PASS |
| 4 | Renderer | working set at end of run | 1,238 MB | — | — |
| 5 | Main | thumbnail HIT / MISS via IPC (median) | 0.5 / 111 ms (MISS max 9.2 s when queued behind a storm) | ≤5 / ≤300 ms | PASS |
| 5 | Main | filmstrip 48 frames cold / warm via IPC | 1,510 / 5.4 ms | ≤3,000 / ≤50 ms | PASS |
| 5 | Main | 500 thumbnail requests in flight | 35.1 s to drain (3 concurrent, FIFO, no cancel) | — | — |
| 5 | Jobs | thumbnail MISS idle / during export / during 2 scene detects | 111 / 199 / 135 ms | ≤600 ms | PASS |
| 5 | Jobs | proxy queued behind two 2-h scene detects: status after 8 s | `queued` (detects at 0 % after 10 s) | running | FAIL |
| 5 | Jobs | proxy while export encodes | 3.95 s (×1.5 vs idle) | — | PASS |
| 5 | IPC | ExportRequest for 2,500 clips: size / stringify / structuredClone | 1.5–1.9 MB / 8.9 ms / 20 ms | ≤50 ms | PASS |
| 5 | IPC | previewExportCommand round trip (IPC + graph in main) | 445 ms (3,178 inputs, 811 k-char filter) | ≤500 ms | PASS |
| 5 | Playback | autosave of big project while playing: round trip / fps / long tasks | 6,006 ms / 1.1 fps / 14 (max 610 ms) | ≤500 ms / ≥23 / ≤2 | FAIL |
| 6 | Export | buildRenderGraph 2,500 clips (median) / filter length | 18.5 ms / 626,610 chars, 2,500 inputs, 14,408 argv | ≤200 ms | PASS |
| 6 | Export | ffmpeg `-t 0.5` @ 100 / 500 clips: exit, RSS | 0, 756 MB / 0, 3,292 MB | exit 0 | PASS |
| 6 | Export | ffmpeg `-t 0.5` @ 2,500 clips | **killed at 6,159 MB RSS** after 15.8 s | exit 0, ≤4 GB | **FAIL** |

## Findings

| ID | Sev | Area | Title | Evidence | Root cause | Suggested fix → expected gain |
|----|-----|------|-------|----------|------------|------------------------------|
| P-01 | P1 | Export | Exporting a 2,500-clip sequence is impossible: ffmpeg OOMs | ffmpeg RSS grows about 6.5 MB per input: 756 MB @100 clips, 3.3 GB @500, killed at 6.2 GB @2,500 (still opening inputs after 15.8 s). `previewExportCommand` reports 3,178 inputs. | `electron/export/renderGraph.ts:261-276` `addInput` pushes a separate `-ss/-t/-i` for every clip segment (video and audio), so ffmpeg runs one demuxer and decoder per segment, all at once. | Open each source file once (`-i` per media) and cut it with `trim/atrim + setpts` from `split`/`asplit` outputs. Or render in chunks of ≤200 segments to intermediate files and join them with the concat demuxer. → memory scales with distinct media (≈60), not clips; expect <1 GB RSS and a working export. |
| P-02 | P1 | Renderer / playback | Each playhead or scroll step re-renders about 4,400 components in hidden panels; playback and scrubbing run at 1.7–7 fps | Probe at steady state: 4,376 component renders per playhead step (Continuity 2,655, Compare 1,320, Project 231, Markers 88, Storyline 35, Subtitles 24, Transcript 14, timeline 41) and 0 DOM mutations in tracks. Only `project` / `project.sequences` change identity. CPU profile per step: react-dom 24 %, `ContinuityPanel IssueRowView`, `DiffList Row`, `tree.ts compareMedia`, `sequenceDurationLabel`, `orphanCues`. Program 5.0 fps @1 px/frame, 1.7 fps @zoom-to-fit; scrub 4.1–7.3 fps; wheel 58–67 ms per event. | `shared/model.ts:273`: `view` (playhead/zoom/scroll) lives inside `Sequence`, so `setView` (`src/state/store.ts:279`) replaces `project.sequences` about 15–60 times a second. Panels that subscribe to that map or to the whole active sequence re-render: `continuity/ContinuityPanel.tsx:42`, `compare/ComparePanel.tsx:49`, `project/ProjectPanel.tsx:36`, `markers/MarkersPanel.tsx:58`, `transcript/SearchTab.tsx:44`. `components/layout/TabbedZone.tsx:146` keeps every inactive tab mounted (`display:none`), and its row components are not memoized or virtualized. | (a) Move `view` out of `Project.sequences` into a separate `views[seqId]` slice, persisted separately. Or make every panel select narrow fields (`tracks`, `markers`) with `useShallow`. (b) Do not render the bodies of inactive tabs: render `null`, or freeze them with `<Activity mode="hidden">` or a memo wrapper on `active`. (c) Memoize and virtualize Continuity and Compare rows. → per-step renders 4,400 → under 50; expect scrub ≥50 fps and Program ≥23 fps at 1 px/frame. |
| P-03 | P2 | Store | Regression: `reconcileTransitions` is O(clips × transitions) on immer drafts, which slows common edits 5–10× | moveClips 5.8 → 66 ms, deleteSelected 6.4 → 57 ms, insert-ripple 22 → 102 ms, setClipSpeed 15 → 90 ms (`8a80dc3` → `d13dd2b`, same script). Node CPU profile: 70 % of a moveClips commit in immer `isDraftable` / `get` and the two `find` callbacks. | `shared/timeline.ts:105-113` (added in `45bc87c`, "transition limits"): for every clip of the track, two `track.transitions.find(...)` run through draft proxies, so 625 clips × 2 × ~37 transitions × 8 tracks of proxy reads per commit. `reconcileAll` (`:134`) runs it on every track. | Loop over `track.transitions` (≈37) and build `inClipId → tr` and `outClipId → tr` maps once. Look clips up through `byId`, and read from `original(track)` (or `current`) so no proxies are created. Only reconcile tracks the op touched. → back to ≤10 ms per commit. |
| P-04 | P2 | Renderer / editing | Every edit takes 270–820 ms from commit to paint | insert 309, razor 297, moveClips 431, rippleDelete 819 (max 3,056), undo 280 ms. 300 commits with the UI mounted take 25.3 s, with 31 long tasks up to 1.6 s. With only the Program monitor maximized (timeline still mounted), razor still costs 33–191 ms. | P-02 (hidden panels recompute issue lists, diffs and sorted media trees on every `sequences` change) plus P-03 (store) plus a full TimelineBody pass. `ContinuityPanel.tsx:58` `allRows` and `ComparePanel` diff rebuild over all 12 sequences on every edit. | Fix P-02 and P-03 first, then key the derived data (continuity issues, compare diff) on the specific sequences they read, not on the whole map. → ≤50 ms commit to paint. |
| P-05 | P2 | Timeline | No level of detail at zoom-to-fit: 2,500 clips mounted (30 k nodes), 3.5 s first paint, a 265-request filmstrip storm and a 47 s queue drain | First paint 3,516 ms @zoom-to-fit vs 567 ms @1 px/frame. Zoom-to-fit transition 1.3 s. 2,500 clips + 1,250 `<img>` + 1,250 `<canvas>` for 2-px-wide clips. 265 filmstrip IPC calls in 3 s, 47 s to drain, and a thumbnail MISS waits 9.2 s behind the storm. 500 queued thumbnails take 35 s. | `src/panels/timeline/TimelinePanel.tsx:581-590` culls only by viewport, so at fit every clip is "visible". `ClipView.tsx:68-94` requests a filmstrip and mounts a waveform canvas even when the clip is narrower than one tile. Its cleanup only drops the result; the IPC still runs. `electron/media/thumbs.ts:21-29` is a FIFO semaphore with no cancellation or priority. | Below about 8 px per clip, draw each track as one canvas, or merge adjacent clips into blocks, with no filmstrip or waveform. Skip the filmstrip when `w < tileW`. Make thumbnail requests cancellable (an AbortSignal through IPC) and LIFO, so the newest viewport wins. → ≤3,000 nodes and ≤200 ms first paint at fit; IPC bounded by the number of visible tiles. |
| P-06 | P2 | IO / playback | Autosave of a big project takes 1.6 s, or 6 s while playing, and stalls playback | 66.9 MB pretty JSON on disk (27 MB compact). Renderer `structuredClone` 340 ms and `JSON.stringify` 162 ms on the main thread. Autosave 1,593 ms idle; while playing 6,006 ms, with Program at 1.1 fps and 14 long tasks up to 610 ms. Save 2.9 s; open 3.2 s with a 2.5 s long task. Snapshots of 12 sequences hold 11.8 MB. | `shared/project.ts:199` `JSON.stringify(p, null, 2)`; `src/state/mediaActions.ts:311` structured-clones the whole project across IPC; `src/app/project.ts:180` fires 5 s after the last change regardless of playback; snapshots store whole sequence copies. | Write compact JSON (2.5× smaller). Defer autosave while playing or scrubbing (`requestIdleCallback`). Send a string built off the main thread, or send per-sequence diffs. Store snapshots as structural diffs or in a sidecar. → autosave ≤300 ms with no long task during playback. |
| P-07 | P3 | Jobs | Two long scene detects starve every proxy | With two 2-h scene detects queued, a proxy is still `queued` 8 s later and the detects report 0 % after 10 s. The proxy completes only 10.6 s after the detects are cancelled. Thumbnails are unaffected (135 ms) because they bypass the queue. | `electron/jobs/jobQueue.ts:4,162`: proxies, scene detects and waveforms share one `media` lane limited to 2. `electron/media/sceneDetect.ts:68-75` decodes every frame at source resolution (scaling happens after decode) and reports no progress for a long time. | Split lanes (interactive: proxy, waveform; background: scene detect, limit 1) or add priorities with preemption. Decode scene detection with `-skip_frame noref` / `-flags2 +fast` / `-threads` and emit `-progress`. → proxies start within 1 s. |
| P-08 | P3 | Playback | `planFrame` scans every clip and calls `transitionsForClip` per clip, every frame | Median 0.9 ms, max 11 ms on the 2,500-clip sequence (node). 10.6 % of renderer CPU during playhead steps (`planner.ts:98 contributionsAt`). `transitionsForClip` is the top function at zoom-to-fit (5.3 %). | `src/playback/planner.ts:98-104` loops over all `track.clips` and calls `transitionsForClip(track, clip.id)` (`shared/timeline.ts:138`, a linear scan) for each clip. | Binary-search the sorted clips for the frame and only consider neighbours. Cache a per-track transitions-by-clip map in a WeakMap keyed by the track. → about 0.02 ms per frame. |
| P-09 | P3 | Scenes | Scene Library is not virtualized; filter keystrokes take about 100 ms | Filter "the" 120 ms and "scene 1" 96 ms to next paint, with 3–6 long tasks; 400 rows mounted; sort by source 20.4 ms. On a clip selection the Scenes panel alone renders 5,228 components. | `src/panels/scenes/ScenesPanel.tsx:262-287` renders every row and card (`SceneRow`/`SceneCard` are not memoized, and `common` props are rebuilt each render). It subscribes to `ui.selectedClipIds` (`:41`). `sceneUtils.ts:101-111` calls `localeCompare(…, {numeric})` per comparison. | Virtualize as the Project panel already does (59 fps over 3,000 rows). Memoize rows. Use one cached `Intl.Collator`. Drop the `selectedClipIds` subscription unless the import-candidate UI is open. → keystroke ≤30 ms. |
| P-10 | P3 | Transcript | Sequence-scope search re-runs on every playhead move | `searchTranscript("the")` with sequence scope takes 42–76 ms, versus 2.4 ms for project scope. With that scope selected, the search re-runs whenever `project.sequences` changes, which includes every playhead step (P-02). | `src/panels/transcript/SearchTab.tsx:55-59` uses `liveSequences = sequences` as a memo dependency. `timelineHitsFor` scans every clip for each match. | Depend on the active sequence's tracks rather than `sequences`. Precompute `mediaId → clips` once per tracks identity. → ≤5 ms, and nothing runs on playhead moves. |
| P-11 | P3 | Timeline | Switching sequences takes 0.5–1.4 s | 20 switches: median 517 ms, max 1,364 ms, with 49 long tasks (12.2 s in total). First paint of the big sequence takes 567 ms even at 1 px/frame. | `TimelinePanel.tsx:47` `key={seqId}` remounts the whole TimelineBody, and hidden panels re-derive on `activeSequenceId` (P-02). | Keep TimelineBody mounted and let it react to `seqId`; compute derived data lazily. → ≤150 ms. |
| P-12 | P4 | Playback | Audio graph and `<video>` churn grow with sequence switches | GainNodes 275 → 365 after 20 switches (never pruned). `<video>` elements created: 876 after 10 s of playback, 1,088 after 20 switches; live elements stay at 16. | `src/playback/sequencePlayer.ts:431-437`: `trackGains` is keyed by track id and only cleared in `destroy()` (`:276`). `elementPool.ts:127` recreates evicted elements rather than reusing them. | Prune `trackGains` for tracks that are not in the new sequence on `setSequence`. Reuse pooled `<video>` elements by swapping `src` instead of creating new ones. → bounded nodes; less GC. |
| P-13 | P4 | IO | `normalizeProject` slowed down after today's repairs | 51.5 → 91.5 ms per load on the big project (`8a80dc3` → `d13dd2b`). It runs twice on open (main and renderer), which contributes to the 2.5 s long task on open. | Added repair passes in `shared/project.ts` (the `normalizeProject` diff in `d13dd2b`). | Skip the renderer pass when main has already normalized the same version (pass a flag), and keep repairs O(n). → about 50 ms saved per open. |

### Notes on the measurements

* The render counts come from a React DevTools-hook walker in `tests/perf/_electron-common.mjs`. An earlier version
  counted each fiber object only once, so it under-counted after double buffering (it reported 0 renders per step).
  It now counts a fiber when PerformedWork is set *and* its props or state changed. The CPU profile
  (`electron-cpuprof.mjs`) is the independent check: it shows `IssueRowView`, `DiffList Row` and `compareMedia`
  running on plain playhead steps.
* `performance.memory` in the renderer is quantized, so renderer heap rows are flat. Heap growth over 300 commits is
  taken from the node run (`store.perf.test.ts`, with forced GC).
* "media with proxy ready: 6 of 20 requested": the 20 proxy jobs cover only 7 distinct source files and are
  deduplicated by path, so RSS and wall time reflect the unique encodes.
* Two Project-panel rows report `0` (virtual list height and transcript rows mounted) because the selectors in
  `electron-perf.mjs` no longer match the current markup. The paint and keystroke timings next to them are valid.
* `main.perf.test.ts` reads ffmpeg RSS with `pgrep -x ffmpeg` system-wide, so concurrent agents can inflate it.
  The 3.9 GB "waveform child" value in one run was contamination. The Electron run measured 124 MB.

## Deliberate rendering trade-offs

Two changes to timeline UI chrome (roadmap §1, A4) trade exact pixel parity with the old rendering for cheaper
scrubbing and playback. They are intentional and not visual regressions. Functional geometry, timing and hit testing
are unchanged and covered by strict tests. The Program monitor and export do not use this code.

* **Waveforms are filled device-pixel bars** (`src/panels/timeline/waveBars.ts`, `ClipView.tsx`). Before, each clip
  drew one anti-aliased path of 1 CSS px rects, and the browser then resampled the canvas to the screen. Now the canvas
  backing store maps 1:1 onto device pixels, and each device column gets one bar drawn with integer `fillRect` calls.
  Adjacent columns of the same height merge into one rect. A column's bar spans ±(the maximum of every waveform sample
  that overlaps the column), so a one-sample transient still shows at full height. Every column draws at least
  1 device px. Bar ends are rounded to the nearest device row, so the edges are hard instead of anti-aliased.
* **The playhead is one composited layer** (`Playhead.tsx`). Before, the line and head were two absolutely positioned
  divs, and every `left` change repainted the page and re-layerized it. Now the line and head move together with
  `transform` only. A paused Web Animation holds the transform. Chromium can update the transform of an
  animated layer without re-layerizing the page, which it cannot do for a plain `style.transform` change. The
  transform is set in a layout effect in the same commit as the store update, so it is never a frame late. The
  transform is always a whole number of device pixels. When the lane starts at a fractional device pixel (a zone
  split at dpr 1.5), a static layout offset absorbs the fraction. Otherwise the compositor would resample the line
  into a blurred 2-px stripe.
  The layer keeps `pointer-events: none` and the z-index of the old line (12): it sits above clips, the ruler and
  overlays, and below popovers, menus and dialogs.

Measured on the 3 h sequence (6,725 clips). Before is `origin/main` `a4a456f` and after is this branch. Runs alternated
before/after, 5 runs each: 3 on `06a62e8` and 2 on the final code, which changes the playhead's layout offset only and
measured the same. The figures are medians of per-run values from Chromium traces of the main thread. The machine was
shared and xvfb used software GL. Load average was 1.9–4.0 during the runs, mostly from the bench's own Electron
processes.

| 3 h sequence @ 1 px/frame | before | after |
|---|---|---|
| Scrub within the visible page: main thread per frame | 7.20 ms | 6.17 ms (−14 %) |
| … of which Layerize | 2.31 ms | 1.08 ms (−53 %) |
| … of which Paint | 0.67 ms | 0.68 ms |
| Page-flip scrub (all lanes re-rendered every frame): main thread per frame | 18.14 ms | 17.69 ms |
| … of which Paint | 2.61 ms | 1.73 ms (−34 %) |
| … of which Layerize | 2.38 ms | 2.51 ms (+0.13) |
| Program playback (24 fps): main thread per frame | 4.33 ms | 4.05 ms |
| … Layerize per second | 71.8 ms | 41.8 ms (−42 %) |

The bench rows did not change. Scrub fps stays at 60 within the page and 53–59 with page flips. Program playback
stays at 24 fps. Long tasks stay at 0, except on the page-flip rows, which run first after the profiling traces.
Those rows had 1–3 long tasks in 3 of the 5 before runs and in 2 of the 5 after runs.

Visual and geometry validation was done at dpr 1, 1.5 and 2, comparing before and after screenshots at five zoom and
scroll views:

* Each drawn waveform column matches a brute-force recomputation from the waveform data (top and bottom row =
  ±max of all samples in the column). At dpr 1 and 2 every column matches, and no canvas is resampled (before, most
  canvases were stretched to a fractional CSS width, and at dpr > 1 also scaled up). At dpr 1.5, 0–7 of 5,000–10,000 columns per view differ
  in the check. All of them match once the checker allows for the 1/64 px rounding of the canvas offset it reads
  back from layout.
* Outside the waveforms and the playhead, 0–152 device pixels per view differ, by at most 30/255. These are glyph
  and icon anti-aliasing differences in clip headers. Clip bounds, labels and colours are unchanged.
* The presented playhead was checked in compositor output: 260–610 CDP screencast frames per ratio, at dpr 1,
  1.25, 1.5 and 2. The frames covered scrub, zoom, scroll, playback with pause and resume, window hide and show
  (under xvfb the page stayed visible), and page freeze and resume. In every frame the line was a crisp line on the
  device pixel nearest `frameToX`. It was also in the same frame as a marker that the store moved on the main thread,
  so no frame was late or blurred.
* Hit tests on the head and ruler (click and drag), and a context menu covering the playhead, gave the same results
  before and after.

Strict tests: `tests/unit/timeline-waveBars.test.ts`, `tests/unit/timeline-playhead.test.ts`, and the waveform-canvas
and playhead-geometry steps of `tests/e2e/timeline.spec.ts`. The only tolerance is one layout unit (1/64 device px) on
the playhead's x. No test compares timeline pixels, so no test had to tolerate anti-aliasing differences. There is
no "high-quality waveform" preference and no debug flag: the optimized path is the only one.

## Gate re-run on 0.8.0 (8 October 2026)

Release-candidate item "the performance gate on the reference machine", re-run because `tests/perf/baseline.json`
(4bb1655, 7 October) predates the 0.8.0 features (nested sequences, keyframes, MKV, delivery formats, channel
selection, Whisper).

- **Code:** `main` 3b9ffdf (0.8.0 plus PR #92). Same-host A/B against 0.7.0 (2aaf2c0; `tests/perf` is identical in
  both).
- **Machine:** the 4-core cloud container of the reference class (Xeon 2.10 GHz, 16 GB, Node 22.22.0, FFmpeg
  6.1.1-3ubuntu5, xvfb with software GL). Calibration js ×0.88–0.93, ffmpeg ×1.00–1.01, render ×0.93–0.98, so
  every verdict was raw (within ±10 %).
- **Isolation:** each run held the shared heavy and perf locks and started at a 1-minute load of 0.17–1.0. Exceptions:
  in full run 2 something outside the locks pushed the load to about 22 during the node suite (the Electron part
  started at 1.9), and verification run V1 overlapped a 10-second unlocked node test of mine.

**Runs:**

| Run | What | Verdict |
|---|---|---|
| R1 | Full `npm run perf:check` | 97/98 gates; guardrails failed: filmstrip cold, autosave while playing |
| R2 | Full `npm run perf:check` | 96/98 gates; guardrail failed: autosave while playing |
| A/B | `perf-check.mjs --ab <0.7.0> <main> --electron-only`, 3 runs each | B WORSE in 0 gates and 0 guardrails, B better in 1 |
| V1, V2 | Electron only, with the bench fix below | V1 92/96 gates (wheel rows were the overlap above); V2 96/96 gates and 39/39 guardrails |

`--from` over R1 and R2 gives 96/98 gates and 126/130 guardrails.

**Every row that missed in any run.** B1–B3 are main and A1–A3 are 0.7.0 in the A/B. The table shows raw values,
with the budget in brackets.

| Row (tier) | R1 | R2 | B1–B3 | A1–A3 (0.7.0) | V1 | V2 | Verdict |
|---|---|---|---|---|---|---|---|
| long tasks during scrub multi-hour @ 1 px/frame, no selection (gate, == 0) | 2 | 3 | 0, 0, 0 | 5, 4, 3 | 4 | 0 | Flaky and pre-existing: no change against 0.7.0, which fails 3/3. Fixed in the bench on 9 October (see below and `https://github.com/jelloshooter848/ReCut/blob/59eafc65917cf0d5ec5344079a5c84811bfcf80c/bugs/closed/2026-10-08-perf-multi-hour-scrub-long-tasks-flaky.md`) |
| long tasks during scrub @ 1 px/frame, within the visible page, no selection (gate, == 0) | 0 | 1 (56 ms) | 0, 0, 0 | 0, 0, 0 | 0 | 0 | Noise: one task 6 ms over the 50 ms limit in the run with outside load |
| wheel ×100 @ 1 px/frame: median / fps / real mouse.wheel long tasks (gates) | 7.1 ms / 55.6 / 0 | 6.1 / 57.0 / 0 | pass | pass | 9.7 / 48.7 / 1 | 6.4 / 58.6 / 0 | Noise: V1 overlapped my unlocked test |
| main filmstrip 48 frames cold (guardrail, ≤ 3,000 ms) | 3,036 | 2,859 | (node) | (node) | — | — | Pre-existing: the baseline median is 2,984 ms, over budget in 1 of its 2 seed runs; `electron/media/thumbs.ts` is unchanged since 0.7.0. Open: [#155](https://github.com/jelloshooter848/ReCut/issues/155) |
| autosave round trip while playing (guardrail, ≤ 500 ms) | 574 | 658 | 764, 611, 617 | 618, 657, 569 | 274 | 231 | Bench artifact; fixed below |
| store insertFromSource overwrite (p95) (guardrail, regression) | 1.65 ms | 6.58 ms | (node) | (node) | — | — | Noise: R2's node suite ran at load 22; two more store-only runs gave 1.90 and 1.45 ms (baseline 1.45) |
| pool: media elements created during 10 s playback (guardrail, count, baseline 0) | 1 | 2 | 2, 2, 2 | 1, 2, 1 | 2 | 0 | Not a 0.8.0 change: the row reads 0–2 on every build since the seed (1 and 2 on 7 October code equal to the baseline's playback code); the seed's 0 / 0 was the low end. The A/B calls it `same`. Fixed in the bench on 9 October (see "Program scrub stall and pool row" below) |

**The four rows that missed on a loaded run earlier today** (load 4.1) all pass on quiet runs:

| Row | Earlier today (load 4.1) | R1 | R2 | Budget |
|---|---|---|---|---|
| openProject round trip | about 1,080 ms | 798 ms | 798 ms | ≤ 1,000 ms |
| sequenceDuration | 0.22 ms | 0.11 ms | 0.10 ms | ≤ 0.2 ms |
| planFrame multi-hour (max) | 8 ms | 1.36 ms | 1.16 ms | ≤ 4 ms |
| filmstrip cold | 3,007 ms | 3,036 ms | 2,859 ms | ≤ 3,000 ms |

filmstrip cold is the pre-existing borderline row in the table above. The multi-hour open handler (diagnostic) was
1.35× its baseline on the loaded run; on the quiet runs it is 1.02×, 1.08× in the A/B, and equal to 0.7.0
(B/A ×1.10, within the band).

**Changes:**

- **Bench fix (`electron-perf.mjs`, autosave while playing).** Since 0.7.0 the media caches are keyed on content
  (`electron/media/identity.ts`). The "proxy of a 60 s file while export encodes" step copies `S01E03.mp4`, which
  the 20-proxy step had already proxied. The copy therefore hit the cache and finished in 0.6 s instead of encoding
  (22 s on 7 October). That moved the autosave into the busiest part of the background export: 570–760 ms on both
  0.7.0 and 0.8.0, against 200 ms in the baseline. The copy now gets a per-run MP4 `free` box, so it is new content
  again: the proxy encodes (3.2 s), and the autosave reads 274 and 231 ms. No budget or baseline changed.
- **New 0.8.0 coverage (`store.perf.test.ts`, section `nest`, guardrails).** The scenario uses a duplicate of the
  2,500-clip sequence with 20 compound clips (480 clips nested one level deep) and 638 keyframed clips (scale and
  opacity, or level, with 3 keys each). Four runs measured:
  - `flattenSequence` after an edit in the host: 3.5–4.6 ms.
  - `flattenSequence` after an edit inside a nested sequence: 2.7–3.4 ms.
  - `planFrame` on the flattened, keyframed sequence: median 0.03–0.05 ms, max 2.1–3.4 ms.

  Budgets are 16 ms for the flatten rows (Program re-flattens on every edit, so they take the store-commit
  budget of one frame) and 2 / 4 ms for the planFrame rows (the per-frame budgets of the other planFrame rows). The
  rows have no baseline until the next re-seed. The pathological fan-out case is a separate bug
  (`https://github.com/jelloshooter848/ReCut/blob/59eafc65917cf0d5ec5344079a5c84811bfcf80c/bugs/closed/2026-10-08-nested-fan-out-flatten-blowup.md`).
- **Baseline unchanged.** No row regressed because of a 0.8.0 cost, nothing improved enough to lock in, and the
  machine is the reference class. None of the conditions for a re-seed applies.

**Verdict: no 0.8.0 performance regression.** The A/B shows no gate or guardrail worse than 0.7.0. The gate is still
not reproducibly green on this container: the multi-hour scrub long-task gate is flaky on both 0.7.0 and 0.8.0, and
filmstrip cold sits on its budget. That is filed in the bug above for the owner, as a 1.0 item ("The performance gate
passes").

### Multi-hour scrub long tasks: root cause and fix (9 October 2026)

**This is a fix to the test harness, not to the app.** The flaky gate `long tasks during scrub multi-hour @ 1 px/frame,
no selection` measured an artifact of how Playwright launches Electron, which the shipped app never hits. No app code,
budget, tier, row name or baseline changed. Record: `https://github.com/jelloshooter848/ReCut/blob/59eafc65917cf0d5ec5344079a5c84811bfcf80c/bugs/closed/2026-10-08-perf-multi-hour-scrub-long-tasks-flaky.md`.

- **What the long tasks were.** They were ordinary page-flip frames: about 15 ms of main-thread work at 60 fps, with
  the thread about 95 % busy. In each long task every phase (JS, style, layout, paint, layerize) ran 4–8× its usual
  cost for the same work, with no GC and no extra work. Thread CPU time equalled wall time, and the thread had no
  run-queue wait: the whole renderer ran slower, it was not preempted.
- **Why.** Playwright's Electron loader appends `--disable-dev-shm-usage` (`playwright-core`
  `lib/server/electron/loader.js`). With it, Chromium creates its shared memory (decoded video frames,
  software-compositor tiles, IPC buffers) as deleted files in `TMPDIR`, and `/tmp` is the ext4 disk on this
  container. Scrubbing dirtied 400–800 MB of these file pages in the renderer. About 30 s later the kernel's flush
  worker wrote them back, and while it did, the renderer ran 4–6× slower for 0.2–0.5 s. In all 5 sampled runs, the
  long tasks (3 runs) or their absence (2 runs) lined up exactly with that writeback. The app's autosaves added only
  about 30 MB each. The timing of the flush against the 3 s pass decided pass or fail, hence about half the runs.
- **The shipped app never gets the switch.** `electron/main.ts` appends only `no-sandbox` (when given) and
  `enable-blink-features`. A normal launch keeps Chromium's shared memory in `/dev/shm` or memfd, in RAM.
- **Fix.** `tests/perf/_launch-env.mjs`: `electron-perf.mjs` and every script using `_electron-common.mjs` launch
  the app with `TMPDIR` on a per-run directory in `/dev/shm` (Linux), so the regions are RAM-backed again.
  - It is used only when `/dev/shm` has at least 2 GiB free. Otherwise it warns and keeps the old behaviour: a full
    run keeps up to 0.60 GB live there, and a too-small tmpfs would crash Chromium, which is why Playwright adds the
    switch in the first place.
  - `RECUT_PERF_DISK_SHM=1` restores the old behaviour.
  - No CI workflow runs `tests/perf`; Windows is unaffected.

**A/B of the one variable (same machine, interleaved, locked, quiet).** A harness reproduced the scrub in about 40 s
per run: big project, 20 distinct media copies as in the bench, the multi-hour sequence, the bench's sweep driver.
Each run has a timing pass and a counting pass.

| Shared memory in | Runs | Passes with long tasks | Long tasks (ms) | Renderer disk writes per run |
|---|---|---|---|---|
| `/tmp` (disk), before | 8 | 4 of 16 | 56, 63, 58, 68 | 435–463 MB |
| `/dev/shm` (tmpfs), after | 6 | 0 of 12 | — | 0 |

**Full bench.**

| | Runs | The row (long tasks) |
|---|---|---|
| Before (37912dd) | 11 | 0, 4, 3, 2, 0, 0, 4, 0, 3, 0, 3 (fails in 6 of 11; tasks of 50–101 ms) |
| After | 5 single runs, plus `perf:check --runs 2` | 0 in all 7 |

**`npm run perf:check -- --runs 2` after the fix.**
- Gates: **98 of 98 PASS** in both runs, with raw verdicts (the host calibrated within ±10 %).
- Guardrails: 132 of 134.
  - The pool row read 2 and 2: fixed below, `https://github.com/jelloshooter848/ReCut/blob/59eafc65917cf0d5ec5344079a5c84811bfcf80c/bugs/closed/2026-10-09-perf-pool-elements-created-during-playback.md`.
  - `filmstrip 48 frames warm` read 5.6 and 13.8 ms against 5.2 ms. It is noise: the node suite is unchanged, and
    three locked reruns read 4.35, 4.73 and 3.65 ms.
- `filmstrip 48 frames cold` passed at 2,528 and 2,706 ms but stays borderline:
  [#155](https://github.com/jelloshooter848/ReCut/issues/155).

**Side finding.** In 1 of 11 runs (possibly 2) the Program monitor issued no seeks during the whole scrub:
`https://github.com/jelloshooter848/ReCut/blob/59eafc65917cf0d5ec5344079a5c84811bfcf80c/bugs/closed/2026-10-09-program-scrub-stalls-on-unready-element.md` (fixed below).

The same artifact applies to every Playwright-launched suite (e2e, attack). They check correctness, not timing, and
are unchanged. Perf results recorded before this fix on a disk-backed `/tmp` include the writeback noise. Mostly the
page-flip and decode-heavy rows were affected.

### Program scrub stall and pool row (9 October 2026)

Two open items from the run above. Records: `https://github.com/jelloshooter848/ReCut/blob/59eafc65917cf0d5ec5344079a5c84811bfcf80c/bugs/closed/2026-10-09-program-scrub-stalls-on-unready-element.md`
(app fix) and `https://github.com/jelloshooter848/ReCut/blob/59eafc65917cf0d5ec5344079a5c84811bfcf80c/bugs/closed/2026-10-09-perf-pool-elements-created-during-playback.md` (bench fix).

**Program monitor scrub stall (app).**
- **The bug.** `SequencePlayer` waited for a media element's seek without limit, and it never issued a seek again
  on an element that reported `seeking`. If Chromium left one paused seek pending, the Program monitor stopped
  following every scrub with that element in view. That covered the drag and the update at rest, until playback.
  In bench run s3 the same 2 elements stayed in flight through 5 scrub rows and their rests: 0 seeks in 3 timing
  passes.
- **The fix** (`src/playback/sequencePlayer.ts`).
  - A paused seek still pending after `SEEK_STALL_MS` (1 s) is issued again. Each retry of the same element may
    take twice as long (up to 16 s), so a slow seek still lands.
  - A scrub round with a stalled seek is dropped undrawn, and the next round seeks to the latest playhead.
  - At rest, a timer re-checks at the earliest stall deadline.
  - Normal scrubbing is unchanged: one seek per element per round, never queued behind a pending seek that has not
    stalled.
- **Tests.** Regression tests in `tests/unit/program-scrub.test.ts` (deterministic, fake elements) and in
  `tests/e2e/program.spec.ts` (the real app, with a stalled seek simulated). Both fail on 2494b6e.
- **Not found: what makes Chromium leave the seek pending.** 16 more instrumented bench runs logged element state
  and media-internals before every scrub row; none stalled (1 or 2 in 27 runs overall). Synthetic seek storms in a
  bare Electron page (up to 16 elements, `file://` and the app's protocol, element churn, long-GOP 1080p) never
  left a seek pending either. Under load, 12 concurrent 1080p prerolls took 3–10 s per seek, which is why retries
  back off instead of restarting a slow seek every second.

**Pool row (bench).** `media elements (<video> + <audio>) created during 10 s playback @ 1 px/frame` (guardrail, count,
baseline 0) read 0–2.
- **Why.** The row counted creations during the first playback of frames 0–275. Its starting pool is whatever the
  scrub rows left in the 16 slots: the 2,500-clip sequence has 7 files, and its cross-fades need a second element of
  a file. Instrumented runs: 2, 2, 2, 2, 2, 2, 2, 2, 0, 2, 1, 0, 1, 2, 2, 2.
  - Every creation was an `<audio>` element made by `updateAudio → assignSlots → acquire`, for a (file, slot) pair the
    pool did not hold. Every eviction was of an element no clip in the range uses.
  - A replay of the same 10 s created 0 in every trial: no thrashing, no churn, just first use.
- **The fix** (`tests/perf/electron-perf.mjs`).
  - The first playback still runs exactly as before. Its gates (`program fps`, `long tasks @ 1 px/frame timeline`)
    are measured on it.
  - Then the same 10 s is replayed from frame 0 (`playFor(…, { record: false })`), and the pool row counts that
    replay. The first playback's count goes in the note.
  - The pool then holds exactly what the range needs, so a correct player reads 0, and churn still shows in full.
  - Row name, budget, tier, baseline and the zero-baseline tolerance are unchanged.

**`npm run perf:check -- --runs 2`, twice** (this branch; heavy and perf locks held, each set started at a load of
1.0 or less):

| | Run set 1 (03:12 UTC) | Run set 2 (03:40 UTC) | Both sets, `--from` over the 4 runs |
|---|---|---|---|
| Calibration (js / ffmpeg / render) | ×0.81 / ×0.96 / ×0.93 | ×0.85 / ×0.92 / ×0.91 | ×0.85 / ×0.94 / ×0.91 |
| Gates | 98 / 98 PASS | 98 / 98 PASS | 98 / 98 PASS |
| Guardrails, normalized | 131 / 134 | 133 / 134 | **134 / 134** |
| Guardrails, raw on this host | 134 / 134 | 134 / 134 | 134 / 134 |
| Exit | FAIL | FAIL | **PASS** |
| Pool row (replay) | 0, 0 (first playback: 1, 1) | 0, 0 | 0 [4/4] |
| Long tasks during scrub multi-hour @ 1 px/frame | 0, 0 | 0, 0 | 0 |
| filmstrip 48 frames cold (node) | 2,787 ms | 2,571 ms | PASS |

Each `--runs 2` set failed one to three guardrails only after normalization. Each time it was different node-suite
microbenchmark rows of a few milliseconds:
- Set 1: `project: search keystroke -> rows rebuilt (max)` 12.1 ms against a budget of 16 (raw 9.9), and
  `buildRenderGraph @ 500 / 1000 clips` ×1.61 / ×1.53 against the baseline (raw ×1.31 / ×1.25).
- Set 2: `transcript: keystroke search cost (max)` ×1.60 (raw 8.5 ms, spread 5.0–12.0).

This branch does not touch the code these rows measure: `src/panels`, `shared/` and the export graph. They pass raw
in every run. They fail only when the host's js calibration came out at ×0.81–0.85, which divides their times by
that factor. The median over all 4 runs (`perf-check.mjs --from`, the documented way to aggregate runs) passes every
gate and guardrail.

## How to run

All scripts write JSON to `$RECUT_PERF_OUT` (default `test-results/perf/`) and print a table.

```
# pure / main-process / export benches (node; about 9 min, most of it the chunked export of the whole 26-min
# sequence; needs ffmpeg; generates a 20-min file on first run). `npm run perf:check` runs both suites and gates.
NODE_OPTIONS=--expose-gc RECUT_PERF_SCRATCH=/tmp/recut-perf npx vitest run -c tests/perf/vitest.config.ts
#   store.perf.test.ts   commits, undo/redo, heap over 300 commits, serialize/parse/normalize/clone, planFrame
#   panels.perf.test.ts  project rows, transcript search, scene filter/sort, timeline culling
#   main.perf.test.ts    thumbnail hit/miss, filmstrip, 2-h waveform, job-lane fairness
#   export.perf.test.ts  buildRenderGraph 100..2500 clips + real ffmpeg -t 0.5 runs with RSS watchdog (6 GB kill)
RECUT_PERF_PROFILE=1 npx vitest run -c tests/perf/vitest.config.ts tests/perf/profile-commit.perf.test.ts  # P-03 CPU profile

# Electron (needs npm run build; media from scripts/make-test-media.sh is generated on first run)
xvfb-run -a -s "-screen 0 1920x1080x24" node tests/perf/electron-perf.mjs [--long <2h file>]   # full suite, about 4 min
xvfb-run -a -s "-screen 0 1920x1080x24" node tests/perf/electron-probe.mjs     # renders per playhead/scroll step by panel (P-02)
xvfb-run -a -s "-screen 0 1920x1080x24" node tests/perf/electron-cpuprof.mjs   # CDP CPU profile mapped through sourcemaps
xvfb-run -a -s "-screen 0 1920x1080x24" node tests/perf/electron-attrib.mjs    # same scenarios under 4 layouts
```

Env: `RECUT_PERF_SCRATCH` (scratch root), `RECUT_PERF_OUT` (results), `RECUT_PERF_MEDIA` (test media dir),
`RECUT_PERF_LONG_FILE` (a long file for the waveform and scene-detect runs). The Electron scripts kill the app on exit,
because `app.close()` can hang on the unsaved-changes prompt.
