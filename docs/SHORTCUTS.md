# Keyboard shortcuts

These are the defaults from `DEFAULT_BINDINGS` (`src/keyboard/shortcuts.ts`), `EXTRA_META` (`src/app/commands.ts`)
and the panel-local handlers. **Ctrl** means Cmd on macOS, and **Alt** is Option.

**Every command can be rebound.** Open **Help › Keyboard Shortcuts**, click the keyboard icon at the top right,
press **Ctrl+Alt+K**, or use **Preferences › Keyboard shortcuts…**. The dialog is searchable, highlights conflicts,
and lets you add or remove keys per command and reset one command or all of them. Overrides are saved in `prefs.json`.

Global shortcuts do not fire while you type in a text field or a dialog has focus. The exceptions are Escape, Ctrl+S
and Ctrl+Shift+S.

## Playback

| Command | Keys |
|---|---|
| Play / Pause | Space |
| Shuttle Backward / Stop / Forward | J / K / L. Repeated J or L doubles the speed, up to 8×. |
| Step Back / Forward 1 Frame | ← / → |
| Step Back / Forward 5 Frames | Shift+← / Shift+→ |
| Go to Previous / Next Edit Point | ↑ / ↓ (in the Source monitor: previous / next detected scene boundary) |
| Go to Sequence Start / End | Home / End |
| Go to In Point / Out Point | Shift+I / Shift+O |
| Play In to Out | Ctrl+Shift+Space |

Playback keys drive the **active transport**: the Source monitor, or the Program/Timeline side (the Program monitor
or Timeline, whichever was clicked last), or Compare when it is focused.

## Marks & markers

