# ReCut attack QA report

Scope: Electron + React NLE at `/home/user/ReCut`, working tree as of 2026-10-04 (HEAD `5f75c16` plus another agent's
uncommitted fixes — notably `setProxy` / `setOffline` / `relinkMedia` / `setSceneDetectStatus` became quiet (non-undoable)
while this report was being written; findings below are against the **current working tree**).

Every finding was reproduced by a test in `tests/attack-qa/`. A failing test = reproduced bug. Nothing in `src/`, `shared/`
or `electron/` was modified by this pass.

How to run:

```
npx vitest run -c tests/attack-qa/vitest.config.ts                       # 84 tests, ~10 s (the repo config only includes tests/unit)
xvfb-run -a npx playwright test -c tests/attack-qa/playwright.config.ts  # 3 specs, ~6 min, needs npm run build
```

## Verdict

**Not shippable.** Two P0s in the quit path (a dirty project is force-quit 3 s after the Save/Don't Save/Cancel prompt
appears — pressing *Cancel* does not help, and simply reading the prompt for >3 s loses the work), one P1 that destroys
source media (exporting onto a file that is also an input deletes the original), and a P1 in project loading that
silently swaps a newer-format project for a stale `.bak` and then lets you overwrite the newer file. The pure timeline
core is in good shape: 1 500 random edit operations across three seeds undo/redo to byte-identical state and never
produce overlapping, negative or NaN clips. Most of the remaining findings are missing validation at the IPC boundary
(the dialogs validate, `main` does not), missing repair in `normalizeProject`, and subtitle-cue bookkeeping holes.

Counts: P0 ×2, P1 ×4, P2 ×7, P3 ×13, P4 ×7 (33 findings, every one backed by a failing test).

## Findings

