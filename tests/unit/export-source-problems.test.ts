/**
 * Export with damaged sources (bugs/closed/2026-10-09-export-silently-pads-truncated-sources.md @ 59eafc6): FFmpeg exits 0 when
 * a source ends early or has corrupt data, and the render graph pads every clip to its full length, so the export
 * "succeeds" with a silent or frozen stretch. runExport must still finish, and must report the problem as an export
 * warning naming the file. Clean sources must produce no warnings.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExportSettings, MediaItem, MediaProbe, Sequence } from '@shared/model';
import type { ExportRequest } from '@shared/ipc';
import { createSequence } from '@shared/project';
import { makeClip } from '@shared/timeline';
import { adaptFfmpegArgs, ffmpegMajorVersionSync } from '../../electron/media/ffmpeg';
import { runExport } from '../../electron/export/exporter';

const exec = promisify(execFile);
const FFMPEG = process.env.RECUT_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.RECUT_FFPROBE || 'ffprobe';
const FPS = { num: 24, den: 1 };

let dir: string;
let outN = 0;
let good: MediaItem;       // 10 s MP4, clean
let goodMkv: MediaItem;    // 10 s MKV, clean
let truncMp4: MediaItem;   // 10 s faststart MP4 cut to half its bytes (moov intact: probes as 10 s)
let truncMkv: MediaItem;   // 10 s MKV cut to half its bytes (probes as 10 s)
let shortMp4: MediaItem;   // 4 s MP4 whose project probe says 10 s (file replaced after import)
let corruptMp4: MediaItem; // 10 s MP4 with 40 kB of garbage at 40 % of the file (full length, damaged middle)

async function ff(args: string[]): Promise<void> {
  await exec(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...adaptFfmpegArgs(args, ffmpegMajorVersionSync(FFMPEG))], { maxBuffer: 64 * 1024 * 1024 });
}

async function probe(file: string): Promise<MediaProbe> {
  const { stdout } = await exec(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const j = JSON.parse(stdout);
  const v = j.streams.find((s: any) => s.codec_type === 'video');
  const audio = j.streams.filter((s: any) => s.codec_type === 'audio').map((s: any) => ({
    index: s.index, codec: s.codec_name, channels: s.channels, layout: s.channel_layout ?? '', sampleRate: Number(s.sample_rate),
  }));
  const rat = (r: string) => { const [n, d] = r.split('/').map(Number); return { num: n, den: d || 1 }; };
  return {
    container: j.format.format_name, duration: Number(j.format.duration), size: Number(j.format.size),
    video: v ? { index: v.index, codec: v.codec_name, width: v.width, height: v.height, fps: rat(v.r_frame_rate), avgFps: rat(v.avg_frame_rate), isVfr: false } : undefined,
    audio, subtitles: [], startTime: Number(j.format.start_time ?? 0), browserPlayable: true,
  };
}

async function makeMedia(id: string, file: string, probeOverride: Partial<MediaProbe> = {}): Promise<MediaItem> {
  return {
    id, name: path.basename(file), path: file, kind: 'video', category: 'Other', identity: {}, binId: null,
    probe: { ...await probe(file), ...probeOverride }, offline: false, proxy: { status: 'none' }, detectedScenes: [], subtitleTrackIds: [],
    notes: '', tags: [], addedAt: 0,
  };
}

function truncateHalf(src: string, dst: string): void {
  const b = fs.readFileSync(src);
  fs.writeFileSync(dst, b.subarray(0, Math.floor(b.length / 2)));
}

function corruptMiddle(src: string, dst: string): void {
  const b = Buffer.from(fs.readFileSync(src));
  const at = Math.floor(b.length * 0.4);
  b.fill(0x5a, at, Math.min(b.length, at + 40_000));
  fs.writeFileSync(dst, b);
}

function settings(over: Partial<ExportSettings> = {}): ExportSettings {
  return {
    outputDir: dir, fileName: `out${outN++}.mp4`, width: 320, height: 240, fps: FPS,
    videoCodec: 'libx264', qualityMode: 'crf', crf: 23, videoBitrateKbps: 2000, preset: 'ultrafast',
    audioCodec: 'aac', audioBitrateKbps: 128, audioChannels: 2, sampleRate: 48000,
    rangeMode: 'entire', burnSubtitles: false, exportSubtitleSidecar: false, useProxies: false, ...over,
  };
}

/** A sequence with one linked V+A clip per entry: `[media, sourceIn s, length s]`, back to back. */
function sequenceOf(clips: [MediaItem, number, number][]): Sequence {
  const s = createSequence('T', FPS, 320, 240);
  let at = 0;
  for (const [m, srcIn, len] of clips) {
    const frames = Math.round(len * 24);
    s.videoTracks[0].clips.push(makeClip({ mediaId: m.id, name: `${m.name}@${at}`, sourceIn: srcIn, duration: frames, speed: 1, kind: 'video' }, at));
    s.audioTracks[0].clips.push(makeClip({ mediaId: m.id, name: `${m.name}@${at}a`, sourceIn: srcIn, duration: frames, speed: 1, kind: 'audio', audioStream: m.probe!.audio[0].index }, at));
    at += frames;
  }
  return s;
}

