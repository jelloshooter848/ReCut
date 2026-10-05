# Export ignores chapter markers and copies the first source's chapters and title

| Field | Value |
|---|---|
| Status | fixed |
| Severity | medium |
| Area | export |
| Reported by / date | Claude (Claude Code session), 2026-10-05 |
| Found on commit | b62f1fe |
| Environment | Linux container, FFmpeg 6.1.1 (`6.1.1-3ubuntu5`), source checkout, export run through `runExport` in vitest |

## Report

### Summary

ReCut lets the user create **Chapter** markers (`MarkerKind` `'chapter'`, `shared/model.ts:215`; Markers panel and
marker dialog), but no export writes them. Worse, a single-pass export silently copies the chapter list and global
metadata (for example the title) of the first input file into the MP4. A fan edit cut from a Blu-ray remux therefore
ships with the original film's chapter names and title, at the original's times, clipped to the export length. A
chunked export of the same sequence writes no chapters at all, so the output depends on the clip count.

### Steps to reproduce

1. Make a 4 s source with two chapters ("Source Ch 1" 0–2 s, "Source Ch 2" 2–4 s) and a global title
   ("Source Movie Title").
2. Sequence at 24 fps: one video and one audio clip from the **second half** of the source (source 2 s, 48 frames)
   at frame 0. Add Chapter markers "Opening" at frame 0 and "Act Two" at frame 24.
3. Export once with `chunked: false` and once with `chunked: true`.
4. `ffprobe -show_chapters -show_entries format_tags=title` on the source and both exports.

The throwaway test used (run from `tests/unit/`, not committed):

```ts
import { it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import type { ExportSettings, MediaItem, Rational } from '@shared/model';
import { createSequence } from '@shared/project';
import { makeClip } from '@shared/timeline';
import { runExport } from '../../electron/export/exporter';

const exec = promisify(execFile);
const F24: Rational = { num: 24, den: 1 };
async function info(file: string) {
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_chapters', '-show_entries', 'format_tags=title', file]);
  const j = JSON.parse(stdout);
  return { title: j.format?.tags?.title, chapters: j.chapters.map((c: any) => ({ start: +c.start_time, end: +c.end_time, title: c.tags?.title })) };
}

it('chapter markers vs exported chapters', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-chap-'));
  const meta = path.join(dir, 'meta.txt');
  fs.writeFileSync(meta, ';FFMETADATA1\ntitle=Source Movie Title\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=2000\ntitle=Source Ch 1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=2000\nEND=4000\ntitle=Source Ch 2\n');
  const src = path.join(dir, 'source.mkv');
  await exec('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=s=64x36:r=24:d=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4', '-i', meta,
    '-map', '0:v', '-map', '1:a', '-map_chapters', '2', '-map_metadata', '2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src]);
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', src]);
  const j = JSON.parse(stdout);
  const v = j.streams.find((x: any) => x.codec_type === 'video');
  const media = {
    id: 'm1', name: 'source.mkv', path: src, kind: 'video', category: 'Other', identity: {}, binId: null,
    probe: { container: j.format.format_name, duration: +j.format.duration, size: +j.format.size,
      video: { index: v.index, codec: v.codec_name, width: v.width, height: v.height, fps: F24, avgFps: F24, isVfr: false },
      audio: j.streams.filter((x: any) => x.codec_type === 'audio').map((x: any) => ({ index: x.index, codec: x.codec_name, channels: x.channels, layout: x.channel_layout ?? '', sampleRate: +x.sample_rate })),
      subtitles: [], startTime: +(j.format.start_time ?? 0), browserPlayable: true },
    offline: false, proxy: { status: 'none' }, detectedScenes: [], subtitleTrackIds: [], notes: '', tags: [], addedAt: 0,
  } as MediaItem;
  for (const chunked of [false, true]) {
    const s = createSequence('Chapters', F24, 64, 36);
    s.videoTracks[0].clips.push(makeClip({ mediaId: 'm1', name: 'v', sourceIn: 2, duration: 48, kind: 'video' }, 0));
    s.audioTracks[0].clips.push(makeClip({ mediaId: 'm1', name: 'a', sourceIn: 2, duration: 48, kind: 'audio' }, 0));
    s.markers.push({ id: 'k1', time: 0, duration: 0, name: 'Opening', note: '', color: 'red', kind: 'chapter' });
    s.markers.push({ id: 'k2', time: 24, duration: 0, name: 'Act Two', note: '', color: 'red', kind: 'chapter' });
    const settings = { outputDir: dir, fileName: `out-${chunked}.mp4`, width: 64, height: 36, fps: F24, videoCodec: 'libx264',
      qualityMode: 'crf', crf: 10, videoBitrateKbps: 2000, preset: 'ultrafast', audioCodec: 'aac', audioBitrateKbps: 128,
      audioChannels: 2, sampleRate: 48000, rangeMode: 'entire', burnSubtitles: false, exportSubtitleSidecar: false, useProxies: false } as ExportSettings;
    const opts = chunked ? { chunked: true, maxSegmentsPerChunk: 1, maxAudioSegmentsPerChunk: 1 } : { chunked: false };
    const res = await runExport({ sequence: s, media: { m1: media }, settings }, undefined, undefined, opts);
    console.log(chunked ? 'CHUNKED' : 'SINGLE', JSON.stringify(await info(res.outputPath)));
  }
}, 60000);
```

