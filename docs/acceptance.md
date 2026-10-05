# ReCut — acceptance gauntlet

Four end-to-end scenarios from the product brief, run against the real built app (Electron under xvfb, real ffmpeg),
with synthetic media from `scripts/make-test-media.sh <dir> short` (Galaxy Saga 1 = 4 s scenes red, orange, yellow,
green, cyan, blue).

```
npm run build
xvfb-run -a npx playwright test -c tests/e2e/playwright.config.ts tests/e2e/gauntlet.spec.ts
```

- Spec: `tests/e2e/gauntlet.spec.ts`; plumbing: `tests/e2e/gauntlet-helpers.ts`.
- Each TEST is a `test.describe.serial` with its own Electron instance and tmp dir, `test.setTimeout(600_000)`.
- Every step is recorded as **UI** (real mouse/keyboard on the panels), **API** (`window.__recut` store/actions or
  `window.recut` bridge), or **UI+API** (the action is UI, setup such as zoom or playhead placement goes through the store).
  The API is used only where a native dialog would be needed (file/folder/save pickers) or for deterministic setup.
  Native dialogs that a UI button opens (the Relink folder picker, the quit message box) are stubbed in the main process
  with `electronApp.evaluate`, so the button itself is still clicked.
- A failing step is logged, and the test keeps going. When the failure would block later steps, a **WORKAROUND** through
  the store API runs and is marked as one. Step logs are written to `test-results/gauntlet/*.json` and echoed to stdout. Playwright clears `test-results/` at the start of each run.
- Each step has a 240 s watchdog. This keeps a hung app from consuming the whole test budget.

## Results after the fix waves (current)

All four acceptance tests pass on the current code, with no workarounds taken. The full e2e suite
(`xvfb-run -a npx playwright test -c tests/e2e/playwright.config.ts`, 51 tests including this gauntlet) passes.

| Test | Verdict | Steps passed |
|------|---------|--------------|
| TEST 1 — Basic Movie Edit | **PASS** | 17 / 17 |
| TEST 2 — TV Fan Edit | **PASS** | 21 / 21 |
| TEST 3 — Large-Media Workflow | **PASS** | 22 / 22 |
| TEST 4 — Failure Recovery | **PASS** | 11 / 11 (the `/proc` export is now refused with "Cannot create output folder", no fallback) |

BUG-1 to BUG-6 below are fixed: safe folder creation in `electron/safeMkdir.ts` (BUG-1), Transcript insert through
the shared three-point/conform edit path (BUG-2), title-like video names routed to Movies plus a ≥ 40 min post-probe
reclassification (BUG-3), Program chips counting distinct files (BUG-4), backup-open warning on every open path (BUG-5),
and Program redraw when a proxy becomes ready (BUG-6). NOTE-1 is kept by design: with proxies off, media Chromium cannot
decode still previews from its proxy rather than showing black (see docs/LIMITATIONS.md).

## Results of the first run (before the fix waves, kept for history)

| Test | Verdict | Steps passed | Failed checks |
|------|---------|--------------|---------------|
| TEST 1 — Basic Movie Edit | **FAIL** (core flow passes) | 16 / 17 | BUG-3 (movie not routed to the Movies bin) |
| TEST 2 — TV Fan Edit | **FAIL** (core flow passes) | 20 / 21 | BUG-2 (Transcript insert skips the conform prompt) |
| TEST 3 — Large-Media Workflow | **FAIL** (core flow passes) | 21 / 22 | BUG-6 (paused Program frame stays black after a proxy becomes ready) |
| TEST 4 — Failure Recovery | **FAIL** | 12 / 13 (+1 workaround) | BUG-1 (P1: export to `/proc/...` freezes the app) |

TEST 1, 2 and 4 come from the final full run. TEST 3 was re-run on its own after a test-ordering fix: the Program
chip reflects the clips under the playhead, and the spec had moved the playhead away before clicking the chip's
"Generate proxies". Every failure listed was reproduced in at least two runs. Each run took about 6–8 minutes per
test while other agents were running Playwright at the same time.

