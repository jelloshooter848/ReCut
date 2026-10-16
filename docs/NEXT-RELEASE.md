# Next release

Changes on `dev` (and on the personal branches heading there) that are not in a release yet. Every issue branch adds
its changelog line and its QA block here in the same change, appending to the end of each list so the two personal
branches rarely conflict. A line marked "(on devJames)" or "(on devDavid)" has not reached `dev` yet; the PR into `dev` removes the marks. Before a
release, QA runs the checklist on `dev`; the release PR turns the draft into the version's `CHANGELOG.md` section and
resets this file to its empty template ([RELEASING](RELEASING.md#how-to-cut-a-release)).

## Changelog draft

### Added

- Transcripts are word-timed and split into short lines; the Source and Program monitors highlight each word as it
  is spoken (karaoke style), and a short line stays on screen through a pause of up to a second
  ([#118](https://github.com/jelloshooter848/ReCut/issues/118), [#119](https://github.com/jelloshooter848/ReCut/issues/119);
  part of [#113](https://github.com/jelloshooter848/ReCut/issues/113)).
- A highlighter button on the timeline's subtitle lane header turns the word highlighting on and off; it is saved
  with the project ([#119](https://github.com/jelloshooter848/ReCut/issues/119)).
- Transcript lanes on the timeline: **T1** under A1, **T2** under A2, showing each clip's transcript live from its
  media, so a clip transcribed after it was inserted shows at once. The Program monitor shows the transcript of the
  clip on screen ([#125](https://github.com/jelloshooter848/ReCut/issues/125); part of
  [#112](https://github.com/jelloshooter848/ReCut/issues/112)).
- The timeline's Subtitles row shows the on-screen transcript, the same text the Program monitor shows
  ([#126](https://github.com/jelloshooter848/ReCut/issues/126)).
- Export › **Include transcripts as subtitles** adds the on-screen transcript as a subtitle track named "Transcript"
  (burn-in, sidecar .srt or MKV soft track) ([#127](https://github.com/jelloshooter848/ReCut/issues/127)).
- Export › **Highlight the spoken word** burns transcripts in karaoke style
  ([#134](https://github.com/jelloshooter848/ReCut/issues/134)).
- Transcript cues have their own colour (maroon) and transcript lanes can be collapsed with the chevron on their
  header ([#132](https://github.com/jelloshooter848/ReCut/issues/132)).
- Transcription Models: **Finish in background** while a model downloads; the Transcribe dialog shows the download's
  progress, and the "model installed" toast has a **Transcribe…** button that brings you back with your choices kept
  ([#110](https://github.com/jelloshooter848/ReCut/issues/110)).
- Transcribe dialog: **Transcribe again (ignore the saved result)** makes a new transcript instead of reusing the
  cached one ([#158](https://github.com/jelloshooter848/ReCut/issues/158)).
- Shots: with several shots selected, **Insert N Shots at Playhead**, **Make Scene from N Shots…** and **Merge N
  Shots**; **Insert All Shots at Playhead** on a video; dragging a selection of shots places all of them
  ([#143](https://github.com/jelloshooter848/ReCut/issues/143)).
- Shots and scenes are named from the first words spoken in them (Whisper transcript, else subtitles): automatically
  for new detections, and with **Name from Transcript** / **Name Shots from Transcript**
  ([#144](https://github.com/jelloshooter848/ReCut/issues/144)).
- Sequences: group scenes into ordered sequences (Scenes panel › **Make Sequence…**, **Add to Sequence**), with a
  **Sequences** tab; a sequence can be inserted, dragged to the timeline or turned into a new timeline
  ([#146](https://github.com/jelloshooter848/ReCut/issues/146)).
- **Suggest Scenes…** on a video with shots proposes scenes from speech, picture and sound at each cut, for review
  before they are created; it runs as a background job with progress in Jobs
  ([#147](https://github.com/jelloshooter848/ReCut/issues/147), [#151](https://github.com/jelloshooter848/ReCut/issues/151)).
- Scenes panel: **Merge N Scenes** joins selected scenes from one video into one
  ([#152](https://github.com/jelloshooter848/ReCut/issues/152)).
- Opening a shot or scene zooms the Source scrub bar to its In/Out; the **Scene** / **Full file** button (or **\\**)
  switches to the whole file and back ([#150](https://github.com/jelloshooter848/ReCut/issues/150)).
- HEVC media plays in the monitors without a proxy on machines that decode it (macOS, Windows with HEVC support)
  ([#138](https://github.com/jelloshooter848/ReCut/issues/138)).
- Subtitle position: move subtitles up or down the frame per timeline (Inspector › Subtitles › **Position**,
  **Top** / **Bottom**); the Program and Source monitors and burn-in export use it
  ([#115](https://github.com/jelloshooter848/ReCut/issues/115))
- Edit subtitle and transcript lines by hand: double-click a line on the timeline (or right-click › **Edit…**, or the
  pencil in the Subtitles panel) to change its text and timing, split, merge or delete it. Transcript edits change
  the media's transcript, so they show in every timeline and keep following the audio; word highlighting follows the
  edited text ([#135](https://github.com/jelloshooter848/ReCut/issues/135))
- A subtitle file can be a video's transcript (Media Inspector › **Transcript**, or right-click a transcript line ›
  **Transcript Source**): T lanes, the on-screen transcript, search and shot naming use it, with estimated word
  highlighting and a warning when it runs past the end of the video ([#162](https://github.com/jelloshooter848/ReCut/issues/162))
- Transcribe › **Keep other languages as spoken** (slower): for films that switch language, each stretch of about 10 s
  is transcribed in the language spoken in it instead of being translated into the chosen language
  ([#163](https://github.com/jelloshooter848/ReCut/issues/163))

### Changed

- **"Sequence" is now "Timeline" everywhere in the UI** (Timeline menu, New Timeline…, Timelines in the Project
  panel, Export's Entire timeline); new timelines are named Timeline 01, 02…; existing projects keep their names
  ([#145](https://github.com/jelloshooter848/ReCut/issues/145)).
- **Detected scenes are now called shots** (Detect Shots…, new detections named Shot 001…); "scene" means a Scene
  library scene ([#143](https://github.com/jelloshooter848/ReCut/issues/143)).
- **Shot detection uses an adaptive detector**, so camera motion and exposure changes no longer count as cuts; shot
  detections cached by earlier versions are made again when next run
  ([#149](https://github.com/jelloshooter848/ReCut/issues/149)).
- **Inserting a clip no longer copies its Whisper transcript into a timeline subtitle track**; opening a project
  removes the copies older versions made (imported and edited subtitles are kept)
  ([#125](https://github.com/jelloshooter848/ReCut/issues/125)).
- **Transcripts cached by earlier versions are not reused**: transcribing again makes a new one (word timing, the
  fixes below); transcript tracks already in a project stay as they are
  ([#118](https://github.com/jelloshooter848/ReCut/issues/118), [#158](https://github.com/jelloshooter848/ReCut/issues/158)).
- Transcribe dialog: a note under **Translate the speech to English** says a translated transcript is less exact
  ([#117](https://github.com/jelloshooter848/ReCut/issues/117)).
- **Thumbnails and filmstrips are made again once**, and videos with a start offset are probed again when a project
  opens ([#154](https://github.com/jelloshooter848/ReCut/issues/154), [#156](https://github.com/jelloshooter848/ReCut/issues/156))
- A subtitle cue added at the playhead over a clip now moves with that clip (**Unpin from Clip** keeps one in place);
  transcribing media again asks before replacing a transcript you edited ([#135](https://github.com/jelloshooter848/ReCut/issues/135))
- **Detect Shots asks in plain words**: Sensitivity (Fewer cuts / Normal / More cuts) instead of a threshold number, and a
  Shortest shot setting; the Media Inspector's Detect… opens the same dialog, and detecting again over shots you edited
  warns first ([#142](https://github.com/jelloshooter848/ReCut/issues/142))

### Fixed

- A blank untitled project was offered for recovery at the next start, and File › Open / New / Quit then asked to
  save it ([#111](https://github.com/jelloshooter848/ReCut/issues/111)).
- The Program monitor drew a long subtitle as one line running off both edges; it now wraps to the frame
  ([#114](https://github.com/jelloshooter848/ReCut/issues/114)).
- Whisper repeated a line echoed by the engine; a line said again later is kept
  ([#117](https://github.com/jelloshooter848/ReCut/issues/117)).
- Dropping a clip on V2 put its audio on A1 (overwriting what was there); the audio now goes to A2, adding the track
  if needed ([#120](https://github.com/jelloshooter848/ReCut/issues/120)).
- Every export to an exFAT drive failed at the end with "The render file … was replaced by another file"
  ([#133](https://github.com/jelloshooter848/ReCut/issues/133)).
- Proxies that finished after the last save showed "Needs proxy" again when the project was reopened
  ([#136](https://github.com/jelloshooter848/ReCut/issues/136)).
- Clicking the timeline while playing did not move the playhead; it now jumps there and keeps playing
  ([#139](https://github.com/jelloshooter848/ReCut/issues/139)).
- Scrolling the timeline while playing snapped back to the playhead; it now pauses following until the playhead is
  back in view or you click **Follow playhead** ([#140](https://github.com/jelloshooter848/ReCut/issues/140)).
- Suggest Scenes blocked the app with no progress while it analysed a long film
  ([#151](https://github.com/jelloshooter848/ReCut/issues/151)).
- Whisper transcripts looped on invented lines ("Thank you." hundreds of times) over music and silence
  ([#158](https://github.com/jelloshooter848/ReCut/issues/158)).
- Whisper wrote stock lines such as "Thank you." or "Thanks for watching!" over an opening logo or music; a spoken
  "Thank you." stays ([#160](https://github.com/jelloshooter848/ReCut/issues/160)).
- In a file whose audio starts before its video (some FFmpeg-made MKVs), the video was placed late, so an export from
  the first frame began black, and thumbnails were early ([#154](https://github.com/jelloshooter848/ReCut/issues/154))
- Thumbnails and filmstrips of MPEG-TS / MPEG-PS files with long keyframe intervals showed the next keyframe instead
  of the frame at that time ([#156](https://github.com/jelloshooter848/ReCut/issues/156))
- Whisper transcripts of an audio stream that starts after the file does were early by that delay
  ([#157](https://github.com/jelloshooter848/ReCut/issues/157))
- An opened shot or scene played on past its end into the rest of the file and zoomed out
  ([#164](https://github.com/jelloshooter848/ReCut/issues/164))
- The window's title bar, menus and system dialogs are dark to match the app, also when macOS (or Windows) is set
  to light mode ([#166](https://github.com/jelloshooter848/ReCut/issues/166))
- Editing the text of a word-timed subtitle showed the old words in the monitors, and merging subtitles kept only the
  first one's words ([#135](https://github.com/jelloshooter848/ReCut/issues/135))
- `Start ReCut.cmd` (Windows, from a clone) now sets up speech-to-text: it compiles the Whisper engine when cmake and
  Visual Studio C++ are installed, and otherwise says what to install. Run from source without the engine, the
  Whisper dialogs explain how to set it up instead of saying it is "not included in this build" (on devJames)
  ([#170](https://github.com/jelloshooter848/ReCut/issues/170))

### Known issues

- None yet.

### Development

- Bugs are tracked in GitHub Issues; the `bugs/` folder is removed (old reports are readable at commit `59eafc6`)
  ([#148](https://github.com/jelloshooter848/ReCut/issues/148)).
- The first `npm run dev` / `npm start` from a clone fetches FFmpeg and the speech-to-text engine (`npm run setup`,
  `RECUT_SKIP_SETUP=1` skips it).
- Cold filmstrips run as balanced FFmpeg batches in one round, further from the perf guardrail
  ([#155](https://github.com/jelloshooter848/ReCut/issues/155))
- `docs/NEXT-RELEASE.md` keeps this draft and QA checklist ([#167](https://github.com/jelloshooter848/ReCut/issues/167)).

## QA checklist

Test on a `dev` build (`npm run dev` on `dev`). Tick an item when it behaves as described. A block marked or
(on devDavid) needs that branch until it is merged into `dev`.

### #145 Sequence renamed Timeline

- [ ] The menu bar has a **Timeline** menu with **New Timeline…**, **Timeline Settings…**, **Duplicate Timeline…**
      and **Rename Timeline…**; no menu, tooltip or dialog calls the edit a "Sequence".
- [ ] In a new project, **New Timeline…** → the new one is named "Timeline 02".
- [ ] Open a project saved by 0.8.2 → its timelines keep their names and are listed under **Timelines** in the
      Project panel.

### #120 A drop on V2 puts the audio on A2

- [ ] On a timeline with a clip on A1, drag a video with sound from the Project panel onto V2 → picture on V2, sound
      on A2; the A1 clip is untouched.
- [ ] On a timeline with only V1 / A1, drop on V2 → V2 and A2 are added; one Undo removes the clip and the tracks.
- [ ] Drop a video on A2 → its picture goes to V2.

### #139 Clicking the timeline while playing

- [ ] Play the timeline and click the ruler well ahead of the playhead → the playhead jumps there and playback
      carries on from that point.

### #140 Scrolling the timeline while playing

- [ ] Zoom in so the playhead pages the view while playing. Play, then scroll the timeline away → the view stays
      where you scrolled.
- [ ] Click **Follow playhead** in the timeline toolbar → the view goes back to the playhead and follows it again.
- [ ] Stop, scroll away, press Play again → following resumes.

### #125 Transcript lanes (T1 under A1)

- [ ] Insert a clip whose media has a Whisper transcript → a **T1** lane under A1 shows its lines.
- [ ] Insert a clip first, then transcribe its media → the T lane fills in without inserting again.
- [ ] Put a clip without a transcript on V2 over a transcribed clip on V1 → the Program monitor keeps showing the
      V1 clip's words.
- [ ] Open a project from 0.8.2 whose timeline has a Whisper transcript copied into a subtitle track → that copy is
      gone and the T lane shows the same words; imported SRT tracks are still there.

### #126 The Subtitles row shows the on-screen transcript

- [ ] Cut between two transcribed clips on V1 → the **Subtitles** row at the top of the timeline shows each clip's
      lines and switches at the cut, matching the Program monitor.

### #132 Transcript colour and collapsible T lanes

- [ ] Transcript cues in T lanes and the Subtitles row are maroon; imported subtitles stay purple.
- [ ] Click the chevron on a T lane's header → it collapses to a thin row with a line where there is text; click
      again to expand. Restart → the lane is still collapsed.

### #114 Long subtitles wrap in the Program monitor

- [ ] Play a timeline with a long subtitle line (an imported SRT with a 20-word line) → the text wraps inside the
      frame instead of running off both edges.

### #118 Word-timed, short transcript lines

- [ ] Transcribe a clip with dialogue → the transcript is in short lines of a few words (about 1–4 s each), not
      long segments.

### #119 Highlighting the spoken word

- [ ] Play a transcribed clip in the Program monitor → the word being spoken is yellow, stepping word by word; a
      line stays up for up to a second when the speaker pauses.
- [ ] Load the same media in the Source monitor and play → the same highlighting.
- [ ] Click the highlighter button at the right end of the subtitle lane header → every word is white in both
      monitors. Save and reopen → still off.

### #150 The Source scrub bar zooms to an opened shot or scene

- [ ] Double-click a shot in the Project panel (or a scene in the Scenes panel) → the Source scrub bar spans only its
      In to Out; the timecodes are still source timecode.
- [ ] Click **Full file** (or press **\\** with the Source monitor active) → the whole file, playhead and In/Out kept;
      click **Scene** to zoom back.
- [ ] Step to another shot with ↓ → the bar shows the full file.
- [ ] Open a whole file → its full length, as before.

### #164 An opened shot or scene stops at its end

- [ ] Open a shot, press Play → it plays the shot and stops on its last frame, still zoomed.
- [ ] Press Play again → it starts over from the shot's In.
- [ ] With Loop on → it loops within the shot.
- [ ] Switch to **Full file**, press Play → playback runs on past the shot's end.

### #143 Shots

- [ ] Right-click a video › **Detect Shots…** → the results are listed as Shot 001, Shot 002… under the media.
- [ ] Select three shots › **Insert 3 Shots at Playhead** → placed back to back in order; one Undo removes all three.
- [ ] Select shots that follow each other › **Merge N Shots** → one shot. With a gap in the selection, the item is
      disabled and says why.
- [ ] **Make Scene from N Shots…** → one scene in the Scenes panel covering them.
- [ ] Right-click the video › **Insert All Shots at Playhead** → every shot in order. Drag a selection of shots to
      the timeline → all of them are placed.

### #149 Adaptive shot detection

- [ ] Detect shots on edited material with clear cuts (a trailer, or the test movies from
      `scripts/make-test-media.sh`) → the real cuts are found.
- [ ] Detect shots on a handheld or talking-head clip → far fewer shots than 0.8.2 gave; camera moves are not cuts.

### #144 Names from the transcript

- [ ] On a transcribed video, **Detect Shots…** with **Name shots from the transcript** on → shots with speech are
      named from their first words (no "um" / "uh", about 40 characters); silent shots stay Shot NNN.
- [ ] Right-click shots › **Name from Transcript**, and right-click the video › **Name Shots from Transcript** →
      names updated; one Undo restores them.
- [ ] Scenes panel: right-click scenes › **Name from Transcript** → named from the whole scene's range.

### #147 Suggest Scenes

- [ ] Right-click a video with shots › **Suggest Scenes…** → a review lists proposed scenes.
- [ ] Untick one, rename one, **Join next**, open one and **Split here**, move the slider → the list updates.
- [ ] **Create N Scenes** → only the ticked scenes are added to the Scenes panel; one Undo removes them.

### #151 Suggest Scenes as a background job

- [ ] On a long film, start **Suggest Scenes…** → progress shows in the dialog and in **Jobs** with time left; the
      app stays usable.
- [ ] **Run in Background** → the dialog closes and the review opens when the job finishes.
- [ ] Start it again and cancel it in Jobs → it stops.
- [ ] Choose Suggest Scenes… again with the shots unchanged → the review opens at once.

### #152 Merge scenes

- [ ] Scenes panel: select scenes from one video › right-click › **Merge N Scenes** → one scene from the first start
      to the last end, tags and characters combined, the highest rating kept; one Undo restores them.
- [ ] Select scenes from two videos → the item is disabled and says why.

### #146 Sequences of scenes

- [ ] Scenes panel: select scenes › **Make Sequence…**, name it → it is listed in the **Sequences** tab with its scene
      count and total length.
- [ ] Expand it: reorder and remove a scene, **Add Selected Scenes** → the list updates.
- [ ] **Insert at Playhead**, drag it to the timeline, and **New Timeline from Sequence** → the scenes are placed in
      order; each is one Undo step.
- [ ] Delete one of its scenes in the Scenes panel → it leaves the sequence. Save and reopen → the sequence is there.

### #110 Model downloads from the Transcribe dialog

- [ ] Open **Transcribe with Whisper…** › **Manage models…** and install a model → the button reads **Finish in
      background**; click it → both dialogs close.
- [ ] Reopen the Transcribe dialog during the download → it shows "Installing … N%" with a bar.
- [ ] When the download finishes, the toast stays up; click **Transcribe…** → the dialog reopens with the same media,
      stream and language, and the new model selected.

### #117 Translate note and echoed lines

- [ ] In the Transcribe dialog, a note under **Translate the speech to English** says the transcript is less exact
      when translating.
- [ ] Transcribe dialogue → no line appears twice in a row unless it was said twice.

### #158 No looping transcripts; Transcribe again

- [ ] Transcribe a film with long music or silence → no invented line repeated over and over. The dialog has no
      Verbatim checkbox.
- [ ] Transcribe the same media with the same settings → the cached result is used at once. Tick **Transcribe again
      (ignore the saved result)** → a new job runs and replaces it.

### #160 No stock "Thank you." over music

- [ ] Transcribe a film with a music-only opening (studio logo) → no "Thank you." or "Thanks for watching!" there.
- [ ] A clip where someone says "Thank you." keeps that line.

### #157 Transcripts of late-starting audio

- [ ] Use an MKV or TS whose audio starts after its video (`ffprobe -show_streams` gives the audio a later
      `start_time` than the video). Transcribe it → in the Source monitor, lines appear as the words are spoken, not
      early.

### #127 Transcripts in the export

- [ ] Export a timeline with transcribed clips, **Include transcripts as subtitles** on, with a sidecar .srt → a
      "Transcript" .srt matching the Subtitles row.
- [ ] MKV with soft subtitles → a "Transcript" subtitle track in the transcript's language.
- [ ] Off (the default) → no transcript in the export.

### #134 Highlighted words in burned-in subtitles

- [ ] Export with **Include transcripts as subtitles** and **Burn in**, **Highlight the spoken word** on → the spoken
      word is yellow in the exported video.
- [ ] The same with it off → plain white text.

### #133 Export to an exFAT drive

- [ ] Export to an exFAT-formatted USB stick or SSD → "Export complete", no "render file … was replaced by another
      file" error.

### #154 Audio that starts before the video

- [ ] Use an MKV whose audio starts before its video (for example made by FFmpeg 6.1 with AAC; `ffprobe
      -show_format` gives a negative `start_time`). Insert it from its first frame and export → the export starts
      with picture, not black frames.
- [ ] Its thumbnails show the same frame as the Source monitor at that time.

### #138 HEVC without a proxy

- [ ] On macOS, import an HEVC .mp4 / .mov → no "Needs proxy"; it plays in the Source monitor without a proxy.
- [ ] On a machine without HEVC decoding (Linux) → a proxy is made as before.

### #136 Proxies after reopening a project

- [ ] Import a file that needs a proxy, save, let the proxy finish, then close and reopen the project → the proxy is
      ready (a toast says how many were restored), not "Needs proxy".

### #156 Thumbnails of TS files

- [ ] Import a TS recording (TV or camcorder) → each filmstrip thumbnail shows the frame at its time (compare with
      the Source monitor at the same timecode), not a frame up to a few seconds later.
- [ ] MP4 / MOV / MKV thumbnails look as before.

### #111 Blank untitled project

- [ ] Start ReCut, change nothing (or add an empty bin), quit → no "Save changes?" prompt.
- [ ] Start again → no "Recover unsaved changes?".
- [ ] Import a media and quit without saving → the "Save changes?" prompt appears as before.

### #115 Subtitle position

- [ ] With nothing selected, the Inspector shows the timeline; its **Subtitles** section says Position "Bottom (default)".
- [ ] Click **Top** → subtitles move to the top of the frame in the Program monitor (and the Source monitor, for a clip with subtitles); the label reads "7 % from the top". Undo puts them back.
- [ ] Drag the Position slider to the middle → the subtitles follow when you release it.
- [ ] Export with **Burn in** subtitles at Top → the burned-in text is at the top of the frame, where the Program monitor showed it. Try once with **Highlight the spoken word** on too.
- [ ] Save, close and reopen the project → the position is kept. **Bottom** returns to the default.

### #166 Dark title bar

- [ ] On macOS, set System Settings › Appearance to **Light**, then start ReCut → the window's title bar is dark like the rest of the app.
- [ ] Open a menu and **File › Open Project…** → the menus and the file dialog are dark too.
- [ ] Switch macOS back to **Dark** → nothing changes in ReCut.

### #135 Editing subtitle and transcript lines

- [ ] Transcribe a clip, insert it, and double-click a line in its **T** lane → the editor opens and says the edit changes the media's transcript. Fix a word, Save → the T lane, the Subtitles row and both monitors show the fix; with word highlighting on, the right word lights up.
- [ ] Change the line's **End** in the editor → it ends there on the timeline; it can't run past the clip's end.
- [ ] Move or trim the audio clip (and unlink it from its video) → the edited line goes with the audio.
- [ ] Use the same part of the media in a second timeline → the fix is there too.
- [ ] Right-click a line › **Split at Playhead**, then **Edit…** › **Merge with next**, then **Delete Line**; Undo after each one restores it.
- [ ] Transcribe the same media again → a prompt asks before replacing your edits.
- [ ] On a subtitle track, add a cue at the playhead over a clip (Subtitles panel › **Add cue at playhead**), then move the clip → the cue moves with it. Right-click the cue › **Unpin from Clip**, move the clip again → the cue stays put.
- [ ] In the Subtitles panel, the pencil on a cue opens the same editor; typing new Start/End times moves the cue.

### #142 Detect Shots settings

- [ ] Right-click a video › **Detect Shots…** → Sensitivity shows **Normal** and Shortest shot **1 second**; no threshold number.
- [ ] Detect with **Fewer cuts**, then again with **More cuts** → fewer shots, then more.
- [ ] Set Shortest shot to **3 seconds** → no shot is shorter than 3 s (except possibly the last).
- [ ] Rename a shot, then open Detect Shots again → a warning says your edits will be replaced, and the button reads **Detect and Replace**.
- [ ] Select the video, Media Inspector › **Detect…** → the same dialog opens.
- [ ] Preferences › Shot detection shows the same choices; a project from 0.8.2 with a custom threshold shows **Custom (0.40)**.

### #162 A subtitle file as the transcript

- [ ] Import a video with a matching .srt next to it (and transcribe it with Whisper too). Insert it; the T lane shows the Whisper lines.
- [ ] Select the video, Media Inspector › Subtitle tracks › **Transcript** › pick the SRT → the T lane, the Subtitles row and the Program and Source monitors show the SRT's lines (no `<i>` tags); with highlighting on, words light up (estimated).
- [ ] Right-click a transcript line › **Transcript Source** › **Whisper (automatic)** → back to Whisper.
- [ ] Choose an SRT made for another version that runs past the end of the video → the Inspector warns about it.
- [ ] With the SRT chosen, double-click a line and fix it → the fix is saved in the SRT track (it shows after reopening the project).

### #163 Mixed-language audio

- [ ] Transcribe a film that switches language (e.g. *The Bourne Identity*) with the language set to English and **Keep other languages as spoken** off → German / Italian lines come out in English (translated).
- [ ] Transcribe again with the option on (and **Transcribe again** ticked) → the German police scene (about 10:50) and the Italian fishermen (about 1:55) are in German / Italian; the English stays English. It takes noticeably longer (about 4×).
- [ ] With an English-only model, or with **Translate** on, the option is disabled and says why.

### #170 Speech-to-text from Start ReCut.cmd (on devJames)

- [ ] On Windows without cmake or Visual Studio C++, run `Start ReCut.cmd` from a clone with no `resources\whisper` → the console says speech-to-text is not set up and what to install; ReCut still starts. Open **Transcribe with Whisper** → the message says how to set the engine up (not "not included in this build").
- [ ] Install cmake and Visual Studio with "Desktop development with C++", run `Start ReCut.cmd` again → it compiles the engine (a few minutes), then ReCut starts and **Transcribe** works.
- [ ] Run `Start ReCut.cmd` once more → no engine step; it just launches.
- [ ] The installed app (Setup or Portable exe) still transcribes as before.
