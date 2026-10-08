# RETEST — kit v2: only the checks that failed or were not checked in the first run

The first run (Resolve 21.1 free, Mac App Store, 8 October 2026, results on PR #83) passed everything in OTIO except a marker note, and found real problems in the FCPXML and EDL files. This kit (v2) has fixed exports and a few test-media and wording fixes. Redo **only** the checks below; everything else stands from run 1. EXPECTED.md, INSTRUCTIONS.md and RESULTS.md in this kit are the full v2 versions (use them for the expected values and the step-by-step import procedure).

## What changed since v1

- **FCPXML:** Resolve ignores FCPXML's `srcEnable` ("video only" / "audio only"). ReCut now writes each linked video + audio pair as **one** clip carrying both (Final Cut Pro's own form), so there is no audio-only secondary storyline any more (it became the "Secondary Storyline" compound whose picture hid the fades). Clips that use only the picture of a file with sound are written with their sound at −96 dB (silent), and audio-only clips of a file with picture with their picture transparent. Expected fallout, not FAILs: those silent / transparent extras appear as items in Resolve; the B_Blue → C_Green audio cross fade takes the video dissolve's length (24 frames instead of 12).
- **FCPXML speed:** the 200% clip's `timeMap` now starts at the file's start (`0s → 0s`), as Final Cut Pro writes it; v1 anchored it at the in point and Resolve played C_Green from frame 0.
- **OTIO:** marker notes are also written where Resolve's own OTIO files keep them.
- **Media:** the video files now carry an embedded start timecode of 00:00:00:00 (same pictures, same sound). In v1 Resolve refused to link the EDL events ("timecode extents do not match"); this tells whether a missing timecode track was the reason.
- **EXPECTED.md:** F4 / F16 (audio layout from FCPXML), F10 (V3 covers 00:00:11:00, so only the fade-out half of the dip is visible), F17, E11 / E12 (an EDL timeline starts at its first event), D2 (drop-frame OTIO arrives as non-drop-frame).
- **New experiment:** `exports/Resolve Test_V1-reels.edl`: the V1 EDL with a reel name per file (A_Red, B_Blue, C_Green) instead of AX (E7b).

## Setup

1. Rename the v1 folder (e.g. to `~/Movies/ReCut-Resolve-Test-Kit-v1`), then unzip `resolve-test-kit-v2.zip` in `~/Movies` (the App Store Resolve can only read ~/Movies) so that it creates `~/Movies/ReCut-Resolve-Test-Kit`, and run `sh localize.sh` in it (expect `localize.sh: OK`). Do **not** reuse the v1 media: it changed. The v1 Resolve projects keep pointing at the v1 folder, which M5 and M6 need.
2. Use **new** Resolve projects with the suffix `-v2` (RT-FCPXML-v2, RT-OTIO-v2, RT-EDL-v2, RT-EDL-REELS, RT-DF-v2, RT-DF-EDL-v2), set up as in INSTRUCTIONS.md › Setup step 5. Keep the v1 projects: M6 below looks at one.
3. The automated script can redo parts A–D exactly as in run 1 (import, re-export the Edit Index, EDL, FCPXML, FCP7 XML and OTIO, stills at the check frames). Part M needs a person in the Resolve UI.

## A. FCPXML (`exports/Resolve Test.fcpxml`, project RT-FCPXML-v2)

