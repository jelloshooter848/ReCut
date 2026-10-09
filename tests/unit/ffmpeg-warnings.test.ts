/**
 * FFmpeg stderr classifier and source warning texts (electron/export/ffmpegWarnings.ts). The samples are real
 * FFmpeg output: FFmpeg 6.1.1 reading the truncated / damaged files of tests/unit/export-source-problems.test.ts at
 * `-loglevel warning`, plus the FFmpeg <= 6.0 and 7.1 spellings of the same messages.
 */
import { describe, it, expect } from 'vitest';
import type { MediaItem, MediaProbe } from '@shared/model';
import {
  classifyFfmpegLine, exportSourceWarnings, ffmpegInputPaths, ffmpegProblems, FfmpegProblemCollector, MAX_PROBLEMS_PER_RUN, MAX_SOURCE_WARNINGS,
  packetDataEnd, planSourceEndChecks, type FfmpegRunProblems, type SourceEndResult,
} from '../../electron/export/ffmpegWarnings';

// FFmpeg 6.1.1, a faststart MP4 cut to half its bytes, read past the cut (exit 0).
const TRUNCATED_MP4 = `[mov,mp4,m4a,3gp,3g2,mj2 @ 0x5605d27e0dc0] Packet corrupt (stream = 0, dts = 60928).
[NULL @ 0x5605d27e1640] Invalid NAL unit size (3011 > 1901).
[NULL @ 0x5605d27e1640] missing picture in access unit with size 1905
[in#0/mov,mp4,m4a,3gp,3g2,mj2 @ 0x5605d27e0cc0] corrupt input packet in stream 0
[mov,mp4,m4a,3gp,3g2,mj2 @ 0x5605d27e0dc0] stream 0, offset 0x7f2d6: partial file
[h264 @ 0x5605d2800fc0] Invalid NAL unit size (3011 > 1901).
[h264 @ 0x5605d2800fc0] Error splitting the input into NAL units.
[mov,mp4,m4a,3gp,3g2,mj2 @ 0x5605d28b5bc0] stream 1, offset 0x7f15c: partial file
[vist#0:0/h264 @ 0x5605d2884180] Decoding error: Invalid data found when processing input`.split('\n');

// FFmpeg 6.1.1, an MKV cut to half its bytes, two inputs on it (exit 0).
const TRUNCATED_MKV = `[matroska,webm @ 0x561cfac66dc0] File ended prematurely
    Last message repeated 2 times
[matroska,webm @ 0x561cfacb73c0] File ended prematurely
    Last message repeated 2 times
[matroska,webm @ 0x561cfac66dc0] File ended prematurely
[matroska,webm @ 0x561cfacb73c0] File ended prematurely`.split('\n');

// FFmpeg 6.1.1, an MP4 with 40 kB of garbage in the middle (exit 0); an excerpt.
const CORRUPT_MP4 = `[NULL @ 0x55b2d2ab2a40] Invalid NAL unit size (1515870810 > 4525).
[NULL @ 0x55b2d2ab2a40] missing picture in access unit with size 4529
[h264 @ 0x55b2d2ab81c0] Invalid NAL unit size (1515870810 > 4525).
[h264 @ 0x55b2d2ab81c0] Error splitting the input into NAL units.
[aac @ 0x55b2d2b05a80] Gain control is not implemented. Update your FFmpeg version to the newest one from Git. If the problem still occurs, it means that your file has a feature which has not been implemented.
[aac @ 0x55b2d2b05a80] Input buffer exhausted before END element found
[aist#1:1/aac @ 0x55b2d2b05740] Error submitting packet to decoder: Invalid data found when processing input
[aac @ 0x55b2d2b05a80] channel element 2.13 is not allocated
[aist#1:1/aac @ 0x55b2d2b05740] Error submitting packet to decoder: Invalid data found when processing input`.split('\n');

// FFmpeg 6.1.1, an MKV with garbage in the middle (exit 0).
const CORRUPT_MKV = '[matroska,webm @ 0x55bbd693d900] 0x00 at pos 457210 (0x6f9fa) invalid as first byte of an EBML number';