### Expected

Both exports carry the sequence's own chapters and nothing from the source:

```
[{"start":0,"end":1,"title":"Opening"},{"start":1,"end":2,"title":"Act Two"}]
```

No global title is inherited from a source file. If chapter export is out of scope for now, the output at least has no
chapters and no source title, and the docs say chapter markers are editor-only.

### Actual

```
SOURCE   {"title":"Source Movie Title","chapters":[{"start":0,"end":2,"title":"Source Ch 1"},{"start":2,"end":4,"title":"Source Ch 2"}]}
SINGLE   {"title":"Source Movie Title","chapters":[{"start":0,"end":1.979,"title":"Source Ch 1"}]}
CHUNKED  {"chapters":[]}
```

- The single-pass export has the source's title and a chapter named "Source Ch 1", although the exported picture is
  the source's second chapter.
- The chunked export has no chapters and no title.
- Neither has the ReCut chapter markers "Opening" and "Act Two".

### Evidence

- The output above, from FFmpeg 6.1.1 on commit b62f1fe.
- No file under `electron/export/` mentions chapters, `-map_chapters` or `-map_metadata`. Without those flags FFmpeg
  copies chapters and global metadata from the first input by default.
- The single-pass args end at `electron/export/renderGraph.ts:1085`. The chunked join is at
  `electron/export/exporter.ts:448`. Its inputs are ReCut's own chunk files, which is why it carries nothing.
- Proxies already strip both (`electron/media/proxy.ts:66`: `-map_metadata -1 -map_chapters -1`), so the pattern
  exists in the codebase.
- `docs/LIMITATIONS.md` and `docs/USER-GUIDE.md` do not say chapter markers are ignored by export.

### Suspected cause (hypothesis)

Export never sets `-map_chapters` or `-map_metadata`, so FFmpeg's defaults apply. Chapter markers were added to the
model and UI, but the export side was never built. A fix would pass `-map_metadata -1 -map_chapters -1` on both
paths, then write the sequence's chapter markers (in the export range, shifted to the range start and mapped to output
time) as an FFMETADATA input mapped with `-map_chapters`.

### Scope

- Other global tags may leak the same way (for example `comment`, `encoder`, `creation_time`, language tags). Only
  `title` was checked.
- Stream-level metadata (audio language, handler names) on the single-pass path was not checked.
- In/Out range exports and frame-rate conversion would need the chapter times shifted and mapped, as subtitles are.
- The future MKV / packaging export (ROADMAP §7; see `bugs/closed/2026-10-05-roadmap-revisions-grok-review.md`)
  depends on this.

---

## Verification

| Field | Value |
|---|---|
| Verified by / date | Claude (Claude Code session), 2026-10-05 |
| Verified on commit | ca555b5 (`origin/main`) |
| Verdict | confirmed |