| Id | Check | Result (PASS / FAIL / NOTE / SKIP) | Observed |
|---|---|---|---|
| F1 | Import: every dialog / log line (v1: "Overlapping items found on track A2 …") | | |
| F2 | Media pool: no "Secondary Storyline" compound any more ("C_Green.mp4 (200%)" may still appear) | | |
| F4 | Track list: 3 video tracks as in EXPECTED › F4; audio items each once (any track), plus the silent extras listed there | | |
| F5 | Record In / Out of every clip (regression check) | | |
| F6 | Source In: C_Green 00:00:10:00 (v1: 00:00:00:00); labels at the check frames | | |
| F8 | Fade from black: 00:00:00:00 black, 00:00:00:06 about half, 00:00:00:12 full | | |
| F10 | Dip: C_Green.mp4 darkens 00:00:10:18 → 00:00:10:23; A_Red opacity keyframes 0 → 100 over its first 6 frames (picture hidden by V3) | | |
| F11 | 200%: at 00:00:08:12 FRAME 0264, at 00:00:09:00 FRAME 0288 (v1: 0024 / 0048); also at 00:00:10:17 FRAME 0370 | | |
| F12 | Disabled B_Blue: picture black; its sound (if present) disabled | | |
| F13 | V2 still picture: position, 15° clockwise, 70% (regression check: unchanged expected values) | | |
| F14 | V2 keyframed clip: positions / sizes at 05:00, 06:00, 07:00 (regression check); its sound silent | | |
| F15 | Compound contents on V3, its sound once | | |
| F16 | Audio not doubled: no audible copy of any clip's sound | | |
| F17 | Audio cross fade B_Blue → C_Green: present, 24 frames, 00:00:07:12–00:00:08:12 (any form: say which) | | |
| F18 | Music: −6 dB; its fade handles (M2 below): fade in 24 frames, fade out 48 frames | | |
| F19 | Markers: see M3 below | | |

## B. OTIO (`exports/Resolve Test.otio`, project RT-OTIO-v2)

| Id | Check | Result (PASS / FAIL / NOTE / SKIP) | Observed |
|---|---|---|---|
| O19 | Marker One's note "on A_Red": in Resolve's OTIO re-export (marker metadata / comment) and in the UI (M4) | | |

## C. EDL (project RT-EDL-v2, and RT-EDL-REELS for E7b)

