/**
 * MKV packaging export (ROADMAP §7), measured on real FFmpeg exports with ffprobe:
 * - two output audio tracks built from mix definitions (a 5.1 main mix of A1 + A2, a stereo commentary of A3 alone):
 *   codecs, channel layouts, languages, titles, default flags, each track exactly the range's samples, and each
 *   carrying only its own sources;
 * - two soft subtitle streams (SRT) with languages, titles and default / forced flags, cue times relative to the range;
 * - chapters from the sequence's Chapter markers (ffprobe -show_chapters);
 * - the video exactly the range's frames; no metadata from the sources;
 * - AC-3 5.1 + AAC stereo downmix (the "5.1 + stereo downmix" preset); an MKV without output tracks has the one main mix;
 * - a chunked MKV export is the single pass, frame for frame and sample for sample, with the same streams.
 * Nothing here asserts on encoder-version metadata (ENCODER tags, exact AAC / AC-3 padding), so it holds on FFmpeg 6.1 to 9.
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
import { audioOutputPreset } from '@shared/exportFormat';
import { adaptFfmpegArgs, ffmpegMajorVersionSync } from '../../electron/media/ffmpeg';
import { runExport, type ExportRunOptions } from '../../electron/export/exporter';
import { buildExportRequest } from '../../src/panels/export/request';

const exec = promisify(execFile);
const FFMPEG = process.env.RECUT_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.RECUT_FFPROBE || 'ffprobe';
const FPS = { num: 24, den: 1 };
const SR = 48000;

let dir: string;
let video: MediaItem;   // 320x180, 24 fps, 6 s, 440 Hz stereo (title / comment tags that must not reach the export)
let music: MediaItem;   // 6 s 660 Hz stereo WAV
let talk: MediaItem;    // 6 s 880 Hz stereo WAV (the commentary)
let outN = 0;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-mkv-'));
  const v = path.join(dir, 'src.mkv');
  await ff(['-f', 'lavfi', '-i', 'testsrc=s=320x180:r=24:d=6',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '12', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2',
    '-metadata', 'title=Source Title', '-metadata:s:a:0', 'language=jpn', '-metadata:s:a:0', 'title=Source Audio', '-shortest', v]);
  video = await mediaItem('video', v);
  const m = path.join(dir, 'music.wav');
  await ff(['-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=6', '-ac', '2', '-c:a', 'pcm_s16le', m]);
  music = await mediaItem('music', m, 'audio');
  const t = path.join(dir, 'talk.wav');
  await ff(['-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=6', '-ac', '2', '-c:a', 'pcm_s16le', t]);
  talk = await mediaItem('talk', t, 'audio');
}, 60000);
afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

// ---------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------

async function ff(args: string[]): Promise<void> {
  await exec(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...adaptFfmpegArgs(args, ffmpegMajorVersionSync(FFMPEG))], { maxBuffer: 64 * 1024 * 1024 });
}

async function probeJson(file: string, extra: string[] = []): Promise<any> {
  const { stdout } = await exec(FFPROBE, ['-v', 'error', ...extra, '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters', file], { maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(stdout);
}

async function mediaItem(id: string, file: string, kind: MediaItem['kind'] = 'video'): Promise<MediaItem> {
  const j = await probeJson(file);
  const v = j.streams.find((s: any) => s.codec_type === 'video');
  const rat = (r: string) => { const [n, d] = r.split('/').map(Number); return { num: n, den: d || 1 }; };
  const probe: MediaProbe = {
    container: j.format.format_name.split(',')[0], duration: Number(j.format.duration), size: Number(j.format.size),
    video: v ? { index: v.index, codec: v.codec_name, width: v.width, height: v.height, fps: rat(v.r_frame_rate), avgFps: rat(v.avg_frame_rate), isVfr: false } : undefined,
    audio: j.streams.filter((s: any) => s.codec_type === 'audio').map((s: any) => ({
      index: s.index, codec: s.codec_name, channels: s.channels, layout: s.channel_layout ?? '', sampleRate: Number(s.sample_rate),
    })),
    subtitles: [], startTime: Number(j.format.start_time ?? 0), browserPlayable: true,
  } as MediaProbe;
  return {
    id, name: path.basename(file), path: file, kind, category: 'Other', identity: {}, binId: null,
    probe, offline: false, proxy: { status: 'none' }, detectedScenes: [], subtitleTrackIds: [], notes: '', tags: [], addedAt: 0,
  } as MediaItem;
}

function settings(over: Partial<ExportSettings> = {}): ExportSettings {
  return {
    outputDir: dir, fileName: `m${outN++}`, width: 320, height: 180, fps: FPS,
    videoCodec: 'libx264', qualityMode: 'crf', crf: 23, videoBitrateKbps: 2000, preset: 'ultrafast',
    audioCodec: 'aac', audioBitrateKbps: 128, audioChannels: 2, sampleRate: SR,
    rangeMode: 'entire', burnSubtitles: false, exportSubtitleSidecar: false, useProxies: false, container: 'mkv', ...over,
  };
}

/**
 * 120 frames (5 s) at 24 fps: V1 two cuts; A1 "Dialogue" 440 Hz over 0..96; A2 "Music" 660 Hz over 24..120; A3
 * "Commentary" 880 Hz over 0..120. Subtitle tracks "English" (en) and "Français" (fre). Chapter markers at 0
 * "Opening" and 60 "Second half" (and an ordinary marker that is not a chapter). In/Out 12..108.
 */