Reproduced with real exports through `runExport` (FFmpeg 6.1.1-3ubuntu5, and 9.0.2 for the single pass). The source
is a 4 s 24 fps file, once as MKV and once as MP4, with:

- global tags: title, comment, artist, album, genre, date, copyright, description, creation_time, encoder, language;
- two chapters: "Source Ch 1" 0-2 s and "Source Ch 2" 2-4 s;
- stream tags: video title "Source Video Title", language fre, handler "Source Video Handler"; audio title
  "Japanese Commentary", language jpn, handler "Source Sound Handler".

The sequence has 48 frames of the source's second half and Chapter markers "Opening" @0 and "Act Two" @24. ffprobe
of the outputs:

```
SINGLE  src.mkv format tags {"major_brand":"isom","minor_version":"512","compatible_brands":"isomiso2avc1mp41",
          "title":"Source Movie Title","artist":"Source Artist","album":"Source Album","date":"1999","encoder":"Lavf60.16.100",
          "comment":"Source comment","genre":"Source Genre","copyright":"Source Copyright","description":"Source Description"}
        streams video {"language":"und","handler_name":"VideoHandler","vendor_id":"[0][0][0][0]","encoder":"Lavc60.31.102 libx264"}
                audio {"language":"und","handler_name":"SoundHandler","vendor_id":"[0][0][0][0]"}
                data  {"language":"eng","handler_name":"SubtitleHandler"}   (the MP4 chapter text track)
        chapters [{"start":0,"end":1.979,"title":"Source Ch 1"}]
SINGLE  src.mp4 same global tags; chapters [{"start":0,"end":2,"title":"Source Ch 1"}]
CHUNKED src.mkv / src.mp4 format tags {major_brand, minor_version, compatible_brands, encoder}; chapters []
FFmpeg 9.0.2 SINGLE src.mkv: same tags; chapters [{"start":0,"end":2,"title":"Source Ch 1"},{"start":2,"end":2,"title":"Source Ch 2"}]
```

