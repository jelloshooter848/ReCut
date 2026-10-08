# Things to try in ReCut {{VERSION}}

Short tasks, one per feature. Do them in any order, skip what does not interest
you. Each says which kit files to use. On a Mac, read Ctrl as Cmd.

Most tasks start from the ready-made trailer: **File › Open Project…** ›
`projects/Open Movie Trailer.recut`, then **Relink › Search folder…** on the kit
folder and **Apply … matches** (see README-FIRST.txt). Save it once with Ctrl+S.

Panels mentioned below (Transcript, Storyline, Inspector, Jobs…) are tabs in the
ReCut window. If one is hidden, look for its tab name in the other panel areas.

If anything is confusing, slow, ugly or broken, that is exactly what we want to
hear: see REPORTING.md.

---

## 1. Play the trailer

**Files:** `projects/Open Movie Trailer.recut`

Press Space to play the "Trailer" sequence in the Program monitor. Use J, K, L to
play backwards, pause and forwards, and the arrow keys to step one frame.
Does the picture and sound stay smooth? Do the dissolves and the dips to black
between the acts look right?

## 2. Search the dialogue of every film at once

**Files:** the trailer project (its films carry their subtitles)

Open the **Transcript** panel (Shift+6) › **Search**. Set the scope to
**Franchise: Blender Open Movies**. Type `{{SEARCH_WORD}}`: you get lines from both
Tears of Steel and Sintel. Turn on **Regular expression** and try
`{{SEARCH_TOS}}|{{SEARCH_SINTEL}}`. Every subtitle track is searched, so German
(Tears of Steel) and French (Sintel) lines can show up too.
Click a result: the Source monitor jumps to that line with In and Out set.
Ctrl+Enter puts it in the timeline at the playhead.

## 3. Turn speech into text with Whisper

**Files:** `franchise/Elephants Dream (2006).mp4` (it has no subtitles at all)

1. ReCut does not ship the speech-to-text "model" (the part that knows the
   language); you download one once: **File › Transcription Models…** and
   click **Install** next to **Base (English)** (148 MB, quick) or **Small**
   (488 MB, more accurate, slower). It downloads from a fixed address and is
   checked before use. After that, transcribing works offline.
2. In the Project panel, right-click Elephants Dream › **Transcribe with
   Whisper…** (or **Transcript › Import › Transcribe… › Local Whisper…**).
3. Pick the model and the language (English), then **Transcribe**. Progress
   shows in the **Jobs** panel. A 10-minute film takes a few minutes, more
   on an older computer.
4. Search for a word you heard (task 2).

Try it on Sintel too, and compare Whisper's lines with the film's official
English subtitles (both tracks show in the Transcript panel).

## 4. Read picture subtitles with OCR

**Files:** `formats/Tears of Steel - DVD rip with bitmap subtitles.mkv`

DVD and Blu-ray subtitles are pictures, not text. Import the file, select it,
then **Transcript › Import › Embedded…** and pick the English stream (it says
**Read with OCR…**). If asked, click **Install English** (a 4 MB download,
once). Click **Start**. The lines appear as a normal subtitle track you can
search. Try the German stream too (it asks to install German).

## 5. "What if" cuts with the Storyline

**Files:** the trailer project

Open **Storyline** (next to Timeline). Under **SHOW ONLY**, tick the character
**Big Buck Bunny**, choose **Highlight**, and look at **Runtime if removed**.
Click **Disable matching** to preview the trailer without the bunny, play it,
then **Enable all** to undo. Try **Solo**, and the other characters (Celia,
Thom, Sintel, Proog, Emo).

## 6. Compare two cuts

**Files:** the trailer project (it has two versions: "Trailer" and "Trailer (no bunny)")

Switch to the **Compare** workspace (Alt+Shift+4). Choose **Sequence A** =
Trailer and **Sequence B** = Trailer (no bunny). Play them side by side, and
look at the **Structure** list (same / moved / only in A...). Click an entry to
jump there.

## 7. Nested sequences (compound clips)

**Files:** the trailer project

Act II of the trailer is one clip that holds a whole sequence (it has a
**NEST** badge). Double-click it to edit inside; change something and go back:
the trailer shows your change. Then select two or three clips yourself and
use **Clip › Make Compound Clip**, and **Clip › Break Apart Compound Clip**
to undo it.

## 8. Keyframes

**Files:** the trailer project, `stills/Title card (transparent).png`

The title at the start fades in and grows: select it (track V2) and look at
**Opacity** and **Scale** in the **Inspector**; the diamonds are keyframes.
Make your own "Ken Burns" move: select a shot, put the playhead at its start,
click the diamond next to **Scale** and **Position**, move the playhead to the
end of the shot and change both values. Play it. The music on track A2 also
has level keyframes that dip under the dialogue.