Import as in INSTRUCTIONS.md › Part A3 (Automatically import source clips, source folder = the kit's `media`). If events are still offline, record it (E1) and then try the relink routes (M7).

| Id | Check | Result (PASS / FAIL / NOTE / SKIP) | Observed |
|---|---|---|---|
| E1 | Import of _V1.edl: do the events link now (embedded timecode)? Log lines verbatim | | |
| E2 | Record In / Out (regression check) | | |
| E3 | Source In and labels (needs linked media): A_Red 00:00:02:00, B_Blue 00:00:05:00, C_Green 00:00:10:00 at its cut, A_Red 00:00:12:12 | | |
| E5 | Cross Dissolve picture at 00:00:08:00 (blue / green mix) once linked | | |
| E6 | Dip: known Resolve behaviour in v1 = two dissolves between the clips, no black. Observe again with linked media: is 00:00:11:00 black? | | |
| E7 | M2: which clip gets 200%? Expected C_Green (labels at 00:00:08:12 FRAME 0264); v1: the outgoing B_Blue piece | | |
| E7b | Experiment: import `Resolve Test_V1-reels.edl` into RT-EDL-REELS the same way. Does it link? If not, set Project Settings › General Options › Conform Options › "Assist using reel names from the" › Source clip filename, and import again. Which clip gets the 200%? | | |
| E9 | Audio: once the media links, does A1 get the 4 clips under the video events (channel B)? | | |
| E11 | _V2.edl: links? (timeline start 00:00:01:00 is expected) | | |
| E12 | _V3.edl: links? where does its channel-3 audio go? (start 00:00:11:00 expected) | | |

## D. Drop-frame (projects RT-DF-v2 for FCPXML, RT-DF-EDL-v2 for EDL; 29.97 DF as in INSTRUCTIONS)

| Id | Check | Result (PASS / FAIL / NOTE / SKIP) | Observed |
|---|---|---|---|
| D1 | FCPXML: 1 video + 1 audio track (no doubled audio, no cut copies on another track), dissolve 00:00:59;05–00:01:00;07; marker "One minute" (M3) | | |
| D3 | EDL: does it link now? labels at the check frames | | |

## M. Manual checks in the Resolve UI (a person, a few minutes each)

Record the answers in the table at the end. "Zoom in" = View › Zoom In (⌘+) with the playhead at the spot.

- **M1 Playback (F20 / O20).** In RT-FCPXML-v2 and RT-OTIO-v2: put the playhead at the start (Home), press Space and watch to the end. Note stutters, error messages, or red "Media Offline" frames.
- **M2 Music fade handles (F18).** In RT-FCPXML-v2, find Music_Pulse.wav on its audio track. Make the track taller (drag the line under the track header) and zoom in around 00:00:00:00: a fade-in shows as a white curve rising from the clip's top-left corner, with a small handle on the clip's top edge at about 00:00:01:00 (24 frames in). Then zoom in around 00:00:11:00: a fade-out curve starts at about 00:00:09:00 (48 frames before the end). Hover over a handle (or start dragging it and press Esc) to read its length. Screenshot both ends: `M2-music-fade-in.png`, `M2-music-fade-out.png`. If there are no fade curves, say so (then FCPXML fades are not imported by Resolve).
- **M3 FCPXML markers (F19, D1).** FCPXML has no timeline markers, so they are on clips. In RT-FCPXML-v2, select the V1 A_Red clip (00:00:00:00–00:00:03:00) and look for a small marker drawn **on the clip** (not on the ruler) at 00:00:01:06; zoom in if needed. Double-click it: name "Marker One", note "on A_Red". Same on the B_Blue clip at 00:00:04:04 ("Chapter Two", 24 frames long). Also open the Edit Index's options (⋯) › Show Markers (if offered) and list what it shows. In RT-DF-v2, look on the second E_NTSC_2997 clip at 00:01:00;02 ("One minute"). Screenshot: `M3-clip-marker.png`.
- **M4 OTIO marker note (O19).** In RT-OTIO-v2, double-click the ruler marker at 00:00:01:06: is the **Notes** field "on A_Red"? Screenshot `M4-marker-dialog.png`.
- **M5 Drop-frame OTIO (D2).** In the v1 project RT-DF-OTIO (no new import needed): right-click its timeline in the Media Pool › Timelines › **Timeline Settings…**. Record whether "Use Project Settings" is ticked and, under Format, whether a **Use drop frame timecode** option exists and is ticked. Only after recording that: tick it (untick "Use Project Settings" if needed) and say whether the marker now reads 00:01:00;02 and the timeline ends at 00:01:09;22. This is to find a workaround for the docs; it does not change D2's result.
- **M6 Why the v1 EDL did not link (E1).** In the **v1** project RT-EDL, open the Media Pool, switch to list view (the list icon at the top right of the Media Pool), right-click a column header and show **Start TC** and **End TC**. Record A_Red.mp4's Start TC and End TC. Do the same in RT-EDL-v2 (v2 media). Expected for v2: 00:00:00:00 and 00:00:20:00.
- **M7 EDL relink routes (only if E1 is still offline in v2).** (a) Right-click the timeline in the Media Pool › Timelines › **Relink Clips for Selected Timeline…** › choose the kit's `media` folder. (b) In a fresh project, File › Import › Media… (all files in `media`), then File › Import › Timeline… the EDL with "Automatically import source clips" **un**ticked. Record which route linked the events, then redo E3 / E7 there.
- **M8 Optional.** The disabled B_Blue clip looks greyed out (F12 / O12); the 200% C_Green sound is higher-pitched or faster (F11).

## RETEST results (fill in)

| Id | Check | Result (PASS / FAIL / NOTE / SKIP) | Observed |
|---|---|---|---|
| M1 | Playback | | |
| M2 | Music fade handles | | |
| M3 | FCPXML clip markers | | |
| M4 | OTIO marker note | | |
| M5 | Drop-frame OTIO timeline settings | | |
| M6 | Start TC of A_Red.mp4 (v1 / v2) | | |
| M7 | EDL relink route | | |
| M8 | Greyed look, pitch (optional) | | |

Fill in the A–D tables above too, then send this file back (comment on PR #83 or give it to the person who sent the kit), with the screenshots and Resolve's re-exports.
