/**
 * Export metadata and chapters (bugs/closed/2026-10-05-export-ignores-chapter-markers-copies-source-metadata.md @ 59eafc6),
 * measured on real FFmpeg exports with ffprobe:
 * - nothing from the sources reaches the output: no global tags (title, comment, artist, ...), no chapters, no
 *   stream titles / handler names / languages, in a single-pass or a chunked export;
 * - the sequence's Chapter markers (kind 'chapter' only) are the output's chapters: names (FFMETADATA-escaped),
 *   times relative to the export range, unaffected by output frame-rate conversion, identical single-pass and
 *   chunked; no chapter markers, no chapters; when no chapter marker is at or before the range start, an untitled
 *   leading chapter keeps the first break (bugs/closed/2026-10-06-first-chapter-break-lost-and-stale-roadmap.md @ 59eafc6).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExportSettings, Marker, MediaItem, MediaProbe, Rational, Sequence } from '@shared/model';
import type { ExportRequest } from '@shared/ipc';
import { createSequence } from '@shared/project';
import { makeClip } from '@shared/timeline';
import { buildRenderGraph, exportChapters, ffmetadataChapters, ffmetadataEscape } from '../../electron/export/renderGraph';
import { buildExportCommand, runExport } from '../../electron/export/exporter';

const exec = promisify(execFile);
const FFMPEG = process.env.RECUT_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.RECUT_FFPROBE || 'ffprobe';
const F24: Rational = { num: 24, den: 1 };
const F30: Rational = { num: 30, den: 1 };

let dir: string;
let mkv: MediaItem;
let mp4: MediaItem;
let outN = 0;

/** Every source string the tagged media carries; none may appear in an export. */
const SOURCE_STRINGS = ['Source', 'jpn', 'fre', '1999', '2001-02-03', 'Japanese Commentary'];

const SOURCE_META = [
  ';FFMETADATA1', 'title=Source Movie Title', 'comment=Source comment', 'artist=Source Artist', 'album=Source Album',
  'genre=Source Genre', 'date=1999', 'copyright=Source Copyright', 'description=Source Description',
  'creation_time=2001-02-03T04:05:06.000000Z', 'encoder=Source Encoder 1.0', 'language=jpn',
  '[CHAPTER]', 'TIMEBASE=1/1000', 'START=0', 'END=2000', 'title=Source Ch 1',
  '[CHAPTER]', 'TIMEBASE=1/1000', 'START=2000', 'END=4000', 'title=Source Ch 2', '',
].join('\n');