| ID | Sev | Area | Title | Repro (test) | Expected | Actual | Root cause guess | Suggested fix |
|---|---|---|---|---|---|---|---|---|
| QA-01 | **P0** | Lifecycle | App force-quits 3 s after the "Save changes?" prompt appears, while the user is still deciding | `lifecycle-quit.spec.ts` "P0: quit with a dirty project while the user has not answered…": dirty project, native dialog stubbed to never resolve, `window.recut.quit(false)`, wait 4.5 s | App stays open until the user answers | Process exits after ~3 s; unsaved work lost | `electron/main.ts:88-102` `requestQuit()` arms `quitTimer` (`QUIT_FALLBACK_MS = 3000`) when it asks the renderer, and the renderer's `handleBeforeQuit` (`src/app/project.ts:203`) awaits the native dialog with no way to cancel the timer | Drop the fallback once the renderer acknowledges the request (`ipc: quit:ack`), or make the timer only cover an unresponsive renderer (e.g. require `quit(true|false)` reply: `quit(false)` from the renderer = cancel → clear timer, `quitConfirmed=false`). Also clear the timer in `window-all-closed` paths. |
| QA-02 | **P0** | Lifecycle | *Cancel* in the quit prompt does not cancel: the app quits anyway ~3 s later | same spec, "choosing Cancel in the quit prompt must keep the app open": dialog stubbed to answer `2` (Cancel) | App stays open | App exits ≈3 s later | Same timer; renderer takes no action on Cancel (`src/app/project.ts:216-218` has no `else` branch) so nothing tells `main` to stand down | Add `quitCancel` IPC (or `quit(false)` meaning "renderer handled: stay") that clears `quitTimer`; renderer calls it on Cancel/failed save. |
| QA-03 | **P1** | Export | Exporting to a path that is one of the sequence's own source files deletes the original media | `export.test.ts` "DESTRUCTIVE: exporting onto a source file overwrites the original media" (real ffmpeg; also "…must be refused") | `startExportJob` refuses when `outputPath` equals any clip's `media.path` (or proxy path) | Export succeeds; `fs.unlinkSync(graph.outputPath)` + rename replace a 2 s source with the 0.5 s render | `electron/export/exporter.ts:147-148`; no path check in `startExportJob` (`:91`) or `buildRenderGraph` | In `startExportJob`/`buildRenderGraph`: resolve `outputPath` and compare (realpath, case-insensitive on win/mac) against every `media[*].path` used by enabled clips; return `{ok:false}`. Also compare against the sidecar `.srt`. |
| QA-04 | **P1** | Project I/O | A project saved by a newer ReCut is silently replaced by the stale `.bak`; the next save overwrites the newer file | `project-io.test.ts` "a project from a NEWER format must not be silently replaced by an older .bak" | `{ok:false, error:"…newer ReCut…"}` | `{ok:true, project: <old backup>}`; title shows the old project; Ctrl+S then clobbers the newer file (its content moves to `.bak`) | `electron/project/io.ts:103-107` falls back to `.bak` for *any* non-ENOENT error, including the version-guard error from `normalizeProject` | Only fall back on JSON parse errors / `ENOENT`-of-content; rethrow `normalizeProject` errors. Return `fromBackup: true` in `LoadResult` (see QA-10). |
| QA-05 | **P1** | Import | Importing a missing/removed file leaves `offline:false`, so the Relink flow never offers it | `import.spec.ts` "0-byte file, directory path, .recut file and a missing path…" (`gone.offline`) | Missing at probe time → `offline: true` (+ relink dialog) | `probeError: "file not found: …"`, `offline:false`; only a later project re-open flags it | `src/state/mediaActions.ts:35` + `store.setMediaProbe` (`store.ts:431`) never set `offline` | In `probeMedia`, `stat` first (or detect `ENOENT` in the error) and call `setOffline(id, true)`; mark offline when probe error is `file not found`. |
| QA-06 | **P1** | Proxies | Starting the same proxy twice (double-click "Generate proxy", or two panels) runs two ffmpeg jobs on the same `.part`; one job fails and the other marks a file *ready* that the loser was still writing | `media-proxy-export.spec.ts` "starting the same proxy twice…" — reproduced twice: run A `j1=failed, j2=done`, run B `j1=done, j2=failed`, error `ffmpeg exited with code 254: Unable to re-open …_540p.mp4.part output file for shifting data / Error writing trailer: No such file or directory` | Second request returns/attaches to the running job | Two `proxy` jobs for one media; job 2's `removeQuietly(outPart)` unlinks job 1's open output, the first to finish `rename`s whatever `.part` exists (the other job's partial file) into place and `setProxy(ready)`, the second fails its faststart pass; a "Proxy failed" toast appears for a proxy that is shown as ready | `electron/media/proxy.ts:83` + `startProxyJob` (`:117-135`) has no de-dup by output path/mediaId | Keep a `Map<outputPath, jobId>` of in-flight proxies in `startProxyJob`; return the existing `JobInfo`. Use a per-job unique `.part-<jobId>` name as a second line of defence. |
| QA-07 | **P2** | History | Importing N files produces 1 + N undo entries ("Probe media"); undoing an import of 500 files is impossible (history cap 200) | `undo-torture.test.ts` "importing 3 files should be one undo step"; `import.spec.ts` "500 files at once… ONE undo step" | One "Import N files" step | First undo only reverts one probe; after 500 files the import is beyond the 200-entry cap | `store.setMediaProbe` is a `commit` (`src/state/store.ts:427`) | Make `setMediaProbe` `quiet(…, {dirty:true})` like the other job mirrors, or fold probe results into the import commit. |
| QA-08 | **P2** | Project load | Clips with `start: NaN` / `Infinity` survive `normalizeProject`; `sequenceDuration` becomes `NaN` and the export graph is built with `-t NaN` | `project-io.test.ts` "clips with duration 0 / negative / NaN are dropped, but NaN or non-finite start…" and "…poisons sequenceDuration and the export graph" | Clip dropped (like duration ≤ 0) | Clip kept, `durationSec: NaN` render graph (ffmpeg fails late with an opaque error) | `shared/project.ts:107` checks `typeof c.start === 'number'` only | Use `Number.isFinite(c.start) && c.start >= 0 && Number.isFinite(c.duration) && c.duration >= 1 && Number.isFinite(c.sourceIn) && c.sourceIn >= 0`; also `Number.isFinite(c.speed) && c.speed > 0`. `buildRenderGraph`: throw if `!Number.isFinite(frameCount)`. |
| QA-09 | **P2** | Project load | Media in a bin whose parent chain is cyclic / self-parented / missing vanishes from the Project panel | `project-io.test.ts` "circular bin parents are repaired…" (uses the real `buildBinRows`) | Repair to root (`parentId:null`) on load | Bins unreachable from root are never walked (`tree.ts:191`), so their media and sequences are invisible everywhere in the panel | `normalizeProject` repairs nothing about bins; `moveToBin` guards cycles but files can contain them | In `normalizeProject`: drop `binId` references to unknown bins, break cycles by setting the offending `parentId` to `null`. |
| QA-10 | **P2** | Project I/O | Corrupt `.recut` silently opens from `.bak` with `ok:true`; user is not told and the next save turns the only good copy (`.bak`) into a copy of the corrupt file | `project-io.test.ts` "opening a corrupt .recut falls back to .bak — but must tell the caller" | `LoadResult` carries `fromBackup`/warning; UI toasts "Opened backup from <mtime>" | Indistinguishable from a normal open | `electron/project/io.ts:103-107` | Add `fromBackup: true` + `backupMtime` to the result; `requestOpenProject` toasts a warning; consider saving the corrupt file aside as `.corrupt` before the next `.bak` rotation. |
| QA-11 | **P2** | Subtitles | A carried cue that spans a razor point is truncated at the cut; its second half never shows again | `timeline-edges.test.ts` "razor keeps cue positions; a cue spanning the cut must not lose its second half" | Cue is split (or duplicated) across head/tail so the full span still renders | Cue stays on the head and `resolveSubtitleCues` clamps it to the head's end | `shared/timeline.ts:351` only reassigns cues whose `srcStart >= tail.sourceIn`; `resolveSubtitleCues` clamps to the clip (`:743`) | In `splitClip`, duplicate straddling cues: head keeps `[srcStart, splitSrc)`, tail gets a copy `[splitSrc, srcEnd)` with `clipId = tail.id`. |
| QA-12 | **P2** | Subtitles | Lift / extract / overwrite / `removeTrack` that remove a clip leave its cues in the sequence as orphans | `timeline-edges.test.ts` "lift / overwrite that removes a clip must not leave orphan cues" and "removeTrack drops the clips on it and their cues" | Cues of removed clips removed (as `removeClips` does) | 3 orphan cues per lifted clip; Subtitles panel offers "remove orphans" as a manual chore | `clearRange` (`shared/timeline.ts:187`) and `removeTrack` (`:682`) never touch `seq.subtitleTracks` | Collect removed clip ids in `clearRange`/`removeTrack` and filter cues (shared helper with `removeClips`). |
| QA-13 | **P2** | Proxies | A ready proxy whose file was deleted stays `ready`; with `useProxies` on, playback targets a 404 forever | `media-proxy-export.spec.ts` "deleting a ready proxy file externally…" | Element error → mark proxy `none`/`failed`, fall back to the original (which is browser-playable here), toast | `media.proxy.status === 'ready'` persists; `recut-media://` returns 404; no fallback | `src/playback/mediaSource.ts:21-24` trusts the flag; nothing stats proxy files on open or on element `error` | On project open run `stat` on proxy paths (like `verifyMediaOnline`); in the element pool's `error` handler, if the failing path is a proxy, `setProxy(id, {status:'none'})` and re-plan. |
| QA-14 | **P3** | Timeline | `moveClips` with several clips pushed before frame 0 clamps each clip to 0 independently → clips collide and one overwrites the other | `timeline-edges.test.ts` "moveClips with a multi-clip selection pushed past frame 0…" | Clamp the *delta* so the earliest clip lands at 0 (as `nudgeSelected` and the drag code do) | Second clip overwrites the first (1 clip left). Reachable through automation / paste paths, not the drag UI | `shared/timeline.ts:636` `Math.max(0, m.toStart)` per clip | Compute `shift = max(0, -min(toStart))` once and add it to every move. |
| QA-15 | **P3** | Timeline | Slipping a clip that is longer than its media (after relinking to a shorter file) moves the source **backwards** | `timeline-edges.test.ts` "slipping a clip that is longer than its media…" | `slip(+10)` is a no-op or moves later | `sourceIn` jumps from 5 s to 2 s | `shared/timeline.ts:579-580`: `handleAfter` is negative, `Math.min(handleAfter, d)` forces a negative delta | `const handleAfter = Math.max(0, maxDur - g.duration)`. |
| QA-16 | **P3** | Project load | Negative `speed` in a project file is not repaired (`||= 1` only catches 0/NaN); every handle computation then yields 0 and the clip cannot be trimmed/slipped | `timeline-edges.test.ts` "a negative speed loaded from a project file is repaired" | `speed > 0` after load | `speed: -1` kept | `shared/project.ts:114` | `if (!(c.speed > 0) || !Number.isFinite(c.speed)) c.speed = 1`. |
| QA-17 | **P3** | Transitions | Two transitions on a 12-frame clip may each be 12 frames (sum > clip length); export then silently drops the outgoing one | `timeline-edges.test.ts` "transitions on both ends of a short clip must not overlap" | `addTransition` limits the new transition to `clip.duration - otherTransition.duration` | 12 + 12 accepted; `renderGraph` warns "Transitions on both sides overlap; the outgoing transition is dropped" | `shared/timeline.ts:131-133` only considers clip durations | Subtract the existing transition on the other edge of each adjacent clip from `limit`; same in `setTransitionDuration`/`reconcileTransitions`. |
| QA-18 | **P3** | Project load | Transitions referencing clips that no longer exist are loaded as-is (until the next edit of that track reconciles them) | `project-io.test.ts` / `timeline-edges.test.ts` "…transition whose clips vanished…" | Dropped on load | Kept; `transitionSpan` returns null so it is invisible but still selectable by id / exported as a no-op | `shared/project.ts:108` | Call `reconcileTransitions(t)` for every track at the end of the per-sequence repair loop. |
| QA-19 | **P3** | Export | Main-process export accepts a `fileName` with path separators: `../escaped.mp4` writes outside the chosen folder | `export.test.ts` "file names are sanitized server-side too"; `media-proxy-export.spec.ts` "export with a path-traversal file name through IPC" | Basename only (dialog already sanitizes) | `exportOutputPath` → `path.join(outputDir, '../escaped.mp4')` | `electron/export/renderGraph.ts:488-492` | `name = path.basename(name)` + reuse `sanitizeFileName` in `shared/`. |
| QA-20 | **P3** | Export | No upper bound on dimensions in `main`: 16000×9000 is accepted via IPC (dialog caps at 8192) | `export.test.ts` "absurd dimensions (16000x9000)…" | Reject/clamp with a message (libx264 level limits, multi-GB frame buffers) | Graph built, ffmpeg launched | `renderGraph.ts:499-501` | Share `MIN_DIMENSION`/`MAX_DIMENSION` with `src/panels/export/settings.ts` and validate in `startExportJob`. Not run end-to-end here on purpose. |
| QA-21 | **P3** | Export | A sequence whose only clips are disabled exports a silent black video with no warning | `export.test.ts` "a sequence whose only clips are disabled must be refused or at least warned about" | Refuse ("nothing enabled to export") or warn | `inputCount: 0`, `warnings: []`, black render | `resolveRange` uses `sequenceDuration` which counts disabled clips (`renderGraph.ts:85-93`) | After planning, if no track produced a label → throw or push a warning; the dialog checklist should mirror it. |
| QA-22 | **P3** | Relink | Relinking to a shorter file (or wrong type) leaves clips that extend past the new media; no warning, playback freezes, export clones the last frame | `media-proxy-export.spec.ts` "relink to a shorter file…"; `export.test.ts` "a clip that extends past its (relinked, shorter) media…" | Toast "N clips exceed the new media duration" (+ offer to trim) and an export warning | Silence | `relinkWithPath` (`src/panels/project/actions.ts`) just re-probes; `collectTrackSegments` never compares `srcEnd` to `mediaDurationSec` | After re-probe, scan sequences for `clipSourceOut > duration` and toast; add a warning in `collectTrackSegments`. |
| QA-23 | **P3** | Subtitles | A cue whose text contains a blank line is exported as two blocks and comes back as a truncated cue plus a dropped block | `subtitles.test.ts` "a cue whose text contains a blank line survives export → re-import" | Text preserved (or blank lines collapsed on export) | `"para one"` only | `serializeSrt` (`shared/subtitles.ts:66`) writes raw text; parser splits on `\n\n+` (`:34`) | Collapse `\n{2,}` → `\n` in `serializeSrt`/`serializeVtt` (SRT cannot represent empty lines). |
| QA-24 | **P3** | Subtitles | Timestamps with 3-digit hours (`100:00:00,000`) are rejected; 25 h works | `subtitles.test.ts` "times beyond 24h and 3-digit hours" | Accept `\d+` hours | Cue dropped with "unparseable timing" | `shared/subtitles.ts:8` `(\d{1,2}):` | `(\d{1,3})`. |
| QA-25 | **P3** | Import | The same path twice in one import call creates two media items | `import.spec.ts` "the same path twice in one import call…" | One item | Two items with identical paths | `src/state/mediaActions.ts:19-21` de-dups only against existing media | De-dup `paths` with a `Set` first. |
| QA-33 | **P3** | Lifecycle | `recut --project <path>` while ReCut is already running does not open the project (and tries to open a bogus path) | `lifecycle-quit.spec.ts` "second instance launched with \"--project <path>\"…" (the bare-path variant passes) | Running instance opens `<path>` | Nothing opens; `projectPath` stays `null`. Captured `second-instance` argv: `[electron, --no-sandbox, --project, --allow-file-access-from-files, …, main.js, /tmp/…/second.recut]` — Chromium re-orders argv (switches first, positionals last), so `projectPathFromArgv` resolves `--allow-file-access-from-files` as the project path and never reaches the real `.recut` | `electron/main.ts:42-50` `projectPathFromArgv` + `second-instance` handler (`:278`) | Prefer the last positional `*.recut` argument; accept `--project=<path>` only; or use the `workingDirectory`/`additionalData` of `requestSingleInstanceLock(data)` to pass the path explicitly. |
| QA-26 | **P4** | Timeline | `updateMarker` accepts negative times (and `addMarker` clamps) | `timeline-edges.test.ts` "markers beyond the sequence end are allowed; negative times are clamped" | Clamp to 0 | `time: -40` stored | `src/state/store.ts:979-984` `Object.assign(m, patch)` | Clamp `time`/`duration` like `addMarker`. |
| QA-27 | **P4** | Story blocks | A story block fully inside a ripple-deleted range survives as a 1-frame block at the gap | `timeline-edges.test.ts` "story blocks shift with ripple delete…" | Block removed (or kept zero-length and flagged) | 1-frame zombie block | `shared/timeline.ts:176-182` `b.end = Math.max(b.start + 1, …)` | Drop blocks whose mapped `end <= start`. |
| QA-28 | **P4** | Project load | Duplicate ids in `sequenceOrder` are kept → sequence listed twice | `project-io.test.ts` "duplicate ids in sequenceOrder are de-duplicated" | De-dup | Listed twice | `shared/project.ts:119` | `[...new Set(order)]`. |
| QA-29 | **P4** | Project load | `view.zoom: 0`, `playhead: NaN`, negative scroll are loaded unchanged (zoom 0 → division by zero in timeline px math) | `project-io.test.ts` "view state with zoom 0 / NaN playhead is sanitized" | Sanitized to template defaults | Kept | `shared/project.ts:104` spreads `s.view` | Validate each field (`Number.isFinite`, `zoom > 0`, `>= 0`). |
| QA-30 | **P4** | Subtitles | A WebVTT file with only the header yields no cues *and no warning* (SRT header-only does warn) | `subtitles.test.ts` "an SRT with only an index / header yields no cues and a warning" | Warning in both cases | `warnings: []` for `WEBVTT\n` | `shared/subtitles.ts:59` only warns when `format === 'unknown'` | Warn whenever `cues.length === 0`. |
| QA-31 | **P4** | Lifecycle | Loading another project underneath an open modal (Export) leaves the modal open with stale settings | `lifecycle-quit.spec.ts` "opening a project while the Export dialog is open" | Dialogs closed on `loadProjectData`/`newProject` | `ui.dialogs.export` stays `true` | `resetSelectionUi` (`src/state/store.ts:58`) keeps `dialogs` | Reset `dialogs` in `resetSelectionUi`. |
| QA-32 | **P4** | Import | Importing a directory / a `.recut` / a `.srt` through the media path yields a generic probe error instead of a targeted message | `import.spec.ts` first test | "This is a folder / a project file — open it instead" | `probeError: "…Is a directory"` / ffprobe noise | `importMediaFiles` never `stat`s; `importPaths` routes `.srt` but not `.recut` | `stat` before probe; special-case `.recut` → offer to open. |

### Verified OK (no bug found)

- Undo torture: 3 × 500 random ops (insert/overwrite, razor, move, trim, ripple trim, ripple delete, delete, transitions,
  tags, markers, speed ±ripple, enable, link/unlink, add/remove track, slip, slide, nudge, lift/extract, story blocks,
  track flags, roll, cue split/offset, snapshots) → undo-all deep-equals the initial project, redo-all deep-equals the
  final one; no overlapping / negative / non-finite clips, no dangling or non-adjacent transitions after any seed.
- Undo across sequence switch keeps the active sequence; `setActiveSequence`/`select`/`setView` create no history;
  undo/redo refused while a transaction is open; `cancelTransaction` restores identity; load/new project clears history;
  background `setProxy`/`setOffline` no longer pollute history (fixed concurrently in the working tree).
- Razor at clip start/end is a no-op; ripple delete of the last clip; locked tracks block delete/ripple/move/insert
  (insert returns `[]` → caller toasts); trim past media end clamps; 4000-frame clip trims to exactly 1 frame; speed
  0/negative/NaN/∞ rejected, 10000 % and 1 % work; transitions longer than clips clamp; deleting a clip removes its
  transitions and prunes selection; link/unlink mixed selections; extract with in==out is a no-op, lift with in>out swaps;
  story blocks after a ripple delete shift sensibly (except QA-27); carried overlapping cues are kept; cues follow move /
  ripple / speed change; `splitCue` at its own start/end is a no-op.
- `normalizeProject`: formatVersion 99 refused with a clear message; null/garbage sequences and media dropped; missing
  media ids tolerated; 10 MB of notes round-trips in <1 s; save→load→save is byte-identical.
- I/O: save into an impossible path returns `{ok:false}`; `.bak` is written; a sibling autosave is not offered after a
  save; `.recut`-that-is-a-directory gives a readable error; a newer-but-corrupt autosave is ignored (silently — arguably
  should toast); `atomicWriteFile` leaves no temp files on failure.
- Subtitles: 100 000 cues parse in ~1.3 s, serialize + re-parse + resolve in bounded time; overlapping cues kept;
  negative times rejected with warnings; `end < start` clamped; BOM + CRLF + missing trailing newline; VTT with
  header metadata, STYLE/NOTE, cue ids, positioning, `<v>`/`<b>` and inline timestamps; SRT/VTT export→import equality
  to 1 ms incl. multi-line text; a text line that looks like a timing line is not mis-parsed.
- Export: empty sequence refused; in>out / in==out fall back to the whole sequence with a warning; deleting the output
  folder mid-export fails promptly (no hang, no `.part`); cancel leaves no output/`.part`; two exports are serialized
  and both finish; unicode/emoji/quote/bracket file names probe, stream, thumbnail and export fine; missing source →
  export job fails with ffmpeg's "No such file" (no hang) and `verifyMediaOnline` then flags it offline.
- Proxies: cancel then restart leaves no `.part`; image → job fails with "neither video nor audio", audio-only → ready;
  SIGKILL mid-proxy leaves only `.part`, relaunch shows `none`, retry succeeds and cleans the `.part`.
- Quit: "Don't Save" quits promptly; a second instance launched with a bare `.recut` path (OS double-click) forwards the project to the running instance and exits (the `--project <path>` form does not, QA-33).

### Not covered / notes

- Native quit dialog cannot be driven under xvfb; the P0 tests stub `dialog.showMessageBox` in the main process
  (`app.evaluate`) — equivalent to the user waiting / pressing Cancel.
- 16000×9000 export was not executed end-to-end (memory risk on the shared box); only the missing validation is asserted.
- `useProxies` toggled mid-playback, "export while playing", scrubbing with missing media, cancel at 99 % and
  image-sequence import were not automated (no bug seen by code reading for the first two; image sequences are simply
  imported as N stills — feature gap, not a defect).
- Read-only files/dirs: the container runs as root, so permission-based repros are not meaningful here; the save path
  was exercised with an impossible parent instead.

## Repro tests added

`tests/attack-qa/` (own configs: `vitest.config.ts`, `playwright.config.ts`; helpers in `helpers.ts`). Status as of the
last run; **FAIL = bug reproduced**.

| File | Test | Status | Finding |
|---|---|---|---|
| `export.test.ts` | an empty sequence is refused | pass |  |
| `export.test.ts` | a sequence whose only clips are disabled must be refused or at least warned about (not a silent black render) | FAIL | QA-21 |
| `export.test.ts` | in > out and in == out fall back to the entire sequence with a warning (never a 0-frame or negative export) | pass |  |
| `export.test.ts` | file names are sanitized server-side too: slashes must not escape the output folder | FAIL | QA-19 |
| `export.test.ts` | quotes / unicode / spaces in the file name are kept and resolvable | pass |  |
| `export.test.ts` | absurd dimensions (16000x9000) are not capped by the main-process graph builder | FAIL | QA-20 |
| `export.test.ts` | an export whose output path equals one of its own source files must be refused | FAIL | QA-03 |
| `export.test.ts` | DESTRUCTIVE: exporting onto a source file overwrites the original media | FAIL | QA-03 |
| `export.test.ts` | deleting the output folder mid-export fails the job promptly (no hang) and leaves no .part | pass |  |
| `export.test.ts` | cancel right after start leaves neither output nor .part behind | pass |  |
| `export.test.ts` | a clip that extends past its (relinked, shorter) media exports without failing but with a warning | FAIL | QA-22 |
| `export.test.ts` | sanity: sequenceDuration counts disabled clips (why disabled-only sequences export black) | pass |  |
| `project-io.test.ts` | formatVersion 99 is refused with a clear message | pass |  |
| `project-io.test.ts` | non-object / missing formatVersion / junk sequences are handled without throwing TypeErrors | pass |  |
| `project-io.test.ts` | clips with duration 0 / negative / NaN are dropped, but NaN or non-finite start must not survive either | FAIL | QA-08 |
| `project-io.test.ts` | a clip with NaN start poisons sequenceDuration and the export graph (downstream symptom) | FAIL | QA-08 |
| `project-io.test.ts` | sequences referencing missing media ids load; cues/transitions do not throw | pass |  |
| `project-io.test.ts` | a transition whose clips are missing from the file is dropped on load | FAIL | QA-18 |
| `project-io.test.ts` | circular bin parents are repaired so their contents stay visible in the Project panel | FAIL | QA-09 |
| `project-io.test.ts` | duplicate ids in sequenceOrder are de-duplicated | FAIL | QA-28 |
| `project-io.test.ts` | view state with zoom 0 / NaN playhead is sanitized | FAIL | QA-29 |
| `project-io.test.ts` | 10 MB of notes round-trips through serialize/normalize in reasonable time | pass |  |
| `project-io.test.ts` | save → load → save is byte-identical (round-trip stability) | pass |  |
| `project-io.test.ts` | saving to a path whose parent cannot be created fails gracefully (no throw, ok:false) | pass |  |
| `project-io.test.ts` | save over an existing file keeps a .bak and the sibling autosave is not offered for recovery afterwards | pass |  |
| `project-io.test.ts` | opening a corrupt .recut falls back to .bak — but must tell the caller it did (not a silent ok) | FAIL | QA-10 |
| `project-io.test.ts` | a project from a NEWER format must not be silently replaced by an older .bak | FAIL | QA-04 |
| `project-io.test.ts` | opening a .recut that is actually a directory gives a readable error | pass |  |
| `project-io.test.ts` | a newer-but-corrupt autosave is ignored by checkRecovery (silently) | pass |  |
| `project-io.test.ts` | atomicWriteFile leaves no temp files behind on failure | pass |  |
| `subtitles.test.ts` | parses 100k cues in bounded time and keeps them all, in order | pass |  |
| `subtitles.test.ts` | overlapping cues are all kept | pass |  |
| `subtitles.test.ts` | negative times and end<start do not crash; end<start is clamped and warned | pass |  |
| `subtitles.test.ts` | times beyond 24h and 3-digit hours are accepted (long concatenated sources) | FAIL | QA-24 |
| `subtitles.test.ts` | BOM + CRLF + missing final newline + stray blank lines | pass |  |
| `subtitles.test.ts` | WebVTT with header metadata, STYLE/NOTE blocks, cue ids, positioning and voice tags | pass |  |
| `subtitles.test.ts` | an SRT with only an index / header yields no cues and a warning, never a throw | FAIL | QA-30 |
| `subtitles.test.ts` | export → re-import equality for SRT and VTT (timing to 1 ms, text incl. multi-line) | pass |  |
| `subtitles.test.ts` | a cue whose text contains a blank line survives export → re-import | FAIL | QA-23 |
| `subtitles.test.ts` | a cue whose text line looks like a timing line is not mis-parsed | pass |  |
| `timeline-edges.test.ts` | razor exactly at a clip start / end is a no-op (no history entry, nothing created) | pass |  |
| `timeline-edges.test.ts` | razor keeps linked tails linked to each other, not to the heads | pass |  |
| `timeline-edges.test.ts` | ripple delete of the last clip just removes it | pass |  |
| `timeline-edges.test.ts` | ripple delete with a locked track leaves that track in place and still closes the gap elsewhere | pass |  |
| `timeline-edges.test.ts` | a clip on a locked track cannot be deleted / ripple-deleted / moved | pass |  |
| `timeline-edges.test.ts` | moving a clip onto a locked destination track is refused without side effects | pass |  |
| `timeline-edges.test.ts` | insert into an explicitly locked target track returns [] (caller toasts) and does not throw | pass |  |
| `timeline-edges.test.ts` | moveClips with a multi-clip selection pushed past frame 0 must keep relative spacing (no clip overwrites another) | FAIL | QA-14 |
| `timeline-edges.test.ts` | nudge clamps the whole selection so the earliest clip lands on 0 and nothing is lost | pass |  |
| `timeline-edges.test.ts` | nudge with nothing selected is a no-op without a history entry | pass |  |
| `timeline-edges.test.ts` | trim past media end clamps to the media duration | pass |  |
| `timeline-edges.test.ts` | a 4000-frame clip can be trimmed down to exactly 1 frame but never 0 | pass |  |
| `timeline-edges.test.ts` | slip clamps at both media bounds | pass |  |
| `timeline-edges.test.ts` | slipping a clip that is longer than its media (e.g. after relink to a shorter file) must not move it the wrong way | FAIL | QA-15 |
| `timeline-edges.test.ts` | speed 0 / negative / NaN / Infinity are rejected; 10000% works without NaN | pass |  |
| `timeline-edges.test.ts` | a negative speed loaded from a project file is repaired by normalizeProject | FAIL | QA-16 |
| `timeline-edges.test.ts` | a transition longer than its clips is clamped to the shorter clip | pass |  |
| `timeline-edges.test.ts` | transitions on both ends of a short clip must not overlap (in + out <= clip duration) | FAIL | QA-17 |
| `timeline-edges.test.ts` | deleting a clip removes the transitions attached to it and prunes the selection | pass |  |
| `timeline-edges.test.ts` | a transition whose clips vanished in the project file does not survive normalizeProject | FAIL | QA-18 |
| `timeline-edges.test.ts` | link on a mixed selection (already-linked pair + loose clip) joins all three; unlink splits | pass |  |
| `timeline-edges.test.ts` | toggle enabled on a selection flips each clip | pass |  |
| `timeline-edges.test.ts` | extract with in == out and lift with in > out (swapped by setView) behave | pass |  |
| `timeline-edges.test.ts` | markers beyond the sequence end are allowed; negative times are clamped (add and update) | FAIL | QA-26 |
| `timeline-edges.test.ts` | story blocks shift with ripple delete and a block fully inside the removed range disappears | FAIL | QA-27 |
| `timeline-edges.test.ts` | carrySubtitles copies overlapping cues (overlaps kept) anchored to the clip | pass |  |
| `timeline-edges.test.ts` | razor keeps cue positions; a cue spanning the cut must not lose its second half | FAIL | QA-11 |
| `timeline-edges.test.ts` | cues follow a moved clip, a ripple delete and a speed change | pass |  |
| `timeline-edges.test.ts` | splitCue at its own start / end is a no-op, in the middle splits text and timing | pass |  |
| `timeline-edges.test.ts` | lift / overwrite that removes a clip must not leave orphan cues behind in the sequence | FAIL | QA-12 |
| `timeline-edges.test.ts` | removeTrack drops the clips on it and their cues | FAIL | QA-12 |
| `undo-torture.test.ts` | seed 1: 500 random ops → undo all equals initial, redo all equals final | pass |  |
| `undo-torture.test.ts` | seed 2: 500 random ops → undo all equals initial, redo all equals final | pass |  |
| `undo-torture.test.ts` | seed 3: 500 random ops → undo all equals initial, redo all equals final | pass |  |
| `undo-torture.test.ts` | no NaN / negative / zero-duration clip or overlapping clips survive 500 random ops | pass |  |
| `undo-torture.test.ts` | undo across a sequence switch restores the edited sequence but keeps the active one | pass |  |
| `undo-torture.test.ts` | setActiveSequence, select and setView do not create history entries | pass |  |
| `undo-torture.test.ts` | undo/redo are refused while a transaction is open and work after it ends | pass |  |
| `undo-torture.test.ts` | loading a project / new project clears history and redo stack | pass |  |
| `undo-torture.test.ts` | cancelTransaction restores the pre-drag project and keeps history intact | pass |  |
| `undo-torture.test.ts` | a finishing proxy job (setProxy) must not wipe the redo stack of a user edit | pass |  |
| `undo-torture.test.ts` | importing 3 files should be one undo step, not 1 + one per probe | FAIL | QA-07 |
| `undo-torture.test.ts` | marking media offline on open (setOffline) must not dirty the project or create history | pass |  |
| `undo-torture.test.ts` | history limit: after >limit ops the import can no longer be undone (documented behaviour, limit 200) | pass |  |
| `lifecycle-quit.spec.ts` | P0: quit with a dirty project while the user has not answered the Save dialog yet must not kill the app after 3 s | FAIL | QA-01 |
| `lifecycle-quit.spec.ts` | P0: choosing Cancel in the quit prompt must keep the app open (no delayed force-quit) | FAIL | QA-02 |
| `lifecycle-quit.spec.ts` | control: "Don't Save" quits promptly | pass |  |
| `lifecycle-quit.spec.ts` | opening a project while the Export dialog is open: dialog state survives the load (no crash, but stale) | FAIL | QA-31 |
| `lifecycle-quit.spec.ts` | second instance launched with "--project <path>" forwards the project to the running instance | FAIL | QA-33 |
| `lifecycle-quit.spec.ts` | second instance launched with a bare .recut path (OS double-click) forwards the project | pass |  |
| `import.spec.ts` | 0-byte file, directory path, .recut file and a missing path all produce probe errors without crashing | FAIL | QA-05 (QA-32 noted) |
| `import.spec.ts` | unicode / emoji / spaces / quotes in a file name: probe, insert, thumbnail and export all work | pass |  |
| `import.spec.ts` | the same path twice in one import call must not create two media items | FAIL | QA-25 |
| `import.spec.ts` | a subtitle file / a subtitle-only container imported as media become kind "subtitle" and cannot be inserted | pass |  |
| `import.spec.ts` | an audio-only and an image file are classified and insertable | pass |  |
| `import.spec.ts` | 500 files at once: finishes (23.8 s, 0 probe failures), all probed, and is ONE undo step | FAIL | QA-07 |
| `media-proxy-export.spec.ts` | starting the same proxy twice must not run two ffmpeg jobs on the same .part file | FAIL | QA-06 |
| `media-proxy-export.spec.ts` | cancel a running proxy, then start it again: no .part left behind and the retry completes | pass |  |
| `media-proxy-export.spec.ts` | deleting a ready proxy file externally: the app must notice (fall back / mark not ready), not keep serving 404s | FAIL | QA-13 |
| `media-proxy-export.spec.ts` | proxy requests for an image and an audio-only file settle (fail with a reason / succeed) and never hang | pass |  |
| `media-proxy-export.spec.ts` | source file deleted while in the timeline: export via IPC fails with an error (no hang); checklist only blocks after verify | pass |  |
| `media-proxy-export.spec.ts` | relink to a shorter file: clips that now extend past the media must be flagged | FAIL | QA-22 |
| `media-proxy-export.spec.ts` | two exports started back to back both complete (serialized by the queue) | pass |  |
| `media-proxy-export.spec.ts` | cancel an export at ~1%: job canceled, no output and no .part | pass |  |
| `media-proxy-export.spec.ts` | export with a path-traversal file name through IPC lands outside the chosen folder | FAIL | QA-19 |
| `media-proxy-export.spec.ts` | kill the app mid-proxy: no finished proxy is left behind, relaunch shows status none, .part is cleaned on retry | pass |  |

Totals: 106 tests — 67 pass, 39 FAIL (each FAIL maps to a finding above). vitest: 56 pass / 28 fail; Playwright: 11 pass / 11 fail.