function sequence(): Sequence {
  const s = createSequence('S', FPS, 320, 180);
  s.videoTracks[0].clips.push(
    makeClip({ mediaId: video.id, name: 'v1', sourceIn: 0, duration: 60, kind: 'video' }, 0),
    makeClip({ mediaId: video.id, name: 'v2', sourceIn: 3, duration: 60, kind: 'video' }, 60),
  );
  const [a1, a2, a3] = s.audioTracks;
  a1.name = 'Dialogue';
  a1.clips.push(makeClip({ mediaId: video.id, name: 'a1', sourceIn: 0, duration: 96, kind: 'audio', audioStream: video.probe!.audio[0].index }, 0));
  a2.name = 'Music';
  a2.clips.push(makeClip({ mediaId: music.id, name: 'm', sourceIn: 0.5, duration: 96, kind: 'audio', audioStream: music.probe!.audio[0].index }, 24));
  a3.name = 'Commentary';
  a3.clips.push(makeClip({ mediaId: talk.id, name: 'c', sourceIn: 0, duration: 120, kind: 'audio', audioStream: talk.probe!.audio[0].index }, 0));
  s.subtitleTracks.push(
    { id: 'sub-en', name: 'English', language: 'en', enabled: true, cues: [
      { id: 'e1', start: 24, duration: 24, offset: 0, text: 'Hello there' },
      { id: 'e2', start: 72, duration: 12, offset: 0, text: 'Second line' },
    ] },
    { id: 'sub-fr', name: 'Français', language: 'fre', enabled: false, cues: [
      { id: 'f1', start: 36, duration: 12, offset: 0, text: 'Bonjour' },
    ] },
  );
  s.markers.push(
    { id: 'k1', time: 0, duration: 0, name: 'Opening', note: '', color: '#fff', kind: 'chapter' },
    { id: 'k2', time: 60, duration: 0, name: 'Second half', note: '', color: '#fff', kind: 'chapter' },
    { id: 'k3', time: 30, duration: 0, name: 'Just a note', note: '', color: '#fff', kind: 'marker' },
  );
  s.view.inPoint = 12; s.view.outPoint = 108;
  return s;
}

const MEDIA = () => ({ [video.id]: video, [music.id]: music, [talk.id]: talk });

/** The request the Export dialog sends (request.ts: per-track subtitle cues included). */
function req(s: Sequence, over: Partial<ExportSettings> = {}): ExportRequest {
  return buildExportRequest({ media: MEDIA(), subtitleTracks: {} }, s, settings(over));
}

/** Main 5.1 FLAC (A1 + A2, eng) and Commentary stereo PCM (A3, eng); English (default) and French (forced) subtitles. */
function packaged(s: Sequence, over: Partial<ExportSettings> = {}): Partial<ExportSettings> {
  const [a1, a2, a3] = s.audioTracks;
  return {
    audioOutputs: [
      { sources: [a1.id, a2.id], layout: '5.1', codec: 'flac', language: 'eng', title: 'Main 5.1' },
      { sources: [a3.id], layout: 'stereo', codec: 'pcm', language: 'eng', title: 'Commentary' },
    ],
    subtitleOutputs: [
      { trackId: 'sub-en', default: true },
      { trackId: 'sub-fr', forced: true, title: 'French (forced)' },
    ],
    ...over,
  };
}