function req(sequence: Sequence, over: Partial<ExportSettings> = {}): ExportRequest {
  const media: Record<string, MediaItem> = {};
  for (const m of [good, goodMkv, truncMp4, truncMkv, shortMp4, corruptMp4]) media[m.id] = m;
  return { sequence, media, settings: settings(over) };
}

async function outDuration(file: string): Promise<number> {
  return (await probe(file)).duration;
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-export-srcprob-'));
  const src = (d: number) => ['-f', 'lavfi', '-i', `testsrc2=size=320x240:rate=24:duration=${d}`, '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${d}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', '-shortest'];
  const fullMp4 = path.join(dir, 'full.mp4'), fullMkv = path.join(dir, 'full.mkv'), short = path.join(dir, 'short.mp4');
  const goodMp4 = path.join(dir, 'good.mp4'), goodMkvPath = path.join(dir, 'good.mkv');
  await Promise.all([
    ff([...src(10), '-movflags', '+faststart', fullMp4]),
    ff([...src(10), fullMkv]),
    ff([...src(4), short]),
    ff([...src(10), goodMp4]),
    ff([...src(10), goodMkvPath]),
  ]);
  truncateHalf(fullMp4, path.join(dir, 'trunc.mp4'));
  truncateHalf(fullMkv, path.join(dir, 'trunc.mkv'));
  corruptMiddle(fullMp4, path.join(dir, 'corrupt.mp4'));
  good = await makeMedia('good', goodMp4);
  goodMkv = await makeMedia('goodMkv', goodMkvPath);
  truncMp4 = await makeMedia('truncMp4', path.join(dir, 'trunc.mp4'));
  truncMkv = await makeMedia('truncMkv', path.join(dir, 'trunc.mkv'));
  corruptMp4 = await makeMedia('corruptMp4', path.join(dir, 'corrupt.mp4'));
  // The project was probed when the file was 10 s long; the file on disk is now 4 s.
  shortMp4 = await makeMedia('short', short, { duration: 10 });
}, 60000);

afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

const sourceWarnings = (ws: string[], name: string) => ws.filter((w) => w.includes(`"${name}"`));