// FFmpeg 6.1.1, an MP4 cut before its moov atom (exit 1; the export fails anyway).
const NO_MOOV = `[mov,mp4,m4a,3gp,3g2,mj2 @ 0x55a0d543e940] moov atom not found
[in#0 @ 0x55a0d543e840] Error opening input: Invalid data found when processing input`.split('\n');

// Harmless lines that must never become warnings.
const HARMLESS = [
  '[swscaler @ 0x55d3c1a0b2c0] deprecated pixel format used, make sure you did set range correctly',
  '[aist#0:1/pcm_s16le @ 0x5581f1f8a440] Guessed Channel Layout: stereo',
  'Guessed Channel Layout for Input Stream #0.1 : stereo',
  '[h264 @ 0x5598b6c3e1c0] number of reference frames (0+5) exceeds max (4; probably corrupt input), discarding one',
  '[h264 @ 0x5598b6c3e1c0] mmco: unref short failure',
  '[hevc @ 0x5598b6c3e1c0] Could not find ref with POC 21',
  '[mp4 @ 0x55f0c2a4b6c0] Starting second pass: moving the moov atom to the beginning of the file',
  '[libx264 @ 0x55f0c2a4b6c0] using SAR=1/1',
  '[out#0/mp4 @ 0x55f0c2a4b5c0] Output file is empty, nothing was encoded',
  '[vost#0:0/libx264 @ 0x55f0c2a4b5c0] Error submitting a packet to the muxer: Invalid data found when processing input',
  '[matroska,webm @ 0x55bbd693d900] Could not find codec parameters for stream 2 (Attachment: ttf): unknown codec',
  'Stream #0:2 -> #0:2 (copy)',
];

