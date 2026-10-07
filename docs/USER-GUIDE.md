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

Timecodes read `HH:MM:SS:FF`. At 29.97 and 59.94 fps every timecode in the app (monitors, ruler, panels, dialogs,
source timecode) is SMPTE drop-frame, written `HH:MM:SS;FF`: frame 1800 at 29.97 is `00:01:00;02`. Click a timecode
field to type a value; see [SHORTCUTS](SHORTCUTS.md#timecode-entry) for what it accepts.

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
   on. Watch progress in the top-bar jobs indicator or in **Jobs › Proxies**. Still images in PNG, JPEG, WebP, GIF and
   BMP are drawn directly. Other stills (TIFF, TGA, EXR, PSD, JPEG XL, AVIF, HEIC, ...) get a PNG preview made by
   FFmpeg on import, even with **Use proxies** off; until it is ready the monitors show that the image needs a preview
   proxy. Which formats work depends on your FFmpeg (HEIC needs FFmpeg 7.1 or later; see
   [LIMITATIONS](LIMITATIONS.md#preview-chromium-and-proxies)).
5. If a yellow banner says **FFmpeg was not found**, install FFmpeg (see [INSTALL](INSTALL.md)) and restart ReCut.
   Import, proxies and export do not work without it.

## 2. Organise

- **Series** tab of the Project panel: media grouped by series and season. **Bins** tab: the folder tree. Right-click
  › **New Bin**, and drag items between bins.
- Fix or add identity: select the episodes, right-click › **Organize as Series…** to check and edit the
  season/episode table, then **Organize**. For films, right-click › **Set Collection / Franchise…** (e.g. Franchise
  "Galaxy Saga", Collection "Original Trilogy"). The Media Inspector › **Identity** section edits one item.
- Right-click › **Set Category**, **Rename** (F2), or **Tag…**. Use the colour labels in the Inspector.
- The **Inspector** shows media info (codecs, fps, audio streams, VFR), the **Audio stream** for new clips and the
  Source monitor, proxy and scene status, and attached subtitle tracks.
- **Several audio streams** (e.g. an English and a Japanese track): select a clip and pick its stream in Clip
  Inspector › Audio › **Stream**. **Media default** follows the media's **Audio stream**. The Program monitor plays,
  the timeline waveform shows, and the export renders the clip's stream. A proxy carries every stream, so switching
  needs no new proxy; a proxy made by ReCut before 0.4 carries one stream and is rebuilt (with proxies on) when a clip
  needs another.

### Surround audio: channels per clip and the centre channel

When a clip's stream has two or more channels (stereo, 5.1, 7.1, ...), Clip Inspector › Audio › **Channels** chooses
what the clip plays of it:

- **Normal mix** (the default): the stream as FFmpeg mixes it to the sequence, as before.
- **One channel only**, as mono: for example **Centre (FC)**, **Front left (FL)**, **LFE (subwoofer)**, **Side left
  (SL)**. Channels are named from the stream's real layout; a stream whose layout is unknown lists **Channel 1, 2,
  ...** instead. In a stereo export the channel sits in the middle at −3 dB on each side (the level the centre has in
  the standard downmix); in a 5.1 export it plays from the centre speaker at full level.
- **Stereo downmix (set levels)**: a controlled downmix instead of FFmpeg's default. **Centre** and **Surround** set
  the levels in dB (defaults −3 dB and −3 dB, as in ITU-R BS.775); the LFE channel is left out. Offered for streams
  with more than two channels in a known layout.

**Extract Centre Channel (Dialogue)** (right-click a clip in the timeline, or **Clip › Extract Centre Channel
(Dialogue)**) adds the centre channel of a 5.1 (or 7.1, ...) source as its own audio clip: same source range and
timeline position, linked to the clip's group, named "*clip name* (centre)", on the first free audio track below
(or a new track at the bottom). It is one undo step. The item is disabled, with the reason, when the clip's stream has
no centre channel (stereo or mono sources).

The centre channel is where films put most of the dialogue, but it is **not** a dialogue stem: it still carries
music and effects that were mixed to the centre. It is useful to raise or lower the dialogue against the rest, or to
cut it separately; it does not isolate the voices (see [LIMITATIONS](LIMITATIONS.md)).

The preview plays a channel selection from a small audio file made from the original with the same filter as the
export (most surround codecs, such as AC-3 and DTS, cannot be decoded by the preview at all). It is made
automatically, whatever **Use proxies** says, usually in seconds to a minute; until it is ready the clip is silent in
the Program monitor and the **Needs proxy** chip says "preview audio … in progress". The Inspector's **Preview** row
shows its state, with **Rebuild** if it failed.

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

### Reading image subtitles (OCR)

Blu-ray and DVD rips usually carry subtitles as pictures (PGS, VobSub, DVB, XSUB), which cannot be imported as text.
ReCut reads them with its built-in OCR engine (Tesseract) and adds the result as an ordinary subtitle track.

1. Select the media. Open **Transcript › Import › Embedded…** (or right-click › **Embedded Subtitles**): picture
   streams are listed as "#3 eng (PGS) — **Read with OCR…**". **Transcript › Import › Transcribe… › Read bitmap
   subtitles (OCR)…** opens the first one.
2. The dialog shows the stream and a **Language** choice. ReCut picks the stream's language when it is installed,
   otherwise the language you used last. If the stream's language is not installed yet, click **Install English
   (4.1 MB)** (or the language shown); **Manage languages…** opens the full list. Each language is downloaded once,
   only when you click Install; after that OCR works offline. **File › OCR Languages…** also manages them, including
   **Install from file…** for computers without internet access.
3. Click **Start**. The work runs in the **Jobs** list (cancel it there). A film takes from a few seconds to about a
   minute, depending on the number of lines and the computer.
4. When it finishes, a toast says how many lines were read, and the media gets a track named "English (OCR #3)".
   It shows in the Media Inspector and in Transcript search like any other track.

Reading the same stream again replaces that track (undo restores the previous one) and is instant: results are
cached. OCR is not perfect: italics, coloured text, signs drawn into the picture and unusual fonts can come out
wrong, so check the lines you rely on. Teletext and ARIB captions are not supported.

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
- A ripple (ripple trim, ripple delete, Extract) never pushes clips before frame 0: a track whose clips
  would land there is left as it is. A dragged edge stops at the end of the clip's media and never moves against
  the drag (a clip that already runs past its media end cannot grow, and is not pulled back either).
- **;** Lift and **'** Extract remove the In→Out range. **Shift+Delete** ripple-deletes the selection.
- Nudge with **Alt+←/→** (add Shift for 5 frames). Hold Ctrl while dragging for an insert-move. Snapping (S) catches
  edges, markers and the playhead. Hold Alt to bypass it.
- A **sync badge** on a clip means it has drifted from its linked partner by N frames.
- **Speed / Duration…** (Ctrl+R) or the Inspector's Speed field changes speed (both accept 1 %–10 000 %). Turn on
  **Ripple following clips** to move later clips.

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
   - **Remove disabled** (also **Sequence › Remove Disabled Clips…** and the clip right-click menu) ripple-deletes
     every disabled clip and closes the gaps, after asking with the count. One undo step. Clips on locked tracks are
     left alone.
   - **Duplicate as cut** (**Sequence › Duplicate as Cut Without Disabled Clips…**) keeps the experiment and makes a
     new version of the sequence with the disabled clips removed and the gaps closed.
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
- SRT/VTT export refuses a file the project reads from (media, proxies, imported subtitle files, including files
  imported to a track or read by the Transcript) and writes through a temp file, so a failed export never leaves a
  truncated file.
- The Program monitor's **Subtitles** option toggles on-screen display.

## 14. Proxies and relinking

- Proxies are controlled with **Use proxies** (Project toolbar, Jobs › Proxies, Preferences). **Jobs › Proxies**
  lists every file with Generate / Cancel / Regenerate / Delete / Reveal and a **Size** (540p / 720p / 1080p) for new
  proxies. The Program monitor shows a **Proxy** chip when it plays one. Its **Needs proxy: N › Generate proxies**
  chip fixes undecodable clips under the playhead.
- Proxies affect only the preview. Export always reads the originals.
- **Moved your media?** Open the project, and offline files are listed with a banner. Click **Relink…** › **Search
  folder…** (matches by name + size) › **Apply N matches**, or **Locate…** per file. **Check files** re-verifies.
- If a relinked file is shorter than before, clips that now run past its end are trimmed to it and clips that start
  after its end are removed, in every sequence (one undo step, with a warning that gives the counts).
- Thumbnails, waveforms, proxies, detected scenes and OCR results follow the file, not its folder: they are cached by
  the file's content (its size and a sample of its bytes), so a moved, renamed or copied file reuses them after Relink
  instead of building them again.

### Collect Project

**File › Collect Project…** copies the project and the media it uses into one new folder, to archive a finished edit,
move it to another drive or hand it to someone else.

1. **Choose…** a destination folder. ReCut creates a folder named after the project inside it; that folder must not
   exist yet, or be empty.
2. Pick **Media used in sequences only** (every file a clip or a sequence snapshot uses) or **All project media**.
   Turn on **Include subtitle files** to copy the subtitle files the project imported, and **Include proxies** to copy
   ready proxies so the copy previews without rebuilding them on another computer.
3. Check the summary: the folder it creates, the total size and the free space on the destination. Media that are
   offline are listed and skipped. **Collect** stays disabled when the folder is not empty or the space is short.
4. **Collect** runs as a job: the dialog (and **Jobs**) shows the bytes copied, and **Cancel collect** stops it.
   Close the dialog with **Hide** to keep working while it copies.

The result looks like this:

```
Saga Fan Cut/
  Saga Fan Cut.recut
  Media/        title_t00.mkv, Disc 1/title_t01.mkv, Disc 2/title_t01.mkv, …
  Subtitles/    the subtitle files (option)
  Proxies/      the proxies (option)
```

- Each file keeps its own name. Files with the same name from different folders go into subfolders named after the
  folders that tell them apart (`Disc 1/title_t01.mkv`, `Disc 2/title_t01.mkv`), so nothing is overwritten.
- Every copy is checked against its original (size and a fingerprint of its start, middle and end) before the
  project file is written. The collected project's paths point at the copies; media that were not copied keep their
  original paths. Paths stay absolute, so after moving the collected folder itself use **Relink › Search folder…**.
- Your open project and the original files are not changed. **Open collected project** (when it finishes) opens
  the copy.
- If the collect fails (a full disk, an unreadable file) or you cancel it, the folder keeps what was copied, has no
  project file, and holds `COLLECT-INCOMPLETE.txt` saying why. Delete the folder and collect again.
- The copied media keep their thumbnails, waveforms and proxies on this computer: the cache recognises them.

## 15. Export

1. **File › Export…** (Ctrl+M).
2. Pick a **Preset**: 1080p High Quality, 1080p Smaller File, 4K High Quality, 720p Preview, 1080p 5.1 Surround,
   ProRes 422 HQ (MOV), DNxHR HQ (MOV), WAV 24-bit (audio only), WAV per audio track, or Match Sequence.
3. Choose the **Format** (see **Formats** below; MP4 unless you change it), then set the **File name** and **Folder**
   (Browse…). The file name's extension follows the format. The folder must be a full path (`/home/me/Videos`,
   `C:\Videos`). Optionally adjust Video (frame size, frame rate, and the codec settings of the format), Audio
   (codec or bit depth, Stereo or **5.1 Surround** when a source has 6+ channels, sample rate; AC-3 offers 32, 44.1
   and 48 kHz only) and **Range** (Entire sequence or In to Out).
4. **Subtitles:** **Burn in** renders them into the picture, on exactly the frames where the Program monitor shows
   them. **Sidecar** writes a `.srt` next to the exported file. Burn-in is off for the audio-only formats (there is
   no picture); the sidecar still works. An **MKV** can also carry the subtitle tracks as soft subtitles that viewers
   switch on and off (see **Subtitle tracks (MKV)** below).
5. The **Checks** list blocks the export with a reason when something is wrong (an empty sequence, offline or missing
   media, an invalid file name, folder or size). It also warns, without blocking, about what would only show when
   the result is watched (see **Pre-export warnings** below). **Show FFmpeg command** previews the exact command.
6. Click **Export**. If the file (or its `.srt`) already exists, ReCut asks **Replace it?** first. Progress shows in
   the dialog and in Jobs. When it finishes, use **Reveal in Folder** or **Export another**.

**Formats.**

- **MP4** (the default): H.264 or H.265 with AAC or AC-3, for watching and sharing. Settings saved by an earlier
  version open as MP4.
- **MKV**: the same H.264 or H.265 picture, packaged the way fan edits are usually released: more than one audio
  track (for example 5.1 plus a stereo downmix, or a commentary), soft subtitle tracks and chapters, each track with
  its language and title. Audio tracks can be AAC, AC-3, FLAC or PCM. Without any change to **Tracks**, an MKV has
  the one mixed audio track an MP4 has.
- **MOV**: an intermediate for grading or finishing in another editor. **Codec** is Apple ProRes or Avid DNxHR, and
  **Profile** picks the quality: ProRes 422 Proxy, 422 LT, 422, 422 HQ or 4444; DNxHR LB, SQ, HQ, HQX (10-bit) or
  444 (10-bit). Every frame is a key frame, so the file is large but quick to edit: about 160 GB for two hours of
  1080p in ProRes 422 HQ. Audio is uncompressed PCM, 24-bit or 16-bit. DNxHR needs a frame of at least 256×120.
- **WAV** or **FLAC**: sound only, uncompressed (WAV) or lossless (FLAC), 24-bit or 16-bit, at the sample rate you
  choose. **Files** is **One mixed file** (the soundtrack, as in a video export) or **One per track**.

**One file per audio track** writes a file for each audio track the mix plays, for a mixer or a sound editor:
`<name> - A1 Dialogue.wav`, `<name> - A2 Music.wav`, and so on (`<name> - A3.wav` when a track keeps its default
name). The dialog lists the files before you export. Every file covers the whole range, so they are all the same
length and line up sample for sample when placed at the same start. Each file has the track as the mix has it: clip
gain, level and fades, and the track's volume. Mute and solo decide which tracks get a file: a muted track gets
none, and when a track is soloed only the soloed tracks get one. A track with no enabled clip in the range gets none
either; the Checks list says which tracks are left out and why. There is no master level to apply (the Program
monitor's volume only changes what you hear), so the files add up to the mixed export.

**Audio tracks (MKV).** With Format **MKV**, the Audio section lists the file's audio tracks. Each one is a mix of
the sequence audio tracks ticked under **Sources** (**All tracks** is the whole mix, as in an MP4), in its own
**Format**: Stereo, 5.1 or Mono, and AAC, AC-3 (Dolby Digital), FLAC or PCM, with a bitrate for AAC and AC-3. Give it
a **title** (shown by players, for example "Commentary") and a **language** as a three-letter ISO 639-2 code (`eng`,
`fre`, `ger`, `spa`, `jpn`, ...; empty is "undetermined"). The first track is the **Default** one players start
with; use the arrows to reorder, **Add track** for another one and the bin to remove one. **Tracks** has three
presets:

- **Main mix only**: one track of everything, with the codec and channels of the MP4 settings (the default).
- **5.1 + stereo downmix**: the whole mix as AC-3 5.1 (640 kbps) and as AAC stereo (256 kbps).
- **Main + commentary (last audio track)**: the last audio track with clips (A3 in a three-track sequence with a
  commentary on A3) alone as a stereo "Commentary" track, and every other track as the "Main" track.

Every audio track has exactly the length of the range and lines up sample for sample with the others (AAC and AC-3
round the end up to a whole codec frame, as in any file). Mute and solo still apply: a muted track is in no audio
track, and when a track is soloed only the soloed tracks are mixed. The 5.1 tracks place stereo sources in front
left and right; a stereo or mono track of a 5.1 source is FFmpeg's standard downmix. The sample rate is the same
for every track.

**Subtitle tracks (MKV).** With Format **MKV** and subtitle tracks in the sequence, the Subtitles section lists them:
tick a track to put it in the file as a soft subtitle stream (SubRip text), with its **title** (the track's name
unless you change it) and **language** (from the track unless you set one). **Default** asks players to show it
from the start (only one track should be Default); **Forced** marks a track for lines in another language that are
shown even when subtitles are off. A hidden track can be included too. The cue times are the ones the sidecar uses,
measured from the start of the range; a track with no cue in the range is left out. Burn-in and the sidecar still
work alongside.

**Checks for the formats.** The Checks list also says when a MOV export will be very large (over 100 GB, for example
two hours of ProRes 4444), when a WAV will pass 4 GB (it is then written as RF64, which some older programs cannot
open), and when an audio-only export has no enabled audio clip in the range (the export is blocked). Frame-rate, VFR
and sync warnings are about the picture, so they are left out for the audio-only formats. For an MKV it blocks an
audio track with no source track ticked, a language that is not a three-letter code and an AC-3 bitrate FFmpeg
cannot encode (above 640 kbps, or below 64 kbps in 5.1), and warns about an audio track that will be silent (its
sources are muted, not soloed or have no clips in the range), subtitle tracks that are gone or have no cues in the
range, and more than one Default subtitle track. AC-3 in any track limits the sample rate to 32, 44.1 or 48 kHz.

The exported video has exactly the frame count of the exported range, and each frame is the one the Program monitor showed.
An In/Out range that starts or ends inside a transition renders those frames exactly as the full export does.
Anamorphic (non-square pixel) sources are un-squeezed, so they fill the frame as they do in the preview.
If you pick a **Frame rate** other than the sequence's (for example 30 fps for a 23.976 sequence), the video is
converted when it is written: frames are repeated or dropped, while the duration and audio sync stay the same. The
dialog shows the resulting frame count; **Use <sequence rate>** switches back.

**Pre-export warnings.** The Checks list looks at the clips the export renders (enabled clips on tracks that are not
muted, inside the chosen range) and warns about:

- **Source frame rate differs from the sequence**: video media at another frame rate, for example 25 fps footage
  in a 23.976 sequence. Its frames are repeated or dropped to fit, so motion may stutter. Stills, audio and VFR
  media are not compared.
- **Variable frame rate (VFR) media in the sequence**: typically phone or screen recordings. Converting such a
  file to a constant frame rate before editing avoids uneven motion and sync problems.
- **Linked clips out of sync**: a linked video and audio clip that were moved or slipped apart, with the offset
  the timeline's red **+N / −N** badge shows.
- **Transitions dropped (hard cut)** and **Transitions shortened**: a transition is centered on its cut, so it
  needs half its length of source media past the end of the outgoing clip and before the start of the incoming one.
  When the media runs out, the export renders a shorter transition, or a hard cut, and the warning gives the set
  and the rendered length (for example `24 → 10 frames`) and the reason. These are the same numbers the export
  uses.
- **Clips run past the end of their media**: the last frame is held and the sound is silent for the rest of the
  clip.

Each warning names the media or clips (the first three, then "and N more"). **Show** closes the dialog, selects
them (or the transition) on the timeline and moves the playhead to the first one. Warnings never block the export.

**Chapters:** markers of kind **Chapter** (marker dialog or Markers panel) become the chapters of an MP4, MKV, MOV or FLAC file (WAV has none), with their
names. Only chapter markers inside the exported range count; times are measured from the start of the range. A chapter
marker before the In point that is still current at In becomes the first chapter, starting at the beginning of the
file. If no chapter marker is at or before the start of the range (for example, you marked only the act breaks), the
file gets an extra first chapter with no name, from the start to your first chapter marker, so every break you
marked is kept. Each chapter runs to the next one, the last to the end of the file. Ordinary markers and continuity
notes are not exported. A trailing backslash in a chapter name is dropped (FFmpeg cannot store it).
Nothing else is copied from your source files: no title, comment, artist or other tags, no chapters, no stream names
or languages. The only stream names and languages in a file are the ones you give the audio and subtitle tracks of
an MKV.

Export never writes over a file the project reads from: media, proxies, and subtitle files (imported to media or to
a sequence track, or read by the Transcript). Such a name is refused, also when it differs only in letter case or is
a link to the same file. ReCut renders into `<name>.recut-part-<random>.mp4` (`.mkv`, `.mov`, `.wav`, ...) next to the output
and renames it at the end; a per-track export renders every file before renaming any. If that final rename fails, the
finished render is kept as `<name>.recut-unsaved-<time>.mp4` and the error says so, so you do not have to render
again.

## Saving

- **Ctrl+S** saves a `.recut` project. It is JSON that references your media by path and never copies it.
- Autosave runs in the background. After a crash, ReCut offers **Recover** on the next launch. If the autosave
  had to be repaired, the prompt says so: check the recovered edit before saving over the project.
- Opening a project repairs damaged data (invalid frame rates become 23.976, out-of-range values are dropped or
  pulled in, overlapping clips are shortened at their start or moved to a new track) and shows a warning listing the
  repairs. The file as it was is kept as `<file>.pre-repair-<time>`. A file too damaged to repair (not JSON, or its
  media or sequences list unreadable) opens from its `.bak`, and the damaged file is kept as `<file>.corrupt-<time>`.
  A file saved by a newer ReCut is refused, never replaced by the `.bak`.
- Opening or creating a project closes open dialogs (Export, Relink, ...) that belonged to the previous one.
- **Quit** (Ctrl+Q) asks to save unsaved changes.
- Projects saved by any earlier stable release (0.3.0 onwards) open without losing anything; a project saved by a
  newer ReCut is refused with a message that says so (see
  [the compatibility promise](project-format.md#compatibility-promise)).

## Updates

ReCut works offline and never updates itself. It can tell you when a newer release is out:

- The first time you start this version, a bar at the top asks **Check for new ReCut versions on GitHub once a
  day? [Yes] [No]**. Nothing is checked until you answer **Yes**.
- With checking on, ReCut asks GitHub for the latest release a few seconds after it starts, at most once a day. When
  a newer version exists, a bar says **ReCut X.Y.Z is available — Release notes**. **Release notes** opens the
  release page in your browser, where you download and install the new version yourself (your projects and
  preferences are kept). **Skip this version** hides the bar until a later release; **×** hides it until the next
  start.
- **Help › Check for Updates…** checks once, now, whatever the setting, and tells you whether you are up to date, a
  new version exists, or the check failed.
- **Preferences › Check for updates** changes the setting (**Ask me**, **Once a day**, **Off**) and shows when the
  last check was made. **Check now** does the same as the Help menu item.

**Privacy:** the check is one request to `api.github.com` for the latest ReCut release. It sends nothing about you,
your projects or your media: no identifier, no cookies, no telemetry. The only header ReCut adds is
`User-Agent: ReCut/<version>`; your network stack adds its usual ones (for example the accepted languages), and GitHub
sees your IP address as for any web request. Pre-releases are never offered. Administrators can turn the prompt and
the daily check off for an installation with the environment variable `RECUT_UPDATE_CHECK=0`.
