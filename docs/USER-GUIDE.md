# User guide: a fan edit from start to finish

This guide uses a typical project as its example: cutting a TV season (or a film trilogy) down to one character's
story. Menu and button names are the ones in the app. Shortcuts are the defaults (see [SHORTCUTS](SHORTCUTS.md)).
On macOS, read Ctrl as Cmd.

To practise without real media, run `scripts/make-test-media.sh ~/recut-test` and use the "Galaxy Saga" movies and
the "Station Eleven" episodes it creates.

## The screen

The **Editing** workspace (Alt+Shift+1) has these zones:

- **Project** at top left, with tabs for Transcript, Scenes, Continuity, Subtitles, Markers, History and Jobs below it.
- **Source** and **Program** monitors in the centre.
- **Timeline** and **Storyline** at the bottom.
- **Inspector** and **Compare** on the right.

The other workspaces rearrange the same panels:

- **Research** (Alt+Shift+2) puts Transcript and Scenes first.
- **Audio** (Alt+Shift+3) makes the timeline taller.
- **Compare** (Alt+Shift+4) puts the Compare player next to Program.

Any panel can be dragged to another zone, maximized with Ctrl+` (or a double-click on its tab), or restored with
Alt+Shift+0.

## 1. Import a movie or a season

1. **File › Import Media…** (Ctrl+I), or **Import…** in the Project panel. You can also drag files from your file
   manager onto the Project panel.
2. ReCut probes each file and sorts it by file name:
   - `Show S01E03…`, `Show 1x03…` and `Show Season 1 Episode 3…` go into **TV › Show › Season 1**, with series,
     season and episode filled in.
   - `Title (1999)`, `Title 2 - Subtitle`, files in a `movies/` folder, and long videos (40 min or more) go into
     **Movies**.
   - Audio goes into **Audio** and images into **Graphics**.
3. Subtitle files next to a video (`Episode.srt`, `Episode.en.srt`, `.vtt`) are attached automatically.
4. Files Chromium cannot decode (HEVC, AC-3/DTS audio, TS, ...) get a **proxy** automatically while **Use proxies** is
   on. Watch progress in the top-bar jobs indicator or in **Jobs › Proxies**.

## 2. Organise

- **Series** tab of the Project panel: media grouped by series and season. **Bins** tab: the folder tree. Right-click
  › **New Bin**, and drag items between bins.
- Fix or add identity: select the episodes, right-click › **Organize as Series…** to check and edit the
  season/episode table, then **Organize**. For films, right-click › **Set Collection / Franchise…** (e.g. Franchise
  "Galaxy Saga", Collection "Original Trilogy"). The Media Inspector › **Identity** section edits one item.
- Right-click › **Set Category**, **Rename** (F2), or **Tag…**. Use the colour labels in the Inspector.
- The **Inspector** shows media info (codecs, fps, audio streams, VFR), the **Audio stream** to use for new clips,
  proxy and scene status, and attached subtitle tracks.

## 3. Detect scenes

1. Right-click a video › **Detect Scenes…**. Set the **Threshold** (higher means fewer, stronger cuts) and click
   **Detect**. The Media Inspector › **Detect** button and Jobs › Proxies › detect-all do the same.
2. Detected scenes appear under the media row in the Project panel. Right-click a scene to **Load in Source**,
   **Insert at Playhead**, **Rename**, **Merge with Next**, **Split at Source Time…**, **Tag…**, **Add to Library**
   or **Delete Scene**.
3. In the Source monitor, **↑ / ↓** jump between scene boundaries.

## 4. Import subtitles

Skip this step for anything that already has sidecar subtitles.

- Select the media, then **File › Import Subtitles…**, right-click › **Import Subtitles…**, or **Transcript ›
  Import › Import subtitles… (.srt / .vtt)**.
- Embedded text subtitles: right-click › **Embedded Subtitles › #n …**, or **Transcript › Import › Embedded…**.
- Malformed lines are reported as warnings. A file with no cues is rejected with a message.

## 5. Search dialogue across the franchise

1. Open the **Transcript** panel (Shift+6) › **Search**. Type a phrase, e.g. `doctor`.
2. Pick a scope: **Entire project**, **Series: …**, **Season: …**, **Franchise: …**, **Collection: …**,
   **Source: …** or **Sequence: …**. Turn on **Regular expression** or **Whole word** if you need them.
3. Use ↑/↓ to choose a result. **Enter** (or a click) loads it in the Source monitor with In/Out set to that line.
   **Ctrl+Enter** inserts it at the playhead. You can also drag a result onto the timeline.
4. With a **Sequence** scope, results show which lines are already in the cut. Click the badge to jump there.
5. The **Transcript** tab shows the full transcript of one source. Select a span, then **Mark In/Out** or **Insert**.

## 6. Build the scene library

Scenes in the library are reusable, tagged source ranges.

- From the Source monitor: mark I/O, then **Make Subclip → Library**.
- From detected scenes: the Scenes panel's **Import as records** banner, or right-click a scene › **Add to Library**.
- From the timeline: right-click a clip › **Add to Scene Library**.
- In the **Scenes** panel (Shift+7), you can also use **From Source In/Out** or **From clip**. Edit name, characters,
  location, arc, tags, rating, colour and notes. Filter, sort (Name, Rating, Created, Duration, Source), group
  (Character, Location, Arc, Movie / episode) and switch between grid and list views. Double-click or Enter loads a
  scene in Source. Drag it to the timeline to use it.

## 7. Assemble with three-point edits

1. Double-click a media row (or press Enter) to load it in the **Source** monitor. Play with Space or J/K/L, step
   with ←/→, and mark **I** / **O**.
2. Place the playhead in the Timeline, or set sequence In/Out.
3. Press **,** (Insert, which pushes later clips right) or **.** (Overwrite).
   - The edit goes to the **sequence In** if it is set, otherwise to the playhead.
   - With sequence In + Out and only a source In, the sequence range sets the duration.
   - With only a sequence Out, the edit is back-timed to end there.
   - With all four points set, the source range wins at the sequence In.
4. The first clip into an empty sequence asks **Change sequence to match clip?** Choosing **Change** adopts the
   clip's frame size and rate. Do this before you build: the frame rate is fixed once a sequence has clips.
5. The source-patch buttons (**V1**, **A1**, ...) in the track headers choose the target tracks. Un-patch video for an audio-only edit
   (and the reverse).
6. Other ways to add clips: drag from Project, Source (the grip button), Scenes or Transcript. You can also use
   **Insert at Playhead** / **Overwrite at Playhead** in the Project context menu.
7. **Match Frame** (F) opens the source of the clip under the playhead. Double-clicking a timeline clip opens it in
   Source with its range marked.

## 8. Trim

- Drag clip edges with the **Selection** tool (V) to trim. Linked audio follows, and Alt+click selects one side only.
- **Ripple Edit** (B) moves later clips. **Rolling Edit** (N) moves a cut. **Slip** (Y) changes the source range
  under a clip. **Slide** (U) moves a clip between its neighbours. **Razor** (C) cuts (Shift cuts all tracks).
  **Track Select** (A) selects everything after a point. **Hand** (H) pans.
- **Q** / **W** ripple-trim the previous or next edit to the playhead. **Ctrl+K** adds an edit at the playhead.
- **;** Lift and **'** Extract remove the In→Out range. **Shift+Delete** ripple-deletes the selection.
- Nudge with **Alt+←/→** (add Shift for 5 frames). Hold Ctrl while dragging for an insert-move. Snapping (S) catches
  edges, markers and the playhead. Hold Alt to bypass it.
- A **sync badge** on a clip means it has drifted from its linked partner by N frames.
- **Speed / Duration…** (Ctrl+R) or the Inspector's Speed field changes speed. Turn on **Ripple following clips** to
  move later clips.

## 9. Transitions

- **Ctrl+D** adds a Cross Dissolve and **Ctrl+Shift+D** an Audio Crossfade, at the selected cut or the nearest edit
  point. The length comes from **Preferences › Default transition** (24 frames).
- Or right-click a cut › **Add Transition › Cross Dissolve / Dip to Black / Audio Crossfade**.
- Transitions are centred on the cut and use media beyond the clip edges (handles). If there is not enough media,
  the transition is shortened. Drag a transition's edge to change its length, or edit it in the Inspector.

## 10. Tags and what-if experiments

1. Tag clips: right-click › **Tag…**, or Inspector › **Story tags** (Characters, Plotlines, Locations, Tags). Tags
   propagate to linked audio, and character chips show on the clips.
2. Open **Storyline** (next to Timeline). In **SHOW ONLY**, tick characters or plotlines:
   - **Highlight** dims clips that do not match.
   - **Solo** shows only matching clips.
3. **What if**:
   - **Disable matching** previews the cut without a character.
   - **Disable clips NOT matching** previews a character-only cut.
   - **Enable all** restores.
   - **Runtime if removed** shows an estimate.

   Each is one undo step. Disabled clips export as black or silence until you remove them.
4. **Story blocks:** drag on the Storyline strip, or use **Block from In/Out** / **Block from Selection**, to label
   acts and arcs. Right-click a block to rename it, set In/Out to it or change its colour. The block table lists
   them with durations and notes.

## 11. Alternate cuts and comparing them

1. Before a risky change, create a new version with **Duplicate sequence** (Inspector › Sequence) or Compare ›
   **Duplicate A as new cut…** (add a version label like `v2`). For a restorable checkpoint inside the same
   sequence, use **Take snapshot…**.
2. Switch to the **Compare** workspace (Alt+Shift+4). Choose **Sequence A** and **Sequence B** (a snapshot can be B).
   **Sync** locks both players to one clock, **Offset** shifts B, and **Swap A and B** swaps them. The view mode is
   side by side, A only or B only, and pressing Alt alone toggles A/B.
3. The **Structure** list shows every clip as **same**, **moved** (with the frame delta), **trimmed** (head/tail
   deltas), **only in A** or **only in B**. Click an entry to jump there.
4. To restore a snapshot, use the restore button next to it (Compare › Alternate cuts, or Inspector › Sequence).

## 12. Continuity notes

- **Continuity** panel › **Add note at playhead**, or right-click the timeline › **Add Continuity Note Here…**. Give
  it an issue name, a category (wardrobe, prop, dialogue, music, lighting, source, other) and a note. Tick **Link to
  selected clip** to pin it to the clip so it moves with it.
- Space marks a note resolved or open. The scope can be **All sequences**. **Copy as text** copies open issues with
  timecodes for a review document.
- Where an edit came from: the Inspector's **Original source timecode** block (at the playhead or at the clip start;
  click to copy). Click the Program timecode to switch between **SEQ** and **SRC** (source file and timecode).
  Preferences › **Show source timecode on clips** prints source ranges on the clips.

## 13. Subtitles in the cut

- With **Carry subtitles into sequence** on (default), inserted clips bring their cues with them. The cues stay
  attached through moves, trims, ripples, razors and speed changes.
- The **Subtitles** panel (Shift+8) has per-sequence tracks: **Add track**, **Add cue at playhead**, inline text and
  timing edits, **Split at playhead**, **Merge with next**, ±1-frame nudges (Shift for ±10), and **Clean up** for cues
  whose clips were removed. **Export › Export SRT… / Export VTT…** exports a track. **Import to track…** brings in an
  external file.
- The Program monitor's **Subtitles** option toggles on-screen display.

## 14. Proxies and relinking

- Proxies are controlled with **Use proxies** (Project toolbar, Jobs › Proxies, Preferences). **Jobs › Proxies**
  lists every file with Generate / Cancel / Regenerate / Delete / Reveal and a **Size** (540p / 720p / 1080p) for new
  proxies. The Program monitor shows a **Proxy** chip when it plays one. Its **Needs proxy: N › Generate proxies**
  chip fixes undecodable clips under the playhead.
- Proxies affect only the preview. Export always reads the originals.
- **Moved your media?** Open the project, and offline files are listed with a banner. Click **Relink…** › **Search
  folder…** (matches by name + size) › **Apply N matches**, or **Locate…** per file. **Check files** re-verifies.
  ReCut warns if a relinked file is shorter than the clips that use it.

## 15. Export

1. **File › Export…** (Ctrl+M).
2. Pick a **Preset**: 1080p High Quality, 1080p Smaller File, 4K High Quality, 720p Preview, 1080p 5.1 Surround, or
   Match Sequence.
3. Set the **File name** and **Folder** (Browse…). Optionally adjust Video (frame size, frame rate, H.264/H.265,
   CRF or bitrate, encoder preset), Audio (AAC/AC-3, Stereo or **5.1 Surround** when a source has 6+ channels) and
   **Range** (Entire sequence or In to Out).
4. **Subtitles:** **Burn in** renders them into the picture. **Sidecar** writes a `.srt` next to the MP4.
5. The **Checks** list blocks the export with a reason when something is wrong (an empty sequence, offline or missing
   media, an invalid file name, folder or size). **Show FFmpeg command** previews the exact command.
6. Click **Export**. Progress shows in the dialog and in Jobs. When it finishes, use **Reveal in Folder** or
   **Export another**.

The MP4 has exactly the frame count of the exported range, and each frame is the one the Program monitor showed.

## Saving

- **Ctrl+S** saves a `.recut` project. It is JSON that references your media by path and never copies it.
- Autosave runs in the background. After a crash, ReCut offers **Recover** on the next launch.
- **Quit** (Ctrl+Q) asks to save unsaved changes.