async function probe(file: string): Promise<MediaProbe> {
  const { stdout } = await exec(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const j = JSON.parse(stdout);
  const v = j.streams.find((s: any) => s.codec_type === 'video');
  return {
    container: j.format.format_name, duration: Number(j.format.duration), size: Number(j.format.size),
    video: { index: v.index, codec: v.codec_name, width: v.width, height: v.height, fps: F24, avgFps: F24, isVfr: false },
    audio: j.streams.filter((s: any) => s.codec_type === 'audio').map((s: any) => ({
      index: s.index, codec: s.codec_name, channels: s.channels, layout: s.channel_layout ?? '', sampleRate: Number(s.sample_rate),
    })),
    subtitles: [], startTime: Number(j.format.start_time ?? 0), browserPlayable: true,
  };
}

async function mediaItem(id: string, file: string): Promise<MediaItem> {
  return {
    id, name: path.basename(file), path: file, kind: 'video', category: 'Other', identity: {}, binId: null,
    probe: await probe(file), offline: false, proxy: { status: 'none' }, detectedScenes: [], subtitleTrackIds: [],
    notes: '', tags: [], addedAt: 0,
  };
}

interface OutInfo {
  formatTags: Record<string, string>;
  duration: number;
  streams: { type: string; tags: Record<string, string> }[];
  chapters: { start: number; end: number; title: string | undefined }[];
}

async function info(file: string): Promise<OutInfo> {
  const { stdout } = await exec(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_chapters', '-show_format', '-show_streams', file]);
  const j = JSON.parse(stdout);
  return {
    formatTags: j.format.tags ?? {},
    duration: Number(j.format.duration),
    streams: j.streams.map((s: any) => ({ type: s.codec_type, tags: s.tags ?? {} })),
    chapters: j.chapters.map((c: any) => ({ start: Number(c.start_time), end: Number(c.end_time), title: c.tags?.title })),
  };
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-chapters-'));
  const meta = path.join(dir, 'source-meta.txt');
  fs.writeFileSync(meta, SOURCE_META);
  const mkvPath = path.join(dir, 'tagged.mkv');
  await exec(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=s=64x36:r=24:d=4', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4', '-i', meta,
    '-map', '0:v', '-map', '1:a', '-map_metadata', '2', '-map_chapters', '2',
    '-metadata:s:v:0', 'title=Source Video Title', '-metadata:s:v:0', 'language=fre', '-metadata:s:v:0', 'handler_name=Source Video Handler',
    '-metadata:s:a:0', 'title=Japanese Commentary', '-metadata:s:a:0', 'language=jpn', '-metadata:s:a:0', 'handler_name=Source Sound Handler',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '12', '-c:a', 'aac', '-shortest', mkvPath]);
  const mp4Path = path.join(dir, 'tagged.mp4');
  await exec(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', mkvPath, '-map', '0', '-c', 'copy', '-map_metadata', '0', '-map_chapters', '0', mp4Path]);
  mkv = await mediaItem('mkv', mkvPath);
  mp4 = await mediaItem('mp4', mp4Path);
}, 60_000);

afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

function marker(time: number, name: string, kind: Marker['kind'] = 'chapter'): Marker {
  return { id: `mk_${time}_${kind}_${name.length}`, time, duration: 0, name, note: '', color: 'red', kind };
}

/** Linked V+A clips from `m`, back to back from frame 0: [sourceIn seconds, frames] each. */
function seqWith(m: MediaItem, clips: [number, number][], markers: Marker[] = [], fps: Rational = F24): Sequence {
  const s = createSequence('Chapters', fps, 64, 36);
  let t = 0;
  for (const [srcIn, frames] of clips) {
    s.videoTracks[0].clips.push(makeClip({ mediaId: m.id, name: 'v', sourceIn: srcIn, duration: frames, kind: 'video' }, t));
    s.audioTracks[0].clips.push(makeClip({ mediaId: m.id, name: 'a', sourceIn: srcIn, duration: frames, kind: 'audio' }, t));
    t += frames;
  }
  s.markers.push(...markers);
  return s;
}

function request(s: Sequence, m: MediaItem, over: Partial<ExportSettings> = {}): ExportRequest {
  const settings = {
    outputDir: dir, fileName: `out-${++outN}.mp4`, width: 64, height: 36, fps: F24, videoCodec: 'libx264',
    qualityMode: 'crf', crf: 18, videoBitrateKbps: 2000, preset: 'ultrafast', audioCodec: 'aac', audioBitrateKbps: 128,
    audioChannels: 2, sampleRate: 48000, rangeMode: 'entire', burnSubtitles: false, exportSubtitleSidecar: false, useProxies: false,
    ...over,
  } as ExportSettings;
  return { sequence: s, media: { [m.id]: m }, settings };
}

type Mode = 'single' | 'chunked';
const MODES: Mode[] = ['single', 'chunked'];

async function exportInfo(req: ExportRequest, mode: Mode): Promise<OutInfo & { chunks: number }> {
  const opts = mode === 'chunked' ? { chunked: true, maxSegmentsPerChunk: 1, maxAudioSegmentsPerChunk: 1 } : { chunked: false };
  const res = await runExport(req, undefined, undefined, opts);
  return { ...(await info(res.outputPath)), chunks: res.chunks };
}

/** Chapters as [start, end, title] with times rounded to the millisecond (MP4 chapter tracks store milliseconds). */
function chapterRows(i: OutInfo): [number, number, string | undefined][] {
  return i.chapters.map((c) => [Math.round(c.start * 1000) / 1000, Math.round(c.end * 1000) / 1000, c.title]);
}

function expectNothingFromSources(i: OutInfo): void {
  const all = JSON.stringify({ format: i.formatTags, streams: i.streams.map((s) => s.tags), chapters: i.chapters });
  for (const s of SOURCE_STRINGS) expect(all, `source string ${s} in the export`).not.toContain(s);
  // Global tags: only what the MP4 muxer itself writes.
  expect(Object.keys(i.formatTags).sort().filter((k) => !['major_brand', 'minor_version', 'compatible_brands', 'encoder'].includes(k))).toEqual([]);
  expect(i.formatTags.encoder ?? 'Lavf').toMatch(/^Lavf/);
  for (const st of i.streams.filter((x) => x.type === 'video' || x.type === 'audio')) {
    expect(st.tags.title, `${st.type} stream title`).toBeUndefined();
    expect(st.tags.creation_time, `${st.type} stream creation_time`).toBeUndefined();
    // FFmpeg's own defaults, not the source's handler names / languages.
    expect(st.tags.handler_name ?? '').toMatch(st.type === 'video' ? /^(VideoHandler)?$/ : /^(SoundHandler)?$/);
    expect(st.tags.language ?? 'und').toBe('und');
  }
}

describe('export metadata: nothing is copied from the sources', () => {
  for (const mode of MODES) {
    for (const src of ['mkv', 'mp4'] as const) {
      it(`${mode}, ${src} source with title / comment / chapters / stream tags, no chapter markers`, async () => {
        const m = src === 'mkv' ? mkv : mp4;
        // The second half of the source (its "Source Ch 2"), then the first; markers that are not chapters.
        const s = seqWith(m, [[2, 24], [0.5, 24]], [marker(6, 'Note', 'marker'), marker(30, 'Wardrobe', 'continuity')]);
        const out = await exportInfo(request(s, m), mode);
        if (mode === 'chunked') expect(out.chunks).toBeGreaterThan(1);
        expectNothingFromSources(out);
        expect(out.chapters).toEqual([]);
        // No chapters, so no chapter text track either: just the video and audio streams.
        expect(out.streams.map((x) => x.type)).toEqual(['video', 'audio']);
      });
    }
  }
});

describe('export chapters: the sequence Chapter markers', () => {
  // Out of order on purpose; 'marker' and 'continuity' kinds are not chapters.
  const wholeMarkers = () => [
    marker(72, 'Finale'), marker(0, 'Opening'), marker(36, 'Not a chapter', 'marker'),
    marker(24, 'Act Two'), marker(60, 'Continuity note', 'continuity'),
  ];
  const WHOLE = [[0, 1, 'Opening'], [1, 3, 'Act Two'], [3, 4, 'Finale']];

  for (const mode of MODES) {
    it(`whole sequence (${mode}): names and times, last chapter ends at the output duration`, async () => {
      const s = seqWith(mkv, [[2, 48], [0, 48]], wholeMarkers());
      const out = await exportInfo(request(s, mkv), mode);
      if (mode === 'chunked') expect(out.chunks).toBeGreaterThan(1);
      expect(chapterRows(out)).toEqual(WHOLE);
      expectNothingFromSources(out);
      expect(Math.abs(out.chapters[out.chapters.length - 1].end - out.duration)).toBeLessThan(0.05);
    });

    it(`In/Out range (${mode}): outside markers dropped, times from In, the chapter covering In starts at 0`, async () => {
      const s = seqWith(mkv, [[0, 48], [2, 48]], [
        marker(6, 'Before'), marker(18, 'Covers In'), marker(48, 'Middle'), marker(78, 'At Out'), marker(84, 'Outside'),
      ]);
      s.view.inPoint = 30;
      s.view.outPoint = 78;
      const out = await exportInfo(request(s, mkv, { rangeMode: 'inOut' }), mode);
      expect(chapterRows(out)).toEqual([[0, 0.75, 'Covers In'], [0.75, 2, 'Middle']]);
      expectNothingFromSources(out);
    });

    it(`output frame-rate conversion 24 -> 30 (${mode}): chapter times are sequence seconds`, async () => {
      const s = seqWith(mkv, [[0, 23], [2, 24]], [marker(0, 'A'), marker(12, 'B'), marker(36, 'C')]);
      const out = await exportInfo(request(s, mkv, { fps: F30 }), mode);
      // 47 frames at 24 fps = 1.958333 s; 59 output frames at 30 fps = 1.966667 s (the output duration).
      expect(chapterRows(out)).toEqual([[0, 0.5, 'A'], [0.5, 1.5, 'B'], [1.5, 1.967, 'C']]);
    });

    it(`special characters in names are escaped for FFMETADATA (${mode})`, async () => {
      const names = ['a=b; c #d', 'back\\slash', 'two\nlines', '☃ 日本語 ü', ';starts like a comment', '#hash', '[CHAPTER]', 'trail\\'];
      const s = seqWith(mkv, [[0, 24], [2, 24]], names.map((n, i) => marker(i * 6, n)));
      const out = await exportInfo(request(s, mkv), mode);
      // A trailing backslash cannot be written (FFmpeg's FFMETADATA reader); it is dropped.
      expect(out.chapters.map((c) => c.title)).toEqual([...names.slice(0, -1), 'trail']);
      expect(chapterRows(out).map((r) => r[0])).toEqual(names.map((_, i) => i * 0.25));
    });
  }

  it('single pass and chunked export write identical chapters', async () => {
    const s = seqWith(mkv, [[2, 48], [0, 48]], wholeMarkers());
    const a = await exportInfo(request(s, mkv), 'single');
    const b = await exportInfo(request(s, mkv), 'chunked');
    expect(b.chunks).toBeGreaterThan(1);
    expect(b.chapters).toEqual(a.chapters);
  });

  // bugs/closed/2026-10-06-first-chapter-break-lost-and-stale-roadmap.md @ 59eafc6: when no chapter marker is at or before the
  // range start, an untitled leading chapter runs from 0 to the first marker, so the first break is kept.
  for (const mode of MODES) {
    it(`a single chapter marker mid-sequence (${mode}): an untitled leading chapter, then the marker's chapter`, async () => {
      const s = seqWith(mkv, [[0, 24], [2, 24]], [marker(12, 'Late')]);
      const out = await exportInfo(request(s, mkv), mode);
      if (mode === 'chunked') expect(out.chunks).toBeGreaterThan(1);
      expect(chapterRows(out)).toEqual([[0, 0.5, ''], [0.5, 2, 'Late']]);
      expectNothingFromSources(out);
    });

    it(`In/Out range, no chapter marker at or before In (${mode}): untitled leading chapter from In`, async () => {
      const s = seqWith(mkv, [[0, 48], [2, 48]], [
        marker(84, 'Outside'), marker(60, 'Inside B'), marker(42, 'Inside A'), marker(78, 'At Out'), marker(20, 'Note', 'marker'),
      ]);
      s.view.inPoint = 30;
      s.view.outPoint = 78;
      const out = await exportInfo(request(s, mkv, { rangeMode: 'inOut' }), mode);
      if (mode === 'chunked') expect(out.chunks).toBeGreaterThan(1);
      expect(chapterRows(out)).toEqual([[0, 0.5, ''], [0.5, 1.25, 'Inside A'], [1.25, 2, 'Inside B']]);
    });

    it(`In/Out range, first chapter marker exactly at In (${mode}): no leading chapter`, async () => {
      const s = seqWith(mkv, [[0, 48], [2, 48]], [marker(30, 'At In'), marker(54, 'Next')]);
      s.view.inPoint = 30;
      s.view.outPoint = 78;
      const out = await exportInfo(request(s, mkv, { rangeMode: 'inOut' }), mode);
      expect(chapterRows(out)).toEqual([[0, 1, 'At In'], [1, 2, 'Next']]);
    });
  }

  it('an untitled leading chapter: single pass and chunked export write identical chapters', async () => {
    const s = seqWith(mkv, [[0, 24], [2, 24]], [marker(30, 'Second'), marker(6, 'First')]);
    const a = await exportInfo(request(s, mkv), 'single');
    const b = await exportInfo(request(s, mkv), 'chunked');
    expect(b.chunks).toBeGreaterThan(1);
    expect(chapterRows(a)).toEqual([[0, 0.25, ''], [0.25, 1.25, 'First'], [1.25, 2, 'Second']]);
    expect(b.chapters).toEqual(a.chapters);
  });

  // A one-frame leading chapter survives the MP4 round trip: FFmpeg 6.1 and 8.1 read MP4 chapter times back in
  // milliseconds (1/23.976 s -> 0.042), 9.0 at full precision; it is neither dropped nor merged.
  const FPS_CASES: [string, Rational][] = [['23.976', { num: 24000, den: 1001 }], ['24', F24], ['30', F30]];
  for (const [label, fps] of FPS_CASES) {
    it(`first chapter marker one frame after the start at ${label} fps: a one-frame leading chapter`, async () => {
      const s = seqWith(mkv, [[0, 24], [2, 24]], [marker(1, 'One frame in')], fps);
      const out = await exportInfo(request(s, mkv, { fps }), 'single');
      const frame = fps.den / fps.num;
      expect(out.chapters.map((c) => c.title)).toEqual(['', 'One frame in']);
      expect(out.chapters[0].start).toBe(0);
      expect(Math.abs(out.chapters[0].end - frame)).toBeLessThan(0.001);
      expect(Math.abs(out.chapters[1].start - frame)).toBeLessThan(0.001);
      expect(out.chapters[1].start).toBe(out.chapters[0].end);
      expect(Math.abs(out.chapters[1].end - out.duration)).toBeLessThan(0.05);
    });
  }

  it('chapter markers only outside the In/Out range: no chapters', async () => {
    const s = seqWith(mkv, [[0, 48], [2, 48]], [marker(84, 'Outside'), marker(78, 'At Out')]);
    s.view.inPoint = 30;
    s.view.outPoint = 78;
    const out = await exportInfo(request(s, mkv, { rangeMode: 'inOut' }), 'single');
    expect(out.chapters).toEqual([]);
    expect(out.streams.map((x) => x.type)).toEqual(['video', 'audio']);
  });
});

describe('export chapters: graph and FFMETADATA (pure)', () => {
  it('exportChapters: range, kinds, covering marker, duplicates, end', () => {
    const seq = { fps: F24, markers: [
      marker(0, 'Start'), marker(10, 'Covers'), marker(10, 'Covers (later in the list)'), marker(40, 'Mid'),
      marker(40, 'Mid wins'), marker(20, 'Note', 'marker'), marker(30, 'Cont', 'continuity'), marker(100, 'Out'),
    ] };
    expect(exportChapters(seq, 12, 100, 3.5)).toEqual([
      { start: 0, end: 28 / 24, title: 'Covers (later in the list)' },
      { start: 28 / 24, end: 3.5, title: 'Mid wins' },
    ]);
    expect(exportChapters({ fps: F24, markers: [marker(5, 'x', 'marker')] }, 0, 48, 2)).toEqual([]);
    expect(exportChapters({ fps: F24, markers: [marker(48, 'At end')] }, 0, 48, 2)).toEqual([]);
    expect(exportChapters({ fps: F24, markers: [] }, 0, 48, 2)).toEqual([]);
  });

  it('exportChapters: an untitled leading chapter only when no chapter marker is at or before the range start', () => {
    const at = (markers: Marker[], startF = 0, endF = 48) => exportChapters({ fps: F24, markers }, startF, endF, (endF - startF) / 24);
    // First marker after the start: leading chapter from 0 to it.
    expect(at([marker(12, 'Late')])).toEqual([{ start: 0, end: 0.5, title: '' }, { start: 0.5, end: 2, title: 'Late' }]);
    // Exactly at the start, or before it and still current: no leading chapter.
    expect(at([marker(0, 'Start')])).toEqual([{ start: 0, end: 2, title: 'Start' }]);
    expect(at([marker(12, 'At In')], 12, 48)).toEqual([{ start: 0, end: 1.5, title: 'At In' }]);
    expect(at([marker(3, 'Before In'), marker(24, 'Mid')], 12, 48)).toEqual([
      { start: 0, end: 0.5, title: 'Before In' }, { start: 0.5, end: 1.5, title: 'Mid' },
    ]);
    // One frame after the start: a one-frame leading chapter.
    expect(at([marker(13, 'One frame in')], 12, 48)).toEqual([
      { start: 0, end: 1 / 24, title: '' }, { start: 1 / 24, end: 1.5, title: 'One frame in' },
    ]);
    // Same-frame rule after a leading chapter: the later marker in the list wins.
    expect(at([marker(24, 'first'), marker(24, 'second')])).toEqual([
      { start: 0, end: 1, title: '' }, { start: 1, end: 2, title: 'second' },
    ]);
    // Frame-rate independent: sequence seconds at 30 fps.
    expect(exportChapters({ fps: F30, markers: [marker(45, 'B')] }, 15, 75, 2.0)).toEqual([
      { start: 0, end: 1, title: '' }, { start: 1, end: 2, title: 'B' },
    ]);
    // Only markers at or after the range end, or none: no chapters, no leading chapter.
    expect(at([marker(60, 'After')])).toEqual([]);
    expect(at([marker(10, 'Note', 'marker')])).toEqual([]);
  });

  it('ffmetadataEscape / ffmetadataChapters', () => {
    expect(ffmetadataEscape('a=b;c#d\\e\nf\rg\0h\\\\')).toBe('a\\=b\\;c\\#d\\\\e\\\nf\\\rgh');
    expect(ffmetadataChapters([{ start: 0, end: 1.5, title: 'A=B' }, { start: 1.5, end: 2, title: '' }])).toBe(
      ';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000000\nSTART=0\nEND=1500000\ntitle=A\\=B\n'
      + '[CHAPTER]\nTIMEBASE=1/1000000\nSTART=1500000\nEND=2000000\ntitle=\n');
  });

  it('args: chapters file is the last input and the only metadata source; preview shows it', () => {
    const s = seqWith(mkv, [[0, 48]], [marker(0, 'One'), marker(24, 'Two')]);
    const req = request(s, mkv);
    const g = buildRenderGraph(req, { chaptersFilePath: '/tmp/x/chapters.txt' });
    expect(g.chapters).toEqual([{ start: 0, end: 1, title: 'One' }, { start: 1, end: 2, title: 'Two' }]);
    expect(g.chaptersContent).toBe(ffmetadataChapters(g.chapters));
    const at = g.args.indexOf('ffmetadata');
    expect(g.args.slice(at - 1, at + 3)).toEqual(['-f', 'ffmetadata', '-i', '/tmp/x/chapters.txt']);
    expect(g.args.slice(3, at - 1)).toEqual(g.inputArgs);
    const meta = g.args.indexOf('-map_metadata:g');
    expect(g.args.slice(meta, meta + 6)).toEqual(['-map_metadata:g', '-1', '-map_metadata:s', '-1', '-map_chapters', String(g.inputCount)]);
    expect(g.warnings).toEqual([]);
    // Without a chapters file path: no chapters input, a warning.
    const g2 = buildRenderGraph(req);
    expect(g2.args).not.toContain('ffmetadata');
    expect(g2.args.slice(g2.args.indexOf('-map_chapters'), g2.args.indexOf('-map_chapters') + 2)).toEqual(['-map_chapters', '-1']);
    expect(g2.warnings.join(' ')).toMatch(/chapters/i);
    // A chunk graph never carries chapters.
    const g3 = buildRenderGraph(req, { chaptersFilePath: '/tmp/x/chapters.txt', range: { startF: 0, endF: 24 }, streams: 'video' });
    expect(g3.chapters).toEqual([]);
    expect(g3.args).not.toContain('ffmetadata');
    // The "Show command" preview.
    const cmd = buildExportCommand(req);
    expect(cmd).toContain('ffmetadata');
    expect(cmd[cmd.indexOf('-map_chapters') + 1]).toBe(String(g.inputCount));
    // No chapter markers: no chapters input, chapters and metadata disabled, no warning.
    const plain = buildRenderGraph(request(seqWith(mkv, [[0, 48]], [marker(0, 'n', 'marker')]), mkv), { chaptersFilePath: '/tmp/x/chapters.txt' });
    expect(plain.args).not.toContain('ffmetadata');
    expect(plain.chaptersContent).toBeUndefined();
    const pm = plain.args.indexOf('-map_metadata:g');
    expect(plain.args.slice(pm, pm + 6)).toEqual(['-map_metadata:g', '-1', '-map_metadata:s', '-1', '-map_chapters', '-1']);
    expect(plain.warnings).toEqual([]);
  });
});