Each test's verdict is FAIL when any step failed, including a step that only checks a single P3/P4 finding. Every
core flow in the brief completes end to end. The only exception is the P1 export hang in TEST 4, which is worked around.
Unit tests (`npm test`) currently have 2 failures in files other agents are editing; they are not caused by this work,
which touches only the e2e spec and helpers. `npm run typecheck` passes.

---

## TEST 1 — Basic Movie Edit

| # | Step | Mode | Result |
|---|------|------|--------|
| 1 | New project (`file.new` command) | UI+API | PASS |
| 2 | Import Galaxy Saga 1 (`actions.importMediaFiles`; picker is native). Probed, 24 s, browser-playable, imported item selected | API | PASS |
| 3 | Import routes the movie into the **Movies** bin | API | **FAIL** (BUG-3) |
| 4 | Double-click the row in the Project panel. Source loads it (`ui.sourceClip`, `<video>` ready, name label) | UI | PASS |
| 5 | Space plays and Space pauses on the focused Source panel (currentTime advances, then holds) | UI | PASS |
| 6 | Click the Source scrub bar at 25 / 50 / 75 %. `<video>.currentTime` and `ui.sourceClip.time` follow (±0.4 s) | UI | PASS |
| 7 | 3× I / O / `,` on the focused Source panel (seek via `setSourceTime`). The first insert shows `conform-dialog`; clicking `conform-change` gives a 640×360 @ 24 sequence. The result is 3 V + 3 linked A clips, contiguous. After each edit the playhead is at the edit's end and sequence In/Out are cleared | UI+API | PASS |
| 8 | Mouse-drag the last clip's right edge −40 px (2 px/frame). Clip and linked audio are both 20 frames shorter | UI+API | PASS |
| 9 | Click the middle clip, then Shift+Delete. Ripple delete closes the gap on V and A | UI | PASS |
| 10 | Right-click at the audio cut and choose "Add Audio Crossfade". `audioTracks[0].transitions.length === 1` (fallbacks: Ctrl+Shift+D, then the store) | UI | PASS |
| 11 | `actions.saveProject(path)` (save dialog is native) | API | PASS |
| 12 | `app.close()` and relaunch with `--project <path>`. Clips, links and the transition are identical; no recovery prompt | UI+API | PASS |
| 13 | Ctrl+M opens the Export dialog. Type the dir and name, preset "720p Preview" (summary 1280×720), Export, wait for done | UI | PASS |
| 14 | ffprobe duration equals sequence duration (3.250 s) ±0.05 s; 1280×720 | API | PASS |
| 15 | Frame colour at each remaining clip's midpoint matches the source frame and the expected scene (red, yellow) | API | PASS |

## TEST 2 — TV Fan Edit

| # | Step | Mode | Result |
|---|------|------|--------|
| 1 | Import Station Eleven S01E01–E03. All three are selected afterwards | API | PASS |
| 2 | Episodes auto-organise into **TV › Station Eleven › Season 1** with episode numbers 1–3. The Project panel shows both bins | UI+API | PASS |
| 3 | `actions.importSubtitleFile` for each episode's SRT from `subs/` (not sidecars). Tracks are created with no warnings | API | PASS |
| 4 | Transcript panel: type "doctor". 4 results in 3 media, with the expected texts | UI | PASS |
| 5 | Click result 1. `ui.sourceClip` = E01, In/Out = 5 / 7.5 s, `<video>.currentTime` ≈ 5 s | UI | PASS |
| 6 | The result's "Insert at playhead" button inserts E01 and carries the cue | UI | PASS |
| 7 | That Transcript insert into the empty 1080p/23.976 sequence should offer the conform prompt | UI | **FAIL** (BUG-2) |
| 8 | Click the E02 result, then `,` on the focused Source panel. E02 is inserted after E01 (three-point) | UI | PASS |
| 9 | "Insert at playhead" on the E03 result. Order is E01, E02, E03 with cues attached (one sequence subtitle track per episode) | UI | PASS |
| 10 | Timeline right-click, "Tag…" dialog, add Kirsten + Jeevan, Apply. Clip characters and project vocabulary are updated | UI+API | PASS |
| 11 | Select clip 3, then the Inspector TagInput, add Miranda | UI | PASS |
| 12 | Select E02, then Shift+Delete. Gap closed; E02's cue dropped; E01/E03 cues kept | UI | PASS |
| 13 | Mouse-drag E01 behind E03. Order becomes [E03, E01]; linked audio follows | UI | PASS |
| 14 | `actions.saveProject` | API | PASS |
| 15 | Close and relaunch with `--project`. Timeline, tags, cues and series identity survive | UI+API | PASS |
| 16 | Ctrl+M opens the Export dialog. Turn on "Export .srt next to the video", Export. Job done; `sidecarPath` = `<name>.srt` | UI | PASS |
| 17 | ffprobe duration equals sequence ±0.05 s. The SRT has both kept lines and not the deleted E02 line | API | PASS |