describe('classifyFfmpegLine', () => {
  it('a truncated MP4: corrupt packets, partial file and decode errors are problems; input 0 where FFmpeg names it', () => {
    const ps = ffmpegProblems(TRUNCATED_MP4);
    expect(ps.map((p) => p.text)).toEqual([
      'Packet corrupt (stream = 0, dts = 60928).',
      'Invalid NAL unit size (3011 > 1901).',
      'corrupt input packet in stream 0',
      'stream 0, offset 0x7f2d6: partial file',
      'Invalid NAL unit size (3011 > 1901).',
      'Error splitting the input into NAL units.',
      'stream 1, offset 0x7f15c: partial file',
      'Decoding error: Invalid data found when processing input',
    ]);
    expect(ps[2]).toMatchObject({ input: 0, contexts: ['mov,mp4,m4a,3gp,3g2,mj2'] });
    expect(ps[7]).toMatchObject({ input: 0, contexts: ['h264'] });
    expect(ps[0]).toMatchObject({ input: null, contexts: ['mov,mp4,m4a,3gp,3g2,mj2'] });
    expect(ps[1]).toMatchObject({ input: null, contexts: [] }); // [NULL @ …]: a parser
    expect(ps[5]).toMatchObject({ input: null, contexts: ['h264'] });
  });

  it('a truncated MKV: "File ended prematurely", with "Last message repeated" added to the count', () => {
    const ps = ffmpegProblems(TRUNCATED_MKV);
    expect(ps.map((p) => [p.text, p.count])).toEqual([
      ['File ended prematurely', 3], ['File ended prematurely', 3], ['File ended prematurely', 1], ['File ended prematurely', 1],
    ]);
    expect(ps[0].contexts).toEqual(['matroska,webm']);
  });

  it('damaged data: decoder errors with the input index (aist#1:1), codec-specific noise ignored', () => {
    const ps = ffmpegProblems(CORRUPT_MP4);
    expect(ps.map((p) => p.text)).toEqual([
      'Invalid NAL unit size (1515870810 > 4525).',
      'Invalid NAL unit size (1515870810 > 4525).',
      'Error splitting the input into NAL units.',
      'Error submitting packet to decoder: Invalid data found when processing input',
      'Error submitting packet to decoder: Invalid data found when processing input',
    ]);
    expect(ps[3]).toMatchObject({ input: 1, contexts: ['aac'] });
    expect(classifyFfmpegLine(CORRUPT_MKV)).toMatchObject({ kind: 'problem', problem: { input: null, contexts: ['matroska,webm'] } });
  });

  it('moov atom not found is a problem (the export fails on it anyway)', () => {
    expect(ffmpegProblems(NO_MOOV).map((p) => p.text)).toEqual(['moov atom not found', 'Error opening input: Invalid data found when processing input']);
    expect(ffmpegProblems(NO_MOOV)[1].input).toBe(0);
  });

  it('FFmpeg <= 6.0 and 7.1 spellings', () => {
    expect(classifyFfmpegLine('Error while decoding stream #1:0: Invalid data found when processing input'))
      .toEqual({ kind: 'problem', problem: { text: 'Error while decoding stream #1:0: Invalid data found when processing input', input: 1, contexts: [], count: 1 } });
    expect(classifyFfmpegLine('[h264 @ 0x7f8b5c00a200] error while decoding MB 12 7, bytestream -9'))
      .toMatchObject({ kind: 'problem', problem: { input: null, contexts: ['h264'] } });
    expect(classifyFfmpegLine('[vist#2:0/h264 @ 0x6000038a0000] [dec:h264 @ 0x6000038a0100] Decoding error: Invalid data found when processing input'))
      .toEqual({ kind: 'problem', problem: { text: 'Decoding error: Invalid data found when processing input', input: 2, contexts: ['h264', 'h264'], count: 1 } });
    expect(classifyFfmpegLine('[in#1/matroska,webm @ 0x6000038a0000] Error during demuxing: I/O error'))
      .toMatchObject({ kind: 'problem', problem: { input: 1, contexts: ['matroska,webm'] } });
    expect(classifyFfmpegLine('[mp3float @ 0x55d0] Header missing')).toMatchObject({ kind: 'problem' });
  });

  it('harmless and unrelated lines are not problems (the allow-list wins over the problem words)', () => {
    for (const l of HARMLESS) expect(classifyFfmpegLine(l).kind, l).not.toBe('problem');
    expect(classifyFfmpegLine(HARMLESS[3]).kind).toBe('harmless'); // contains "corrupt"
    expect(classifyFfmpegLine(HARMLESS[0]).kind).toBe('harmless');
    expect(ffmpegProblems(HARMLESS)).toEqual([]);
  });

  it('"Last message repeated" after a harmless line is not counted on an earlier problem', () => {
    const ps = ffmpegProblems(['[matroska,webm @ 0x1] File ended prematurely', '[swscaler @ 0x2] deprecated pixel format used, make sure you did set range correctly', '    Last message repeated 40 times']);
    expect(ps).toHaveLength(1);
    expect(ps[0].count).toBe(1);
  });

  it('the collector keeps at most MAX_PROBLEMS_PER_RUN entries and counts the rest', () => {
    const c = new FfmpegProblemCollector();
    for (let i = 0; i < MAX_PROBLEMS_PER_RUN + 50; i++) c.push(`[h264 @ 0x1] error while decoding MB ${i} 0, bytestream -3`);
    expect(c.problems).toHaveLength(MAX_PROBLEMS_PER_RUN);
    expect(c.problems.reduce((n, p) => n + p.count, 0)).toBe(MAX_PROBLEMS_PER_RUN + 50);
  });
});

describe('ffmpegInputPaths', () => {
  it('lists -i values in order without the file: prefix', () => {
    expect(ffmpegInputPaths(['-y', '-ss', '1', '-i', 'file:/a b.mp4', '-f', 'ffmetadata', '-i', 'file:C:\\x\\c.txt', '-map', '0', 'file:/out.mp4']))
      .toEqual(['/a b.mp4', 'C:\\x\\c.txt']);
  });
});

function item(id: string, p: string, probe: Partial<MediaProbe> = {}): MediaItem {
  return {
    id, name: p.split('/').pop()!, path: p, kind: 'video', category: 'Other', identity: {}, binId: null,
    probe: {
      container: 'mov,mp4,m4a,3gp,3g2,mj2', duration: 10, size: 1, startTime: 0, browserPlayable: true, subtitles: [],
      video: { index: 0, codec: 'h264', width: 320, height: 240, fps: { num: 24, den: 1 }, avgFps: { num: 24, den: 1 }, isVfr: false } as MediaProbe['video'],
      audio: [{ index: 1, codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48000 }] as MediaProbe['audio'],
      ...probe,
    },
    offline: false, proxy: { status: 'none' }, detectedScenes: [], subtitleTrackIds: [], notes: '', tags: [], addedAt: 0,
  };
}

