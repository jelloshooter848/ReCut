# Telling us what you found

Send your notes to the person who gave you this kit, in whatever way you
normally talk (email, chat...). No account or special form is needed. One
message per problem is easiest for us, but a list is fine too.

Small things count: a confusing word, a button you could not find, something
slow. You cannot report "too much".

## A problem: copy this into your message

```
WHAT I DID:
(step by step, e.g. "Opened Open Movie Trailer, selected the first clip,
pressed Ctrl+M, chose the ProRes preset, clicked Export")

WHAT I EXPECTED:


WHAT HAPPENED INSTEAD:
(copy any message word for word, or attach a screenshot)

HOW OFTEN: every time / sometimes / once
(if it happened again: does it still happen after restarting ReCut?)

KIT FILES USED: (e.g. formats/Sintel - HEVC.mp4)

RECUT VERSION: (Help > About ReCut, e.g. "ReCut {{VERSION}}")

COMPUTER: Windows 10 / Windows 11 / Mac (Apple chip) / Mac (Intel)
(and roughly how old it is, if it was slow)

ATTACHED: screenshots / the project file (.recut) / a screen recording
```

Screenshots help a lot: on Windows press Windows+Shift+S, on a Mac press
Cmd+Shift+4 (or Cmd+Shift+5 to record the screen).

If the problem is about a project, attach the `.recut` file (File > Save As...
to save a copy first). It is small: it only lists your edits, not the videos.

## An idea or a wish: copy this

```
I WISH RECUT COULD:

BECAUSE: (what you were trying to do)

HOW I DO IT TODAY: (another program, a workaround, or "I can't")
```

## Extra details we may ask for

ReCut has no log file or "send diagnostics" button. These places show what we
usually need:

- **Help > About ReCut**: the ReCut version, the FFmpeg version it uses and its
  cache folder. A screenshot of this window is perfect.
- **Preferences** (Windows: Edit > Preferences..., Ctrl+,; Mac: ReCut >
  Preferences..., Cmd+,), under "Application": where FFmpeg, speech-to-text and
  OCR were found, and which models and languages are installed.
- **Jobs panel**: a failed job (proxy, export, transcription, OCR...) shows a
  red error line. Click it to open the full message; you can select and copy
  the text.
- **View > Toggle Developer Tools**, then the "Console" tab: technical messages.
  Red lines are errors. A screenshot of them helps when something looks broken.
  Close the window again with the same menu item.
- **Settings and recovery files** live in:
  - Windows: `%APPDATA%\ReCut` (paste that into the File Explorer address bar)
  - Mac: `~/Library/Application Support/ReCut` (in Finder: Go > Go to Folder...)

  Unsaved work is autosaved next to your project as `<name>.recut.autosave`
  (for a project never saved, in the `autosave` folder above). After a crash,
  ReCut offers to recover it the next time it starts: tell us if it did.

Thank you!