## TEST 3 — Large-Media Workflow

| # | Step | Mode | Result |
|---|------|------|--------|
| 1 | With proxies on, import Galaxy Saga 1 (H.264), 2 (AC-3), 0 (HEVC), 3 (5.1). All probe; 5.1 has 6 ch; AC-3 and HEVC are not browser-playable | API | PASS |
| 2 | Auto-proxies: Jobs › Proxies rows for AC-3 and HEVC reach `ready` with nothing clicked. Decodable files get no proxy | UI | PASS |
| 3 | Double-click HEVC. The Source shows the **Proxy** badge, plays (currentTime advances), no error card | UI | PASS |
| 4 | One range from each file via double-click, I/O, `,`. The conform prompt is answered with **Enter** (= Change → 640×360 @ 24). 4 V + 4 A clips in order | UI+API | PASS |
| 5 | Proxies on: Program renders non-black frames on all 4 clips; Proxy chip on HEVC; no offline/needs-proxy/can't-play chips | UI+API | PASS |
| 6 | Proxies OFF (Proxies-tab switch): H.264 renders from the original, no Proxy chip | UI+API | PASS |
| 7 | Proxies OFF with the HEVC proxy still ready (observation): the app falls back to the proxy (Proxy chip, renders) rather than reporting needs-proxy. See NOTE-1 | UI+API | PASS (observation) |
| 8 | Proxies OFF with the HEVC proxy deleted (row button): `program-needs-proxy` is shown ("Needs proxy: 2", see BUG-4); H.264 still renders. Back on HEVC, the chip's **Generate proxies** brings the proxy back to ready and HEVC renders again (after a 1-frame nudge, see 8b) | UI+API | PASS |
| 8b | Paused-frame refresh: with proxies off, delete the HEVC proxy again, then regenerate from the Proxies row *without moving the playhead*. Expected: the Program frame refreshes by itself once the proxy is ready. It stays black until the playhead moves 1 frame | UI+API | **FAIL** (BUG-6) |
| 9 | Re-enable proxies (switch) | UI | PASS |
| 10 | `actions.saveProject` | API | PASS |
| 11 | Close, rename `movies/` to `movies-moved/`, relaunch with `--project`. 4 media offline, Relink dialog lists 4, offline toast and banner, `program-offline` chip | UI+API | PASS |
| 12 | `window.recut.scanForRelink` on the moved folder: 4 candidates, all `name+size` | API | PASS |
| 13 | Relink dialog: "Search folder…" (only the OS folder picker is stubbed), "Found 4 matches", "Apply 4 matches", "Check files", "All media online", Close. Media online at the new paths and Program renders | UI | PASS |
| 14 | Export dialog: Audio = 5.1 Surround, Export. 6-channel output; duration equals the sequence ±0.1 s | UI | PASS |
| 15 | "Export another", Audio = Stereo, Export. 2 channels; duration equals the sequence ±0.1 s | UI | PASS |