const A = item('a', '/m/a.mp4');
const B = item('b', '/m/b.mkv', { container: 'matroska,webm', audio: [{ index: 1, codec: 'opus', channels: 2, layout: 'stereo', sampleRate: 48000 }] as MediaProbe['audio'] });
const C = item('c', '/m/c.mkv', { container: 'matroska,webm' });
const STILL = { ...item('s', '/m/s.png'), kind: 'image' as const };
const MEDIA = { a: A, b: B, c: C, s: STILL };

describe('planSourceEndChecks', () => {
  it('per file and stream, the furthest read (S + T - 0.25), capped at the probed duration; stills and temp inputs skipped', () => {
    const graph = {
      inputArgs: [
        '-copyts', '-start_at_zero', '-ss', '1.000000', '-t', '3.250000', '-i', '/m/a.mp4',     // 0: a, to 4.0
        '-copyts', '-start_at_zero', '-ss', '5.000000', '-t', '4.250000', '-i', '/m/a.mp4',     // 1: a, to 9.0
        '-copyts', '-start_at_zero', '-t', '12.250000', '-i', '/m/b.mkv',                        // 2: b, to 12 > 10
        '-loop', '1', '-framerate', '24', '-t', '2.5', '-i', '/m/s.png',                         // 3: still
        '-f', 'ffmetadata', '-i', '/tmp/chapters.txt',                                           // 4: chapters
      ],
      filterGraph: '[0:v:0]trim[v0];[1:v:0]trim[v1];[1:1]atrim[a1];[2:a:0]atrim[a2];[3:v:0]null[v3]',
    };
    expect(planSourceEndChecks([graph], MEDIA)).toEqual([
      { path: '/m/a.mp4', mediaId: 'a', stream: 'v:0', kind: 'video', needEnd: 9, startTime: 0 },
      { path: '/m/a.mp4', mediaId: 'a', stream: '1', kind: 'audio', needEnd: 9, startTime: 0 },
      { path: '/m/b.mkv', mediaId: 'b', stream: 'a:0', kind: 'audio', needEnd: 10, startTime: 0 },
    ]);
  });

  it('merges the graphs of a per-track export; unknown paths are skipped', () => {
    const g = (t: string, p: string) => ({ inputArgs: ['-t', t, '-i', p], filterGraph: '[0:a:0]anull[a]' });
    expect(planSourceEndChecks([g('3.25', '/m/c.mkv'), g('6.25', '/m/c.mkv'), g('6.25', '/elsewhere.mp4')], MEDIA))
      .toEqual([{ path: '/m/c.mkv', mediaId: 'c', stream: 'a:0', kind: 'audio', needEnd: 6, startTime: 0 }]);
  });
});

describe('packetDataEnd', () => {
  it('the last packet end, container-relative; dts when pts is missing; null without packets', () => {
    expect(packetDataEnd([{ pts_time: '4.917000', duration_time: '0.041000' }, { pts_time: '4.958000', duration_time: '0.041000' }, { pts_time: '4.875000' }], 0)).toBeCloseTo(4.999, 6);
    expect(packetDataEnd([{ dts_time: '11.400000', duration_time: '0.100000' }], 1.4)).toBeCloseTo(10.1, 6);
    expect(packetDataEnd([{ pts_time: 'N/A' }], 0)).toBeNull();
    expect(packetDataEnd([], 0)).toBeNull();
  });
});