describe('export with damaged sources', () => {
  it('the truncated sources probe as full length (the pre-export checks cannot see the problem)', () => {
    expect(truncMp4.probe!.duration).toBeGreaterThan(9.9);
    expect(truncMkv.probe!.duration).toBeGreaterThan(9.9);
  });

  it('a truncated MP4 read past the cut: the export finishes and warns, naming the file', async () => {
    const res = await runExport(req(sequenceOf([[truncMp4, 1, 8]])));
    expect(Math.abs(await outDuration(res.outputPath) - 8)).toBeLessThan(0.1);
    const ws = sourceWarnings(res.warnings, 'trunc.mp4');
    expect(ws).toHaveLength(1);
    expect(ws[0]).toMatch(/^Export finished, but /);
    expect(ws[0]).toMatch(/ends early|reported a problem reading/);
    expect(ws[0]).toMatch(/Check the file or relink it\.$/);
    expect(res.sourceWarnings).toEqual(ws);
  }, 60000);

  it('a truncated MKV read past the cut: the export finishes and warns that it ends early, at about 5 s', async () => {
    const res = await runExport(req(sequenceOf([[truncMkv, 1, 8]])));
    expect(Math.abs(await outDuration(res.outputPath) - 8)).toBeLessThan(0.1);
    const ws = sourceWarnings(res.warnings, 'trunc.mkv');
    expect(ws).toHaveLength(1);
    expect(ws[0]).toMatch(/"trunc\.mkv" ends early: its data stops at about [45]\.\d\d s, but the export reads it up to 9\.\d\d s, so that part of the output is frozen and silent\./);
  }, 60000);

  it('a file shorter than the project thinks (FFmpeg prints nothing): the export warns that it ends early', async () => {
    const res = await runExport(req(sequenceOf([[shortMp4, 1, 8]])));
    expect(Math.abs(await outDuration(res.outputPath) - 8)).toBeLessThan(0.1);
    const ws = sourceWarnings(res.warnings, 'short.mp4');
    expect(ws).toHaveLength(1);
    expect(ws[0]).toMatch(/"short\.mp4" ends early: its data stops at about 4\.0\d s, but the export reads it up to 9\.\d\d s/);
  }, 60000);

  it('damaged data in the middle (full length, FFmpeg exits 0): the export finishes and passes on what FFmpeg reported', async () => {
    const res = await runExport(req(sequenceOf([[corruptMp4, 1, 8]])));
    expect(Math.abs(await outDuration(res.outputPath) - 8)).toBeLessThan(0.1);
    const ws = sourceWarnings(res.warnings, 'corrupt.mp4');
    expect(ws).toHaveLength(1);
    expect(ws[0]).toMatch(/^Export finished, but FFmpeg reported a problem reading "corrupt\.mp4": .+\. Part of the output may be silent or frozen\. Check the file or relink it\.$/);
  }, 60000);

  it('several sources: only the damaged one is named, and only reads past its cut count', async () => {
    // truncMkv is read only before its cut (1..4 s), then good.mkv; truncMp4 past its cut.
    const res = await runExport(req(sequenceOf([[truncMkv, 1, 3], [goodMkv, 2, 3], [truncMp4, 2, 6]])));
    expect(sourceWarnings(res.warnings, 'trunc.mp4')).toHaveLength(1);
    expect(sourceWarnings(res.warnings, 'trunc.mkv')).toEqual([]);
    expect(sourceWarnings(res.warnings, 'good.mkv')).toEqual([]);
  }, 60000);

  it('chunked export: the warning still appears', async () => {
    const res = await runExport(req(sequenceOf([[good, 0, 2], [truncMkv, 3, 4], [good, 2, 2]])), undefined, undefined, { chunked: true, maxSegmentsPerChunk: 2, maxAudioSegmentsPerChunk: 2 });
    expect(res.chunks).toBeGreaterThan(1);
    expect(sourceWarnings(res.warnings, 'trunc.mkv')).toHaveLength(1);
  }, 60000);

  it('clean sources (MP4 and MKV, read to their end): no warnings', async () => {
    const res = await runExport(req(sequenceOf([[good, 0, 5], [goodMkv, 5, 5]])));
    expect(res.warnings).toEqual([]);
    expect(res.sourceWarnings).toEqual([]);
  }, 60000);

  it('reading only the intact part of a truncated file: no warnings', async () => {
    const res = await runExport(req(sequenceOf([[truncMkv, 0, 3]])));
    expect(res.warnings).toEqual([]);
  }, 60000);
});