## TEST 4 — Failure Recovery

| # | Step | Mode | Result |
|---|------|------|--------|
| 1 | Import `invalid.mp4`. `probeError` set, "Error" badge on the row, project search still filters, Source shows the "Cannot read file" card, no renderer errors | UI+API | PASS |
| 2 | `importSubtitleFile(subs/broken.srt)` returns no track, a warning ("No subtitle cues recognised…"), 0 cues, no crash | API | PASS |
| 3 | Turn proxies off (switch) so import does not auto-start. Import HEVC; Proxies row Generate, then Cancel while running. Job `canceled`, proxy status `none`, no `*.part-<job>` files in the cache, Generate offered again | UI | PASS |
| 4 | Export to `/proc/recut-nope`: expected a start error with the app continuing. **The whole app freezes** | UI+API | **FAIL** (BUG-1) |
| 4w | WORKAROUND: SIGKILL the app and relaunch. If crash recovery offers the untitled autosave, choose Discard. Re-seed, then export to `<regular file>/out`: "Cannot create output folder: ENOTDIR…" is shown and the app continues | API/UI | PASS |
| 5 | `openProject(garbage.recut)` returns `ok:false` "Could not open project…"; the current project (id, clips, path) is untouched | API | PASS |
| 6 | `openProject` on a truncated `keep.recut` that has a `.bak` loads the backup silently (observation, see BUG-5) | API | PASS (observation) |
| 7 | Quit. Write a truncated *untitled* autosave (newest) plus a valid newer `keep.recut.autosave`, then relaunch. The corrupt autosave is ignored, the valid one is offered (`recovery-dialog`), Recover loads it and leaves it dirty, no renderer errors | UI+API | PASS |
| 8 | Quit prompt: with a dirty project, call `window.recut.quit(false)` with `dialog.showMessageBox` stubbed to answer Cancel. The prompt "Save changes to … before quitting?" is asked, the app stays open for more than 5 s, it stays dirty and responsive, and a second quit request is handled again | UI+API | PASS |

---

## Bug list

### BUG-1 (P1): Exporting to a folder under `/proc` freezes the whole app permanently
- **Repro:** put any clip in a sequence, press Ctrl+M, set the output folder to `/proc/recut-nope`, then click Export.
- **Expected:** "Cannot create output folder: …" in the dialog (`export-start-error`), and the app carries on.
- **Actual:** the main process blocks forever. The window stops responding (even CDP and `electronApp.evaluate` hang), so
  the app has to be killed. Unsaved work survives only through the autosave.
- **Cause:** `electron/export/exporter.ts:111` calls `fs.mkdirSync(req.settings.outputDir, { recursive: true })` on the
  main thread. Node's recursive mkdir loops forever when the kernel returns ENOENT for a child of an existing
  pseudo-filesystem directory. This reproduces in plain Node 22: `fs.mkdirSync('/proc/x', {recursive:true})` never
  returns, and `fs.promises.mkdir` never settles. Non-recursive `mkdirSync` returns ENOENT immediately.
  `electron/ipc.ts:157` (`resolveCacheDir`, `fsp.mkdir(dir, {recursive:true})` on the user-configurable cache dir) has the same exposure: the promise never settles, so it would hang a libuv thread and any startup step awaiting it.
- **Suggested fix:** create missing ancestors one level at a time with non-recursive `mkdir` and stop on the first error,
  or check that the nearest existing ancestor is a writable directory (`fs.accessSync(W_OK)`) before creating anything.
  Never do blocking filesystem work on user-supplied paths on the main thread.

### BUG-2 (P3): Transcript "Insert at playhead" skips the conform prompt
- **Repro:** start a new project (default sequence 1920×1080 @ 23.976). Import 640×360 @ 24 episodes, import their
  SRTs, search the Transcript, and click "Insert at playhead" on a result.
- **Expected:** the same "Change sequence to match clip?" prompt (`conform-dialog`) that Source `,`/`.` and timeline
  drops show on the first insert into an empty sequence.