## 9. Pull the dialogue out of a 5.1 mix

**Files:** `formats/{{CENTRE_FILE}}`

This file is 5.1 surround with the voices alone on the centre channel. Put it
on a timeline, right-click the clip › **Extract Centre Channel (Dialogue)**.
A new audio clip appears with just the centre. Solo or mute tracks and listen:
the new clip should be voices only. Also try the Inspector's **Audio ›
Channels** setting on the original clip.

## 10. Choose between audio tracks of an MKV

**Files:** `formats/Tears of Steel - 3 audio tracks, 2 subtitles, chapters.mkv`

The file has three audio tracks: Main mix, Alternate mix (dialogue boost) and
Music & effects. Select the file: the Media Inspector's **Audio stream** picks
the track for new clips. Put it on the timeline, select the clip and switch
**Audio › Stream** in the Inspector; play each one. The two subtitle tracks
(English, German) are under **Transcript › Import › Embedded…**.

## 11. Many formats

**Files:** everything in `formats/`

Import the folder. Check that each file shows the right size, frame rate and
sound in the Media Inspector, and that it plays. HEVC, ProRes, DNxHR, AC-3
sound and the 4K clip may get a **proxy** (a preview copy) first: watch
**Jobs › Proxies**. The phone clip is recorded sideways with a "rotate" flag and
a variable frame rate: does it show upright?

## 12. Frame rates and timecode

**Files:** the five `formats/Frame rate ….mp4/.mov` files

Each shows its frame rate and a frame number (the 29.97 one shows its own
timecode, starting at 01:00:00;00). Make a new sequence, drop the 23.976 clip in
first (accept **Change sequence to match clip?**), then add the 25, 29.97, 30
and 60 ones. Step through frames; open **File › Export…** and read the
**Checks** (frame-rate and VFR warnings).

## 13. Audio files

**Files:** everything in `audio/`

Import them all. The four "score and dialogue" files are the same sound in four
formats: do they look and sound the same? `{{DIALOGUE_FILE}}` {{DIALOGUE_DESC}}.
The 1 kHz tone is a steady level for checking meters. "Silence, then a sudden
loud burst" tests waveforms and levels: turn your volume down first!

## 14. Stills

**Files:** everything in `stills/`

Put the title card on track V2 over a shot: the background should be see-through.
The 8K image is huge (7680x4320): does it import and scale down smoothly? The
tiny 64x36 one should scale up without breaking anything.

## 15. Export with presets

**Files:** the trailer project

**File › Export…** (Ctrl+M). Try a few **Presets**: 720p Preview, 1080p High
Quality, ProRes 422 HQ (MOV), WAV per audio track. Then choose **Format: MKV**,
**Tracks: 5.1 + stereo downmix**, and tick a subtitle track. Play the results
in your usual video player (VLC, QuickTime, Films & TV...). Do the chapters
(the three acts) show up?

## 16. Hand the edit to another editor (FCPXML / OTIO / EDL)

**Files:** the trailer project

New in {{VERSION}}: **File › Export Timeline…**. Pick the Trailer and a format:
FCPXML (DaVinci Resolve, Final Cut Pro), OpenTimelineIO, or CMX3600 EDL. Read the
report (what transfers and what does not), then export. If you have DaVinci
Resolve (free), import it there with **File › Import › Timeline…**.

## 17. Collect Project

**Files:** the trailer project

**File › Collect Project…** copies the project and every file it uses into one
new folder (to archive it or give it to someone). Choose a destination, look at
the size, click **Collect**, then open the collected project. Does it play
without relinking?

## 18. Start your own edit

**Files:** `projects/Start here.recut`, the `franchise/` folder

Open "Start here", **File › Import Media…** and pick all four films. Their
subtitle files are attached automatically. Right-click a film ›
**Detect Scenes…**. Cut your own trailer: mark In (I) and Out (O) in the Source
monitor and press , (insert) or . (overwrite). Save, close ReCut, open it
again: is everything still there?

## 19. Very long timelines

**Files:** `trouble/Two hours (long timeline).mp4`

Put the two-hour file on a timeline. Zoom in and out, scroll, cut it with the
Razor (C), ripple-delete pieces, undo, save. Does ReCut stay quick?

## 20. Trouble files

**Files:** everything in `trouble/`

Import them one by one. `trouble/TROUBLE.txt` says what each file is for and
what should happen. ReCut should never crash, freeze or lose your work, and its
messages should tell you what is wrong.