| Command | Keys |
|---|---|
| Mark In / Mark Out | I / O |
| Clear In and Out | Ctrl+Shift+X |
| Mark Clip (In/Out around the selected clips or the clip under the playhead) | X |
| Add Marker (on an existing marker: edit it) | M |
| Match Frame (open the clip's source at this frame) | F |

## Editing

| Command | Keys |
|---|---|
| Insert (three-point, from the Source monitor) | , |
| Overwrite (three-point) | . |
| Lift (remove In→Out, leave a gap) | ; |
| Extract (remove In→Out, close the gap) | ' |
| Delete | Delete, Backspace |
| Ripple Delete | Shift+Delete |
| Add Edit (cut at the playhead: on the tracks of selected clips there, else on all unlocked tracks) | Ctrl+K |
| Add Edit to All Tracks | Ctrl+Shift+K |
| Ripple Trim Previous Edit to Playhead | Q |
| Ripple Trim Next Edit to Playhead | W |
| Apply Default Video Transition (cross dissolve) | Ctrl+D |
| Apply Default Audio Transition (crossfade) | Ctrl+Shift+D |
| Enable / Disable Clip | Shift+E |
| Remove Disabled Clips… (ripple, asks first) | unbound (Sequence menu, Storyline › What if, clip context menu) |
| Extract Centre Channel (Dialogue), Make Compound Clip, Open in Timeline, Break Apart Compound Clip | unbound (Clip menu, clip context menu) |
| Link / Unlink | Ctrl+L |
| Speed / Duration… | Ctrl+R |
| Nudge Selection Left / Right 1 Frame | Alt+← / Alt+→ |
| Nudge Selection Left / Right 5 Frames | Alt+Shift+← / Alt+Shift+→ |
| Undo | Ctrl+Z |
| Redo | Ctrl+Shift+Z, Ctrl+Y |
| Cut / Copy / Paste (at the playhead) | Ctrl+X / Ctrl+C / Ctrl+V |
| Select All / Deselect All | Ctrl+A / Ctrl+Shift+A |

The default transition length is set in **Preferences › Default transition** (24 frames out of the box).

## Tools

| Tool | Key |
|---|---|
| Selection | V |
| Track Select | A |
| Ripple Edit | B |
| Rolling Edit | N |
| Slip | Y |
| Slide | U |
| Razor | C |
| Hand | H |

## File

| Command | Keys |
|---|---|
| New Project | Ctrl+N |
| Open Project… | Ctrl+O |
| Save Project / Save Project As… | Ctrl+S / Ctrl+Shift+S |
| Import Media… | Ctrl+I |
| Export… | Ctrl+M |
| New Sequence… | Ctrl+Shift+N |
| Preferences… | Ctrl+, (menu: **Edit › Preferences…** on Linux / Windows, **ReCut › Preferences…** on macOS) |
| Quit | Ctrl+Q |
| Import Subtitles…, Collect Project…, OCR Languages…, Transcription Models…, Duplicate Sequence…, Duplicate as Cut Without Disabled Clips…, Take Sequence Snapshot…, Rename Sequence…, Sequence Settings…, Clear Recent Projects | unbound (assign them in the dialog) |

## View & panels

| Command | Keys |
|---|---|
| Zoom In / Out (timeline) | = / - |
| Zoom to Fit Sequence | \\ |
| Toggle Snapping | S |
| Maximize / Restore Focused Panel | Ctrl+` |
| Program Monitor Full Screen (maximizes the Program zone) | Ctrl+Shift+F |
| Toggle Window Full Screen | F11 |
| Focus Project / Source / Program / Timeline / Inspector / Transcript / Scenes / Subtitles / Markers | Shift+1 … Shift+9 |

## Workspaces

| Command | Keys |
|---|---|
| Editing / Research / Audio / Compare | Alt+Shift+1 / 2 / 3 / 4 |
| Reset Current Workspace Layout | Alt+Shift+0 |

## Help

| Command | Keys |
|---|---|
| Keyboard Shortcuts… | Ctrl+Alt+K |
| Check for Updates…, About ReCut | unbound (Help menu) |

## Timecode entry

Click a timecode field (Source and Program monitors, Timeline header, Scene editor) to type a value. **Enter**
commits, **Esc** cancels. Dragging the field left / right scrubs (Shift = 10 frames per step).

| Typed | Means |
|---|---|
| `01:02:03:04` | Hours, minutes, seconds, frames. `;` and `.` also work as separators. |
| `1:00`, `12` | Fields fill from the right: `1:00` is 1 s, `12` is 12 frames. Fields may overflow and carry (`90:00` = 1 min 30 s). |
| `1512`, `11500` | Digits only: pairs fill frames, seconds, minutes, hours from the right (`1512` = 15 s 12 f, `11500` = 1 min 15 s). |
| `+24`, `-12` | Frames relative to the current value. |
| `-01:00:00:00` | A negative timecode; only in the full four-field form. |

At 29.97 and 59.94 fps the fields show SMPTE drop-frame (`HH:MM:SS;FF`), and typed input is read the same way
whatever the separators: `1:00:00:00` or `1000000` means the label `01:00:00;00` (frame 107892 at 29.97). Labels
that drop-frame skips (`00:01:00;00` and `;01` at 29.97, `;00`–`;03` at 59.94, in minutes not divisible by 10) are
rejected.

Entry is strict: every field must be digits, at most four fields, and nothing is guessed or truncated. Anything else
(letters, empty fields, a fifth field, more than eight digits) is rejected: the field is marked invalid and the value
does not change. A valid entry is clamped to the field's range.

## Panel-local keys (not rebindable)

| Where | Keys |
|---|---|
| Source monitor focused | Space, J/K/L, ←/→ (Shift = 5), Home/End, I/O, Shift+I/O, `,` insert, `.` overwrite |
| Program monitor focused | Space, J/K/L, ←/→ (Shift = 5), Home/End, I/O, Shift+I/O |
| Timeline focused | Esc cancels a drag, closes a popover or clears the selection. Delete/Backspace deletes (Shift = ripple). Ctrl+A / Ctrl+Shift+A, Ctrl+C / X / V |
| Project panel | ↑/↓ move (Shift extends the selection), ←/→ collapse/expand, Enter opens (loads media in Source, opens a sequence, toggles a bin), F2 rename, Delete remove, Esc clear selection, Ctrl+A select all media |
| Transcript search | ↑/↓ pick a result, Enter loads it in Source with In/Out on the line, Ctrl+Enter inserts it at the playhead, Esc clears the query, then leaves the field |
| Scenes panel | ↑/↓ select (Shift extends the selection), Ctrl+A select all shown, Enter load in Source, Delete delete |
| Continuity panel | ↑/↓ select, Space resolve/reopen, Enter or F2 edit, Delete delete, Esc clear focus |
| Compare panel focused | Alt (pressed alone) toggles A only / B only |
| Subtitle cue / name fields | Enter commits, Esc reverts |
| Story block notes | Ctrl+Enter saves |
| Any dialog, popover, context menu | Esc closes |

## Mouse modifiers on the timeline

| Gesture | Effect |
|---|---|
| Click / Shift+click / Ctrl+click | Select / add to selection / toggle |
| Alt+click | Select only this side of a linked clip |
| Drag clip | Overwrite-move. Hold **Ctrl** for an insert-move (later clips shift). |
| Alt while dragging | Turn snapping off temporarily |
| Razor click / Shift+Razor click | Cut this track / cut all tracks |
| Track Select click / Shift+click | Select forward on this track / on all tracks |
| Double-click a clip | Open its source in the Source monitor with In/Out set to the clip's range |