const NO_CHUNKS: ExportRunOptions = { chunked: false };
const SMALL_CHUNKS: ExportRunOptions = { chunked: true, maxSegmentsPerChunk: 1, maxAudioSegmentsPerChunk: 1 };

/** Decoded samples of audio stream `i` as float32, interleaved. */
async function samples(file: string, i = 0): Promise<{ data: Float32Array; channels: number }> {
  const j = await probeJson(file);
  const a = j.streams.filter((s: any) => s.codec_type === 'audio')[i];
  const { stdout } = await exec(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', `0:a:${i}`, '-f', 'f32le', '-c:a', 'pcm_f32le', '-'],
    { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
  const b = stdout as unknown as Buffer;
  return { data: new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)), channels: a.channels };
}

/** Power of `freq` in channel `ch` over sample frames [from, to) (Goertzel), normalised so a full-scale sine is ~0.25. */
function tone(d: { data: Float32Array; channels: number }, freq: number, from: number, to: number, ch = 0): number {
  const w = 2 * Math.PI * freq / SR, c = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = from; i < to; i++) { const s0 = d.data[i * d.channels + ch] + c * s1 - s2; s2 = s1; s1 = s0; }
  const n = to - from;
  return (s1 * s1 + s2 * s2 - c * s1 * s2) / (n * n);
}

/**
 * The level (tone() units) of each source tone in the "5.1 + stereo downmix" outputs, from first principles. Every
 * source is FFmpeg's `sine` at its default amplitude 1/8, made stereo with `-ac 2`: L = R = 1/8 / √2 = 0.0884
 * (-21.1 dBFS). The export renders each track at the widest output layout (stereo -> 5.1 puts L in FL, R in FR) and
 * the stereo output takes FFmpeg's default 5.1 -> stereo matrix (L = FL + 0.707 C + 0.707 BL, not normalised for
 * float), so each tone reaches FL of the 5.1 track and L of the stereo track at the source level: 0.0884² / 4 =
 * 1.953e-3. Measured over 1-3 s: 1.9418e-3 (FFmpeg 8.1.3 Linux) to 1.9460e-3 (FFmpeg 6.1.1), 1.9458e-3 on macOS x64
 * (Rosetta 2) and arm64, byte-identical audio in every run on a platform: AC-3 / AAC cost < 0.05 dB per segment
 * (bugs/closed/2026-10-09-mkv-downmix-tone-level-ci-failure.md @ 59eafc6).
 */
const DOWNMIX_TONE = (1 / 8 / Math.SQRT2) ** 2 / 4;
/**
 * Allowed deviation of each 250 ms segment from DOWNMIX_TONE: ±1 dB. Coding noise moves a segment by < 0.1 dB; a
 * wrong matrix moves the whole window by ≥ 3 dB (centre / surround gain on FL, or a normalised matrix: -7.7 dB), and a
 * source cut short or a gap drops its segments by tens of dB. The former one-sided `> 1e-3` over the whole window
 * allowed -2.9 dB, any gain increase and up to 28 % of the window without the tone.
 */
