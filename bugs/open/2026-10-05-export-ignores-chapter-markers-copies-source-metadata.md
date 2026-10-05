# Export ignores chapter markers and copies the first source's chapters and title

| Field | Value |
|---|---|
| Status | open |
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
- The future MKV / packaging export (see `bugs/open/2026-10-05-roadmap-revisions-grok-review.md`) depends on this.

---

## Verification
<!-- Filled in by whoever works the bug. -->

| Field | Value |
|---|---|
| Verified by / date | |
| Verified on commit | |
| Verdict | |

---

## Resolution
<!-- Required before moving the file to bugs/closed/. -->

| Field | Value |
|---|---|
| Closed by / date | |
| Fix | |
| Files changed | |
| Regression test | |

### Root cause

### Fix

### Before / after

### Regression test proof

### Tests run

### Changed existing assertions

### Compatibility risks

### Follow-ups