- **Actual:** no prompt. The sequence stays 1920×1080 @ 23.976, so every later Source insert also skips the prompt because
  the sequence is no longer empty.
- **Cause:** `src/panels/transcript/shared.ts` `insertAtPlayhead()` calls `store.insertFromSource` directly instead of
  `performSourceEdit` / `maybeConformSequence` (`src/panels/source/insert.ts`).

### BUG-3 (P3): Movie files without a year are not routed to the Movies bin
- **Repro:** import `movies/Galaxy Saga 1 - A New Dawn.mp4`.
- **Expected:** auto-routing to Movies (per the brief, "import auto-routes files into Movies / TV › Series › Season bins").
- **Actual:** `binId: null`, `category: 'Other'`, `identity: {}`. The item lands at the project root.
- **Cause:** `src/state/parseIdentity.ts` `importIdentity()` only classifies a file as a Movie when the name has a
  year (`info.year !== undefined && info.title`). A "Title N - Subtitle" pattern, or a file sitting in a `movies/`
  folder, is not used.

### BUG-6 (P3): Paused Program frame is not redrawn when the clip's playable source changes
- **Repro:** turn proxies off. Delete the HEVC clip's proxy (Jobs › Proxies › trash) and park the playhead on that clip:
  the Program is black with "Needs proxy". Click Generate in the Proxies row and do not touch the timeline.
- **Expected:** once the proxy is `ready` (the chip disappears), the paused frame redraws from the proxy.
- **Actual:** the chip disappears but the canvas stays black (average brightness 0 for more than 15 s). Moving the
  playhead by one frame draws it immediately. Reproduced in 3 runs.
- **Likely cause:** `ProgramPanel` calls `player.setSequence(...)` and `renderFrame(playhead)` when `project.media`
  changes, but the newly resolved proxy `<video>` is not decoded yet at that moment. Nothing triggers another draw when it
  becomes ready (`loadeddata` / `seeked`) while paused.

### BUG-4 (P4): Program "Needs proxy" / "Offline" chips count clips, not files
- **Repro:** turn proxies off, delete the HEVC proxy, and put the playhead on the HEVC clip (video + linked audio).
- **Expected:** "Needs proxy: 1", since the tooltip says "These files can't be decoded".
- **Actual:** "Needs proxy: 2". After the media folder is moved, "Offline: 2" appears with 4 offline files. The count is
  per clip at the current frame (`classifyMissing` counts `MissingMedia` entries, which are per clip).
- **Also:** the brief names the third chip `program-cant-play`, but the actual test id is `program-missing`, labelled
  "Can't play: N". The spec uses `program-missing`.

### BUG-5 (P4): Opening a corrupt project silently loads the `.bak`
- **Repro:** save a project twice (this creates `.bak`), truncate the `.recut`, then `openProject` it.
- **Actual:** opens `ok:true` with the backup's content, and no toast says the backup was used and the newest edits
  are lost. The user should be told.

### Notes (not bugs)
- **NOTE-1:** the brief expects that turning proxies off gets the HEVC clip "reported via `program-needs-proxy`". The
  app falls back to a ready proxy for originals Chromium cannot decode, even with proxies off (`resolvePlaybackPath`,
  shown with the Proxy chip). The needs-proxy chip appears only once no proxy exists (step 8). This looks
  deliberate. Product should confirm.
- Transcript and Source inserts from three episodes create one sequence subtitle track per source track (3 tracks).
  The `.srt` sidecar merges them correctly.
- The export checklist shows the info line "Export always uses original media, not proxies." when proxies are on,
  instead of "Ready to export". This is fine; the spec checks for no error items instead.

### Test-side issues found and fixed (not product bugs)
- `TagInput` drops its placeholder once it holds a value, so the spec locates the input by its form row.
- Strict-mode collisions: the Relink dialog has two "Close" buttons (title-bar icon and footer), and the 5.1 option text also
  appears in the preset select.
- Tests should account for the proxy auto-start on import when proxies are on (TEST 4 turns them off first).
