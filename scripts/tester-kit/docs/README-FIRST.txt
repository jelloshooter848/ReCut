READ ME FIRST: the ReCut tester kit (for ReCut {{VERSION}})
==========================================================

Thanks for helping test ReCut!

ReCut is a free video editor made for fan edits: recutting films and TV shows,
merging a trilogy into one story, following one character through a season.
It can search the dialogue of every film at once, compare two versions of a
cut, and export to the usual formats.

This kit has everything you need to try it, so you do not have to use your
own films. Every film in it is a free "open movie" from the Blender
Foundation (see CREDITS.txt). Nothing in the kit needs the internet.


1. INSTALL RECUT {{VERSION}}
----------------------------

Get it from the Releases page (no account needed):

    https://github.com/jelloshooter848/ReCut/releases

Use the release called "ReCut {{VERSION}}". Under "Assets", download the file
for your computer.

WINDOWS (Windows 10 or 11, 64-bit)

  * Download ReCut-Setup-{{VERSION}}.exe and run it. It installs for you only
    (no admin password) and adds Start-menu and desktop shortcuts.
  * Windows may say "Windows protected your PC". That is because ReCut is a
    free project without a paid code-signing certificate. Click "More info",
    then "Run anyway".
  * Prefer not to install? ReCut-Portable-{{VERSION}}.exe is the same app as a
    single file you just run.

MAC (macOS 12 Monterey or newer)

  * Pick the download for your Mac's chip. Open the Apple menu > About This Mac:
      - "Chip: Apple M1" (M2, M3, M4...)  ->  ReCut-{{VERSION}}-macos-arm64.dmg
      - "Processor: ... Intel ..."        ->  ReCut-{{VERSION}}-macos-x64.dmg
  * Open the .dmg and drag ReCut into Applications.
  * The first time you open it, macOS asks whether to open an app downloaded
    from the Internet. Click "Open". (ReCut is signed and checked by Apple.)

FIRST START

  * A bar at the top asks whether ReCut may check GitHub once a day for new
    versions. Answer either way; it changes nothing else.
  * On a Mac, read "Ctrl" in our notes as "Cmd".


2. UNZIP THE KIT
----------------

  * Windows: right-click the zip > "Extract All...". Do not open files from
    inside the zip without extracting: ReCut needs real files on your disk.
  * Mac: double-click the zip.
  * Put the folder anywhere (Desktop, Documents, an external drive).
  * Google Drive may warn that it "can't scan this file for viruses" because
    the zip is large. That is normal for big files: choose "Download anyway".


3. WHAT IS IN THE KIT
---------------------

  franchise/   Four complete short films, 720p, with official subtitles where
               they exist: Tears of Steel (English, German), Sintel (French;
               there are no official English subtitles), Big Buck Bunny (no
               dialogue, so no subtitles) and Elephants Dream (no official
               subtitles: try the speech-to-text on it).
  formats/     Short clips (20 to 60 seconds) in many formats: an MKV with 3
               audio tracks and 2 subtitle tracks, a "DVD rip" with picture
               subtitles, 5.1 surround, HEVC, ProRes, DNxHR, vertical video,
               a phone clip, five frame rates and a 4K clip.
  audio/       The same music excerpt as WAV, MP3, FLAC and M4A, a
               dialogue-only file, a test tone, and silence with a loud burst.
  stills/      A title card with a transparent background, a photo-style
               frame grab, a huge 8K image and a tiny one.
  trouble/     Deliberately awkward files (broken, odd names, very long...).
               TROUBLE.txt says what each one is for.
  projects/    "Open Movie Trailer.recut": a finished fan-edit trailer to
               explore. "Start here.recut": an empty project for your own edit.

  MANIFEST.txt lists every file with its size, length and format.


4. WHERE TO START
-----------------

  1. Open ReCut, then File > Open Project... and pick
     projects/Open Movie Trailer.recut.
  2. ReCut says the media files are "offline" (the project was made on
     another computer). In the Relink window click "Search folder...", choose
     the kit folder (the one this file is in), then "Apply ... matches".
     Everything comes back in one go. Save with Ctrl+S.
     (If the Relink window does not appear, click "Relink..." in the Project
     panel.)
  3. Press Space to play. Then work through TRY-THIS.md: about twenty short
     things to try, each with the files to use.

When something goes wrong, surprises you, or you wish ReCut did something,
tell us: REPORTING.md has a short template to copy into a message.

Have fun!