describe('exportSourceWarnings', () => {
  const run = (inputs: string[], lines: string[]): FfmpegRunProblems => ({ inputs, problems: ffmpegProblems(lines) });
  const end = (path: string, kind: 'video' | 'audio', dataEnd: number, needEnd: number): SourceEndResult =>
    ({ check: { path, mediaId: 'x', stream: kind === 'video' ? 'v:0' : 'a:0', kind, needEnd, startTime: 0 }, dataEnd });

  it('no problems, no warnings', () => {
    expect(exportSourceWarnings([], [], MEDIA)).toEqual([]);
  });

  it('a problem with an input index names that file, with the count of the other messages', () => {
    expect(exportSourceWarnings([run(['/m/c.mkv', '/m/a.mp4'], CORRUPT_MP4.slice(6))], [], MEDIA)).toEqual([
      'Export finished, but FFmpeg reported a problem reading "a.mp4": Error submitting packet to decoder: Invalid data found when processing input (and 1 more message). '
      + 'Part of the output may be silent or frozen. Check the file or relink it.',
    ]);
  });

  it('without an index, the demuxer / decoder name picks the file among the run\'s sources', () => {
    expect(exportSourceWarnings([run(['/m/a.mp4', '/m/b.mkv'], TRUNCATED_MKV)], [], MEDIA)).toEqual([
      'Export finished, but FFmpeg reported a problem reading "b.mkv": File ended prematurely (and 7 more messages). Part of the output may be silent or frozen. Check the file or relink it.',
    ]);
    expect(exportSourceWarnings([run(['/m/a.mp4', '/m/b.mkv'], ['[opus @ 0x1] Error while decoding stream #?: corrupt frame'])], [], MEDIA)[0]).toContain('"b.mkv"');
  });

  it('several candidates: the warning lists them, unless one of them ends early', () => {
    expect(exportSourceWarnings([run(['/m/b.mkv', '/m/c.mkv', '/m/b.mkv'], [CORRUPT_MKV])], [], MEDIA)).toEqual([
      'Export finished, but FFmpeg reported a problem reading one of these source files: "b.mkv", "c.mkv": 0x00 at pos 457210 (0x6f9fa) invalid as first byte of an EBML number. '
      + 'Part of the output may be silent or frozen. Check the files or relink them.',
    ]);
    expect(exportSourceWarnings([run(['/m/b.mkv', '/m/c.mkv'], TRUNCATED_MKV.slice(0, 2))], [end('/m/c.mkv', 'video', 4.999, 9)], MEDIA)).toEqual([
      'Export finished, but "c.mkv" ends early: its data stops at about 5.00 s, but the export reads it up to 9.00 s, so that part of the output is frozen on its last frame. '
      + 'FFmpeg reported: File ended prematurely (and 2 more messages). Check the file or relink it.',
    ]);
  });

  it('an early end without FFmpeg messages; both streams; no data at all; long times as m:ss', () => {
    expect(exportSourceWarnings([], [end('/m/a.mp4', 'video', 4, 9), end('/m/a.mp4', 'audio', 4.02, 9)], MEDIA)).toEqual([
      'Export finished, but "a.mp4" ends early: its data stops at about 4.00 s, but the export reads it up to 9.00 s, so that part of the output is frozen and silent. Check the file or relink it.',
    ]);
    expect(exportSourceWarnings([], [end('/m/b.mkv', 'audio', 0, 3725.5)], MEDIA)).toEqual([
      'Export finished, but "b.mkv" ends early: it has no readable data, but the export reads it up to 1:02:05.5, so that part of the output is silent. Check the file or relink it.',
    ]);
    expect(exportSourceWarnings([], [end('/m/b.mkv', 'audio', 61.25, 125)], MEDIA)[0]).toContain('stops at about 1:01.3, but the export reads it up to 2:05.0');
  });

  it('a run without source inputs is the join of a chunked export', () => {
    expect(exportSourceWarnings([run(['/tmp/video.ffconcat', '/tmp/audio.ffconcat'], ['[aist#1:0/pcm_f32le @ 0x1] Decoding error: Invalid data found when processing input'])], [], MEDIA)).toEqual([
      'Export finished, but FFmpeg reported a problem joining the rendered chunks: Decoding error: Invalid data found when processing input. Part of the output may be damaged; export again.',
    ]);
  });

  it(`at most ${MAX_SOURCE_WARNINGS} warnings, then a count`, () => {
    const files = Array.from({ length: 8 }, (_, i) => item(`f${i}`, `/m/f${i}.mp4`));
    const media = Object.fromEntries(files.map((f) => [f.id, f]));
    const ws = exportSourceWarnings([run(files.map((f) => f.path), files.map((_, i) => `[vist#${i}:0/h264 @ 0x1] Decoding error: Invalid data found when processing input`))], [], media);
    expect(ws).toHaveLength(MAX_SOURCE_WARNINGS + 1);
    expect(ws[0]).toContain('"f0.mp4"');
    expect(ws[MAX_SOURCE_WARNINGS]).toBe('…and 3 more problems reported by FFmpeg. Check the export before using it.');
  });
});
