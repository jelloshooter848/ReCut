# File › Import Media… (Ctrl+I) offers a stale file-type filter that hides many supported formats

| Field | Value |
|---|---|
| Status | fixed |
| Severity | low |
| Area | UI (import) |
| Reported by / date | Claude (agent, docs audit), 2026-10-08 |
| Found on commit | 679026b (main) |
| Environment | Linux 6.18, Node 22.22.0; source build. No media involved. |

## Report

### Summary
File › Import Media… (Ctrl+I) opens the OS file dialog with its own extension list, `MEDIA_FILTERS` in
`src/app/commands.ts`, which predates the shared still-image list. The Project panel's **Import…** uses
`IMPORT_FILTERS` (`src/panels/project/actions.ts`), the list docs/FORMATS.md documents. A user who imports from the
menu does not see TIFF, HEIC, AVIF, EXR, PSD, JPEG XL and most other stills, MTS / 3GP / OGV video, Opus / DTS /
E-AC-3 / AIFF audio, or any subtitle file, unless they switch the dialog to All Files.

### Steps to reproduce
1. Press Ctrl+I (or File › Import Media…).
2. Browse to a folder holding `photo.heic`, `clip.mts`, `music.opus` and `movie.srt`.
3. Compare with Project panel › Import… on the same folder.

### Expected
Both dialogs list the same groups and extensions (All media, Video, Audio, Images, Subtitles, All files), as
docs/FORMATS.md "Import" says ("The **Import Media** dialog (Ctrl+I, or **Import…** in the Project panel) filters on").

### Actual
The menu dialog's groups were `Media`, `Video`, `Audio`, `Images`, `All Files` with 25 media extensions in total:
none of the files above is listed under the default `Media` group, and there is no `Subtitles` group.

### Evidence
`src/app/commands.ts` on 679026b, `const MEDIA_FILTERS = [...]` (Images: `png, jpg, jpeg, gif, bmp, webp` only),
passed by `importMediaViaDialog()` to `api.openFiles`.

### Suspected cause (hypothesis)
Two copies of the list; the panel's was moved to the shared extension lists (`shared/media.ts`,
`src/state/parseIdentity.ts`), the menu's was not.

### Scope
The menu's Import Subtitles… also had its own copy of the subtitle filter (same content, different casing).

---

## Verification

| Field | Value |
|---|---|
| Verified by / date | Claude (agent), 2026-10-08 |
| Verified on commit | 679026b |
| Verdict | confirmed |

The new test captures the options both paths pass to `window.recut.openFiles`; on 679026b the menu passes a different
array (`expected [ { name: 'Media', …(1) }, …(4) ] to be [ { name: 'All media', …(1) }, …(5) ]`).

---

## Resolution

| Field | Value |
|---|---|
| Closed by / date | Claude (agent), 2026-10-08 |
| Fix | branch `claude/small-fixes-docs-audit` |
| Files changed | `src/app/commands.ts`, `tests/unit/docs-audit-fixes.test.ts` (new) |
| Regression test | `tests/unit/docs-audit-fixes.test.ts` › "Import Media… (menu, Ctrl+I) and the Project panel Import… use one filter list" (3 tests) |

### Root cause
`importMediaViaDialog()` used a private, outdated filter list instead of the Project panel's `IMPORT_FILTERS`.

### Fix
Deleted `MEDIA_FILTERS` and the private `SUBTITLE_FILTERS` from `src/app/commands.ts`; the menu commands now pass
`IMPORT_FILTERS` / `SUBTITLE_FILTERS` exported by `src/panels/project/actions.ts`, which `commands.ts` already imports
(`importPaths`), so no new import edge and no cycle. `IMPORT_FILTERS` is built from the shared extension lists, so
there is one source of truth.

### Before / after
Before: menu dialog groups Media / Video / Audio / Images / All Files, 25 extensions. After: identical to the panel
(All media / Video / Audio / Images / Subtitles / All files, the lists in docs/FORMATS.md).

### Regression test proof
On 679026b: "both open the file dialog with IMPORT_FILTERS" fails (`expected [ { name: 'Media', …(1) }, …(4) ] to be
[ { name: 'All media', …(1) }, …(5) ] // Object.is equality`); "Import Subtitles… (menu) uses the panel subtitle filter
list" fails (different array). Both pass with the fix.

### Tests run
`npm run typecheck`: clean. `npm test`: 113 files, 1963 passed, 3 skipped (1966).

### Changed existing assertions
None.

### Compatibility risks
None: only the OS file dialog's filter list changes. Imports still go through `importPaths`.

### Follow-ups
None.