What leaks (the report's open scope questions):

- **Global tags, single pass:** every free-form tag of the first input leaks, from MKV and MP4 sources alike:
  `title`, `comment`, `artist`, `album`, `genre`, `date`, `copyright` and `description`. Three do not leak:
  `creation_time` (FFmpeg drops it when copying), `encoder` (the muxer writes its own `Lavf...`) and the MKV global
  `LANGUAGE` tag (MP4 has no equivalent). The chunked export leaks no global tag, because its inputs are ReCut's own
  chunk files.
- **Source chapters, single pass:** the first input's chapters leak, clipped and shifted by FFmpeg's default chapter
  copy. That is `Source Ch 1` on 6.1, and both chapters on 9.0, with a zero-length second one. Chunked: none.
- **Stream-level tags:** none leak on either path. Every single-pass output stream is a filtergraph output (`-map
  [vout]` / `[aout]`), and FFmpeg does not copy input stream metadata to those. The source titles, languages (fre,
  jpn) and handler names do not reach the output. It carries FFmpeg's defaults: `language=und`, `VideoHandler` /
  `SoundHandler`. The chunked join maps the chunk files' streams (`-map 0:v:0`) and copied their stream tags, which
  are ReCut's own: only `encoder` and the default handler names.
- **Chapter markers:** never written on either path.

The suspected cause is right: nothing under `electron/export/` set `-map_metadata` or `-map_chapters`. The
suggested fix does not work as written, because `-map_metadata -1` also turns off the copy of chapter *metadata*. So
`-map_metadata -1 -map_chapters <ffmetadata>` writes chapters with empty titles. This was measured with FFmpeg 6.1.1,
8.1.3 and 9.0.2 (`-map_metadata -1 -map_chapters 2`, FFMETADATA as input 2). The chapters had the right times and
title `''`, and the muxer dropped the QuickTime chapter text track: reading the file back logs `Referenced QT
chapter track not found`. With `-map_metadata:g -1 -map_metadata:s -1 -map_chapters 2` the titles are kept, and no
global or stream metadata is copied.

---

## Resolution

| Field | Value |
|---|---|
| Closed by / date | Claude (Claude Code session), 2026-10-05 |
| Fix | branch `claude/export-chapters`, the commit that moves this file to `bugs/closed/` |
| Files changed | `electron/export/renderGraph.ts`, `electron/export/exporter.ts`, `tests/unit/export-chapters.test.ts` (new), `tests/unit/export-fps.test.ts`, `docs/USER-GUIDE.md`, `docs/FORMATS.md`, `docs/export-pipeline.md` |
| Regression test | `tests/unit/export-chapters.test.ts` (18 tests) |

### Root cause

Export never told FFmpeg which metadata and chapters to write, so FFmpeg's defaults applied. FFmpeg copies the
global metadata of input 0 and the chapters of the first input that has any. On the single pass, input 0 is the
first clip's source. On the chunked join, the inputs are ReCut's chunk files, which carry no chapters. Nothing turned
the sequence's Chapter markers (`MarkerKind` `'chapter'`) into anything FFmpeg reads.

### Fix

`electron/export/renderGraph.ts`:

- `outputMetadataArgs(chaptersInput)` returns `-map_metadata:g -1 -map_metadata:s -1 -map_chapters <N|-1>`: no
  global or stream metadata from any input, and chapters only from the chapters file. `-map_metadata -1` is not
  used because it also drops the chapter titles (see Verification).
- `exportChapters(seq, startF, endF, endSec)` returns the sequence's markers of kind `chapter` in `[startF, endF)`
  as `{ start, end, title }`:
  - Times are in sequence seconds from the range start, so an output frame-rate conversion does not move them.
  - The latest chapter marker at or before `startF` covers the range start. Markers at or after `endF` are dropped.
    If two are on one frame, the later one in the list wins.
  - Each chapter ends where the next one starts. The last ends at the output duration, which is the `-t` value
    (`max(durationSec, outputDurationSec)`).
  - The first chapter starts at 0. An MP4 cannot hold a gap before the first chapter: FFmpeg 6.1, 8.1 and 9.0 all
    read a first chapter written at 0.5 s back at 0. Writing 0 makes the file say what players will show.
- `ffmetadataChapters` / `ffmetadataEscape` write an FFMETADATA1 file with `TIMEBASE=1/1000000` and no global tags.
  `=`, `;`, `#`, `\`, `\n` and `\r` in values are backslash-escaped, and NULs are removed.
  - A trailing backslash is dropped. FFmpeg's reader (6.1 to 9.0) treats a line break after an escaped backslash
    as escaped. Measured: `title=trail\\` became title `trail\` plus a newline, and a following line would have
    joined the value.
- `buildRenderGraph` takes a new option `chaptersFilePath` and returns two new fields, `chapters` and
  `chaptersContent`.
  - For the whole export (not a chunk sub-range) with chapters and a path, the file is added after the media inputs
    as `-f ffmetadata -i <path>`, and `-map_chapters` names it.
  - `inputCount` and `inputArgs` still count media inputs only, so `shouldChunk` and the chunk graphs are
    unaffected.
  - Chapters without a path add a warning, as burn-in subtitles do.
  - Every graph's args include `outputMetadataArgs`, after the `-map`s.

`electron/export/exporter.ts`:

- `runExport` passes `<tmpDir>/chapters.txt` and writes `chaptersContent` there. The single pass runs the graph
  args, where `fileInputs` turns the new `-i` into a `file:` URL like every other input.
- Chunked export: each video and audio chunk encode passes `outputMetadataArgs(null)`. The join adds the chapters
  file as input 2 (`-f ffmetadata -i file:...`) with `outputMetadataArgs(2)`, or uses `outputMetadataArgs(null)`
  when there are no chapters. The join writes exactly the single pass's chapters.
- `buildExportCommand` (the dialog's **Show FFmpeg command**) passes a preview chapters path,
  `os.tmpdir()/recut-export/chapters.txt`, as it already does for the burn-in SRT. The preview shows the chapters
  input and `-map_chapters` as the export runs them.

FFmpeg 6/7/8/9 compatibility: `-map_metadata[:spec]`, `-map_chapters` and `-f ffmetadata` work the same in all of
them. `adaptFfmpegArgs` only rewrites `-filter_complex_script` / `-filter_script`, so it leaves the new args alone.
The new test passes on 6.1.1, 8.1.3 and 9.0.2.

### Before / after

Same source and sequence as in Verification:

| | Before | After |
|---|---|---|
| Single pass, global tags | source title, comment, artist, album, genre, date, copyright, description | `major_brand`, `minor_version`, `compatible_brands`, `encoder` (muxer) only |
| Single pass, chapters | `Source Ch 1` 0-1.979 s | `Opening` 0-1 s, `Act Two` 1-2 s |
| Chunked, chapters | none | `Opening` 0-1 s, `Act Two` 1-2 s |
| Stream tags | FFmpeg defaults (no leak) | unchanged; the chunked join no longer copies the chunk files' stream `encoder` tag |
| No chapter markers | source chapters (single pass) | no chapters and no chapter text track |

### Regression test proof

`tests/unit/export-chapters.test.ts` runs real FFmpeg and ffprobe on a tagged 64x36 source (MKV and MP4):

- **Nothing from the sources (4 tests):** single and chunked, MKV and MP4 source, no chapter markers (only `marker`
  and `continuity` kinds). Checked: no source string in any global, stream or chapter tag; global tags are only the
  muxer's; streams have no `title` or `creation_time`; handler names are FFmpeg's defaults and language is `und`;
  there are no chapters; the output has only a video and an audio stream.
- **Chapters, each case single and chunked (8 tests):**
  - whole sequence: markers out of list order, with a `marker` and a `continuity` marker in between; the last
    chapter ends at the output duration;
  - In/Out 30-78 with markers @6, @18 (covers In), @48, @78 (at Out) and @84: gives `Covers In` 0-0.75 and
    `Middle` 0.75-2;
  - 24 → 30 fps conversion over 47 frames: `A` 0-0.5, `B` 0.5-1.5, `C` 1.5-1.967 (= 59/30 s);
  - names `a=b; c #d`, `back\slash`, `two\nlines`, `☃ 日本語 ü`, `;starts like a comment`, `#hash`, `[CHAPTER]` and
    `trail\` (written as `trail`).
- **Other real exports (3 tests):** single pass and chunked give identical chapters; a first chapter marker at
  0.5 s starts at 0; chapter markers only outside In/Out give no chapters.
- **Pure (3 tests):**
  - `exportChapters`: range, kinds, covering marker, duplicates;
  - `ffmetadataEscape` / `ffmetadataChapters`: exact text;
  - graph args: the chapters input comes after the media inputs with `-map_chapters <inputCount>`; a warning without
    a path; no chapters in a chunk graph; the **Show command** preview.

Failing before: the test file on `ca555b5`'s `electron/` with FFmpeg 6.1.1 gives 16 failed, 2 passed. The 2 that
pass are the "nothing from the sources" tests for the chunked path, which never leaked; they are kept as guards.

```
 × ... nothing is copied from the sources > single, mkv source ...
   AssertionError: source string Source in the export: expected '{"format":{"major_brand":"isom","mino…' not to contain 'Source'
 × ... nothing is copied from the sources > single, mp4 source ...           (same)
 ✓ ... nothing is copied from the sources > chunked, mkv source ...
 ✓ ... nothing is copied from the sources > chunked, mp4 source ...
 × ... whole sequence (single)      expected [ [ +0, 2.021, 'Source Ch 1' ], …(1) ] to deeply equal [ [ +0, 1, 'Opening' ], …(2) ]
 × ... In/Out range (single)        expected [ [ +0, 1.979, 'Source Ch 1' ] ] to deeply equal [ [ +0, 0.75, 'Covers In' ], …(1) ]
 × ... frame-rate conversion (single) expected [ [ +0, 1.946, 'Source Ch 1' ] ] to deeply equal [ [ +0, 0.5, 'A' ], …(2) ]
 × ... special characters (single)  expected [ 'Source Ch 1' ] to deeply equal [ 'a=b; c #d', 'back\slash', …(6) ]
 × ... whole sequence (chunked)     expected [] to deeply equal [ [ +0, 1, 'Opening' ], …(2) ]
 × ... In/Out range (chunked)       expected [] to deeply equal [ [ +0, 0.75, 'Covers In' ], …(1) ]
 × ... frame-rate conversion (chunked) expected [] to deeply equal [ [ +0, 0.5, 'A' ], …(2) ]
 × ... special characters (chunked) expected [] to deeply equal [ 'a=b; c #d', 'back\slash', …(6) ]
 × ... single pass and chunked export write identical chapters   expected [] to deeply equal [ …(2) ]
 × ... first chapter marker after the start   expected [ [ +0, 1.979, 'Source Ch 1' ] ] to deeply equal [ [ +0, 2, 'Late' ] ]
 × ... only outside the In/Out range: no chapters   expected [ { start: +0, end: 1.979, …(1) } ] to deeply equal []
 × ... exportChapters ...           TypeError: exportChapters is not a function
 × ... ffmetadataEscape ...         TypeError: ffmetadataEscape is not a function
 × ... args: chapters file ...      AssertionError: expected undefined to deeply equal [ { start: +0, end: 1, …(1) }, …(1) ]
 Tests  16 failed | 2 passed (18)
```

Passing after: `Tests  18 passed (18)` on FFmpeg 6.1.1-3ubuntu5, n8.1.3 and n9.0.2 (`RECUT_FFMPEG` /
`RECUT_FFPROBE`).

### Tests run

Linux container, FFmpeg 6.1.1-3ubuntu5 unless stated:

- `npm run typecheck`: clean.
- `npm test`: 976/976 passed, 43/43 files (includes the 18 new tests).
- `npx vitest run -c tests/attack/vitest.config.ts tests/attack/exportgraph.test.ts`: 12/12 passed.
- `tests/unit/export-chapters.test.ts` with FFmpeg n8.1.3 and n9.0.2: 18/18 on each.
- `tests/unit/export*.test.ts` (8 files) with FFmpeg n8.1.3 and n9.0.2: 170/170 on each.

### Changed existing assertions

- `tests/unit/export-fps.test.ts` `BEFORE_ARGS` pins the exact single-pass args at equal and invalid rates. The
  literal gains `'-map_metadata:g', '-1', '-map_metadata:s', '-1', '-map_chapters', '-1'` after `'-map', '[aout]'`.
  It pinned the args without them, which left FFmpeg's defaults in force: copy the first source's metadata and
  chapters. The filter graph and every other arg are unchanged.

### Compatibility risks

- Exports no longer carry the first source's title, comment, artist, album, genre, date, copyright, description or
  chapters. This is intended: those described the source film, not the edit. A user who relied on them can add tags
  with another tool.
- Exports with Chapter markers in the range now have chapters. The MP4 muxer stores them as a `chpl` atom plus a
  QuickTime chapter text track. ffprobe lists that track as a `data` stream (`bin_data`, `language=eng`,
  `handler_name=SubtitleHandler`), with tags set by the muxer. ReCut's probe ignores `data` streams, so
  re-importing an export is unaffected. Without chapter markers the output has only the video and audio streams, as
  before.
- In chunked exports, the video stream no longer has the `encoder` stream tag copied from the chunk file. The tag is
  informational only; the single pass still gets the encoder's own tag.
- A chapter name ending in a backslash loses that backslash. A first chapter marker after the range start is
  written from 0.
- No effect on saved projects, frame counts, timing, audio or subtitles: `BEFORE_FILTER` and all other args are
  unchanged.

### Follow-ups

None filed. Two things were found but are out of scope:

- The trailing-backslash case is a limitation of FFmpeg's FFMETADATA reader, not a ReCut defect: `ffmetadec.c`
  checks the previous raw byte, not the escape state.
- A marker's `duration` is not used for the chapter end; chapters run to the next chapter, as MP4 chapters do. A
  future MKV export (ROADMAP §7) could use it.