const DOWNMIX_TOL_DB = 1;
const DOWNMIX_SEGMENT = 12000; // 250 ms: whole cycles of 440 Hz (110) and 660 Hz (165), so tone() is exact per segment
const DOWNMIX_WINDOW = [48000, 144000] as const; // 1-3 s of the range: A1 (440 Hz) covers 0-3.5 s, A2 (660 Hz) 0.5-4 s
type Pcm = { data: Float32Array; channels: number };
/** dB against DOWNMIX_TONE of `freq` in channel `ch`, per 250 ms segment of the window. */
function segmentDb(d: Pcm, freq: number, ch: number): number[] {
  const out: number[] = [];
  for (let s = DOWNMIX_WINDOW[0]; s < DOWNMIX_WINDOW[1]; s += DOWNMIX_SEGMENT) out.push(10 * Math.log10(tone(d, freq, s, s + DOWNMIX_SEGMENT, ch) / DOWNMIX_TONE));
  return out;
}
const DOWNMIX_CHECKS = (st: Pcm, s51: Pcm) => [
  { name: 'stereo L', d: st, ch: 0 }, { name: 'stereo R', d: st, ch: 1 }, { name: '5.1 FL', d: s51, ch: 0 }, { name: '5.1 FR', d: s51, ch: 1 },
].flatMap((c) => [440, 660].map((freq) => ({ ...c, freq, db: segmentDb(c.d, freq, c.ch) })));
const segStart = (i: number) => (DOWNMIX_WINDOW[0] + i * DOWNMIX_SEGMENT) / SR;
/** Every segment of the downmix (and of the 5.1 mix it comes from) more than DOWNMIX_TOL_DB off the expected level. */
function downmixLevelIssues(st: Pcm, s51: Pcm): string[] {
  return DOWNMIX_CHECKS(st, s51).flatMap((c) => c.db.flatMap((db, i) => (Math.abs(db) <= DOWNMIX_TOL_DB ? [] : [
    `${c.name} ${c.freq} Hz at ${segStart(i).toFixed(2)}-${(segStart(i) + DOWNMIX_SEGMENT / SR).toFixed(2)} s: ${db.toFixed(2)} dB (allowed ±${DOWNMIX_TOL_DB} dB)`,
  ])));
}
/** All segment levels (dB against DOWNMIX_TONE), for the failure message. */
function downmixLevelProfile(st: Pcm, s51: Pcm): string {
  return `segments from ${segStart(0)} s, ${DOWNMIX_SEGMENT / SR * 1000} ms each:\n` + DOWNMIX_CHECKS(st, s51)
    .map((c) => `  ${c.name} ${c.freq} Hz: ${c.db.map((db) => db.toFixed(2)).join(' ')}`).join('\n');
}

async function frameCount(file: string): Promise<number> {
  const j = await probeJson(file, ['-count_frames', '-select_streams', 'v:0']);
  return Number(j.streams[0].nb_read_frames);
}

/** The SRT text of subtitle stream `i`. */
async function subtitleText(file: string, i: number): Promise<string> {
  const { stdout } = await exec(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', `0:s:${i}`, '-f', 'srt', '-']);
  return stdout.replace(/\r\n/g, '\n');
}

// The In/Out range 12..108: 96 frames = 4 s = 192000 samples at 48 kHz.
const RANGE_FRAMES = 96;
const RANGE_SAMPLES = 192000;

// ---------------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------------

describe('MKV packaging export', () => {
  it('two output audio tracks, two soft subtitle tracks and chapters, frame and sample exact', async () => {
    const s = sequence();
    const r = await runExport(req(s, packaged(s, { rangeMode: 'inOut' })), undefined, undefined, NO_CHUNKS);
    expect(path.extname(r.outputPath)).toBe('.mkv');
    const j = await probeJson(r.outputPath);
    expect(j.format.format_name).toMatch(/matroska/);
    expect(j.streams.map((x: any) => x.codec_type)).toEqual(['video', 'audio', 'audio', 'subtitle', 'subtitle']);
    const [v, a0, a1, s0, s1] = j.streams;
    expect([v.codec_name, v.width, v.height, v.disposition.default]).toEqual(['h264', 320, 180, 1]);
    expect(await frameCount(r.outputPath)).toBe(RANGE_FRAMES);

    // Audio: codecs, layouts, languages, titles, default flags.
    expect([a0.codec_name, a0.channels, a0.tags?.language, a0.tags?.title, a0.disposition.default]).toEqual(['flac', 6, 'eng', 'Main 5.1', 1]);
    expect(a0.channel_layout).toMatch(/^5\.1/);
    // Matroska stores no channel layout for PCM (only the count): FFmpeg reads the stereo track back as 2 channels.
    expect([a1.codec_name, a1.channels, a1.tags?.language, a1.tags?.title, a1.disposition.default]).toEqual(['pcm_s24le', 2, 'eng', 'Commentary', 0]);
    // No metadata from the sources (title, the source stream's language and title).
    expect(j.format.tags?.title).toBeUndefined();
    expect(JSON.stringify(j)).not.toContain('Source');
    expect(JSON.stringify(j)).not.toContain('jpn');

    // Every audio track has exactly the range's samples.
    const main = await samples(r.outputPath, 0), comm = await samples(r.outputPath, 1);
    expect(main.data.length / 6).toBe(RANGE_SAMPLES);
    expect(comm.data.length / 2).toBe(RANGE_SAMPLES);
    // Each track carries its own sources only: the main mix 440 + 660 Hz in the front left, no 880; the commentary 880 only.
    const span = [48000, 144000] as const;
    expect(tone(main, 440, ...span)).toBeGreaterThan(1e-3);
    expect(tone(main, 660, ...span)).toBeGreaterThan(1e-3);
    expect(tone(main, 880, ...span)).toBeLessThan(1e-7);
    expect(tone(comm, 880, ...span)).toBeGreaterThan(1e-3);
    expect(tone(comm, 440, ...span)).toBeLessThan(1e-7);
    expect(tone(comm, 660, ...span)).toBeLessThan(1e-7);

    // Subtitles: SubRip with language, title, default / forced; the hidden French track is included because it was chosen.
    expect([s0.codec_name, s0.tags?.language, s0.tags?.title, s0.disposition.default, s0.disposition.forced]).toEqual(['subrip', 'eng', 'English', 1, 0]);
    expect([s1.codec_name, s1.tags?.language, s1.tags?.title, s1.disposition.default, s1.disposition.forced]).toEqual(['subrip', 'fre', 'French (forced)', 0, 1]);
    // Cue times relative to the range start (frame 12 = 0.5 s): 24..48 -> 0.5..1.5 s, 72..84 -> 2.5..3 s, 36..48 -> 1..1.5 s.
    const en = await subtitleText(r.outputPath, 0);
    expect(en).toContain('00:00:00,500 --> 00:00:01,500\nHello there');
    expect(en).toContain('00:00:02,500 --> 00:00:03,000\nSecond line');
    expect(await subtitleText(r.outputPath, 1)).toContain('00:00:01,000 --> 00:00:01,500\nBonjour');

    // Chapters: the Chapter markers only, relative to the range; the last ends at the output duration.
    expect(j.chapters.map((c: any) => [c.tags?.title, Number(c.start_time), Number(c.end_time)])).toEqual([
      ['Opening', 0, 2], ['Second half', 2, 4],
    ]);
    expect(fs.readdirSync(dir).filter((f) => f.includes('recut-part'))).toEqual([]);
  }, 120000);

  it('a chunked MKV export equals the single pass (frames, both audio tracks, subtitles, chapters)', async () => {
    const s = sequence();
    const over = packaged(s, { rangeMode: 'inOut' });
    const one = await runExport(req(s, over), undefined, undefined, NO_CHUNKS);
    const many = await runExport(req(s, over), undefined, undefined, SMALL_CHUNKS);
    expect(many.chunks).toBeGreaterThan(1);
    expect(many.audioChunks).toBeGreaterThan(1);
    const [j1, j2] = await Promise.all([probeJson(one.outputPath), probeJson(many.outputPath)]);
    const shape = (j: any) => j.streams.map((x: any) => [x.codec_type, x.codec_name, x.channels ?? null, x.tags?.language ?? null, x.tags?.title ?? null, x.disposition.default, x.disposition.forced]);
    expect(shape(j2)).toEqual(shape(j1));
    expect(j2.chapters.map((c: any) => [c.tags?.title, c.start_time, c.end_time])).toEqual(j1.chapters.map((c: any) => [c.tags?.title, c.start_time, c.end_time]));
    expect(await frameCount(many.outputPath)).toBe(RANGE_FRAMES);
    for (const i of [0, 1]) {
      const a = await samples(one.outputPath, i), b = await samples(many.outputPath, i);
      expect(b.data.length).toBe(a.data.length);
      // Float rounding of the 5.1 upmix and the sum at different chunk splits, then 24-bit quantisation (a sample
      // off would differ by ~1e-2 on these tones).
      let maxDiff = 0; for (let k = 0; k < a.data.length; k++) maxDiff = Math.max(maxDiff, Math.abs(a.data[k] - b.data[k]));
      expect(maxDiff).toBeLessThan(5e-5);
    }
    for (const i of [0, 1]) expect(await subtitleText(many.outputPath, i)).toBe(await subtitleText(one.outputPath, i));
  }, 180000);

  it('5.1 + stereo downmix preset: AC-3 5.1 and AAC stereo of the same mix', async () => {
    const s = sequence();
    s.audioTracks[2].muted = true; // the commentary is not in the mix
    let stderr = ''; // the exporter keeps FFmpeg's warnings and errors only when FFmpeg fails: kept here for the message
    const r = await runExport(req(s, { audioOutputs: audioOutputPreset('surroundStereo', s), rangeMode: 'inOut' }), undefined, undefined,
      { ...NO_CHUNKS, onSpawn: (c) => { c.stderr?.on('data', (b) => { stderr += String(b); }); } });
    const j = await probeJson(r.outputPath);
    const a = j.streams.filter((x: any) => x.codec_type === 'audio');
    // 'und' is written as the Matroska language and read back as no language tag.
    expect(a.map((x: any) => [x.codec_name, x.channels, x.tags?.language ?? 'und', x.tags?.title, x.disposition.default])).toEqual([
      ['ac3', 6, 'und', 'Surround 5.1', 1], ['aac', 2, 'und', 'Stereo', 0],
    ]);
    expect(j.streams.filter((x: any) => x.codec_type === 'subtitle')).toEqual([]);
    // Lossy codecs pad to whole codec frames: within one frame of the range.
    const s51 = await samples(r.outputPath, 0), st = await samples(r.outputPath, 1);
    expect(Math.abs(s51.data.length / 6 - RANGE_SAMPLES)).toBeLessThanOrEqual(2048);
    expect(Math.abs(st.data.length / 2 - RANGE_SAMPLES)).toBeLessThanOrEqual(2048);
    // The downmix carries the same sources (440 / 660 Hz) at the level the 5.1 -> stereo matrix gives, all through the
    // window, and not the muted commentary. A failure lists every segment of both tracks and FFmpeg's stderr.
    const issues = downmixLevelIssues(st, s51);
    expect(issues, `${issues.join('\n')}\n${downmixLevelProfile(st, s51)}\nFFmpeg stderr: ${stderr.trim() || '(empty)'}`).toEqual([]);
    expect(tone(st, 880, 48000, 144000)).toBeLessThan(1e-6);
    expect(await frameCount(r.outputPath)).toBe(RANGE_FRAMES);
  }, 120000);

  it('without output tracks an MKV has the one main mix (every track) and no subtitle streams', async () => {
    const s = sequence();
    const r = await runExport(req(s, { audioCodec: 'aac', audioBitrateKbps: 192, rangeMode: 'inOut' }), undefined, undefined, NO_CHUNKS);
    const j = await probeJson(r.outputPath);
    expect(j.streams.map((x: any) => [x.codec_type, x.codec_name])).toEqual([['video', 'h264'], ['audio', 'aac']]);
    const a = j.streams[1];
    expect([a.channels, a.tags?.language ?? 'und', a.disposition.default]).toEqual([2, 'und', 1]);
    const d = await samples(r.outputPath, 0);
    for (const f of [440, 660, 880]) expect(tone(d, f, 48000, 144000)).toBeGreaterThan(1e-3);
    expect(j.chapters.length).toBe(2);
  }, 120000);

  it('an output whose sources are all muted is silence of the full length; a subtitle track without cues in the range is left out', async () => {
    const s = sequence();
    s.audioTracks[2].muted = true;
    s.subtitleTracks[1].cues = [];
    const r = await runExport(req(s, packaged(s, { rangeMode: 'inOut' })), undefined, undefined, NO_CHUNKS);
    expect(r.warnings.some((w) => /Français.*no cues/.test(w))).toBe(true);
    const j = await probeJson(r.outputPath);
    expect(j.streams.map((x: any) => x.codec_type)).toEqual(['video', 'audio', 'audio', 'subtitle']);
    const comm = await samples(r.outputPath, 1);
    expect(comm.data.length / 2).toBe(RANGE_SAMPLES);
    expect(comm.data.every((x) => x === 0)).toBe(true);
  }, 120000);
});
