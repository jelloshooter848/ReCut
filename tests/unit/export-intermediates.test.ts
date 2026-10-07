/**
 * Intermediate and audio-only export (ROADMAP §6), measured on real FFmpeg exports with ffprobe:
 * - ProRes (prores_ks) and DNxHR (dnxhd) in MOV with PCM audio: codec, profile, pixel format, exact frame count,
 *   exact sample count, channel layout, colour tags as the MP4 export writes them, chunked = single pass;
 * - WAV / FLAC audio-only: no video stream, exact sample count of the range, bit depth, layout;
 * - one WAV per audio track: names, skipped (muted / empty) tracks, every file sample-aligned and the same length, and
 *   the per-track files add up to the mixed export (the same per-track levels, no master gain);
 * - subtitles: burn-in does not apply to audio-only, the sidecar is written once next to the per-track files.
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
import { DNXHR_PROFILES, PRORES_PROFILES } from '@shared/exportFormat';
import { adaptFfmpegArgs, ffmpegMajorVersionSync } from '../../electron/media/ffmpeg';
import { runExport, type ExportRunOptions } from '../../electron/export/exporter';

const exec = promisify(execFile);
const FFMPEG = process.env.RECUT_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.RECUT_FFPROBE || 'ffprobe';
const FPS = { num: 24, den: 1 };
const SR = 48000;

let dir: string;
let video: MediaItem;   // 320x180, 24 fps, 6 s, luma ramp + 440 Hz stereo
let music: MediaItem;   // 6 s 660 Hz stereo WAV
let outN = 0;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-intermediates-'));
  const v = path.join(dir, 'src.mp4');
  await ff(['-f', 'lavfi', '-i', 'nullsrc=s=320x180:r=24:d=6,geq=lum=\'16+mod(N*8,200)\':cb=128:cr=128',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-g', '12', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', '-shortest', v]);
  video = await mediaItem('video', v);
  const m = path.join(dir, 'music.wav');
  await ff(['-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=6', '-ac', '2', '-c:a', 'pcm_s16le', m]);
  music = await mediaItem('music', m, 'audio');
}, 60000);
afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

// ---------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------

async function ff(args: string[]): Promise<void> {
  await exec(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...adaptFfmpegArgs(args, ffmpegMajorVersionSync(FFMPEG))], { maxBuffer: 64 * 1024 * 1024 });
}

async function probeJson(file: string, extra: string[] = []): Promise<any> {
  const { stdout } = await exec(FFPROBE, ['-v', 'error', ...extra, '-print_format', 'json', '-show_format', '-show_streams', file], { maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(stdout);
}

async function mediaItem(id: string, file: string, kind: MediaItem['kind'] = 'video'): Promise<MediaItem> {
  const j = await probeJson(file);
  const v = j.streams.find((s: any) => s.codec_type === 'video');
  const rat = (r: string) => { const [n, d] = r.split('/').map(Number); return { num: n, den: d || 1 }; };
  const probe: MediaProbe = {
    container: j.format.format_name, duration: Number(j.format.duration), size: Number(j.format.size),
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
    outputDir: dir, fileName: `x${outN++}`, width: 320, height: 180, fps: FPS,
    videoCodec: 'libx264', qualityMode: 'crf', crf: 18, videoBitrateKbps: 2000, preset: 'ultrafast',
    audioCodec: 'aac', audioBitrateKbps: 128, audioChannels: 2, sampleRate: SR,
    rangeMode: 'entire', burnSubtitles: false, exportSubtitleSidecar: false, useProxies: false, ...over,
  };
}

/**
 * 120 frames (5 s) at 24 fps: V1 two cuts; A1 "Dialogue" (440 Hz, the video's sound) over 0..96; A2 "Music"
 * (660 Hz, track volume 0.5, clip gain -6 dB) over 24..120; A3 (default name) muted with a clip; In/Out 12..108.
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
  a2.volume = 0.5;
  const mc = makeClip({ mediaId: music.id, name: 'm', sourceIn: 0.5, duration: 96, kind: 'audio', audioStream: music.probe!.audio[0].index }, 24);
  mc.audio.gain = -6;
  a2.clips.push(mc);
  a3.muted = true;
  a3.clips.push(makeClip({ mediaId: music.id, name: 'muted', sourceIn: 0, duration: 48, kind: 'audio', audioStream: music.probe!.audio[0].index }, 0));
  s.view.inPoint = 12; s.view.outPoint = 108;
  return s;
}

function req(s: Sequence, over: Partial<ExportSettings> = {}, extra: Partial<ExportRequest> = {}): ExportRequest {
  return { sequence: s, media: { [video.id]: video, [music.id]: music }, settings: settings(over), ...extra };
}

const NO_CHUNKS: ExportRunOptions = { chunked: false };
const SMALL_CHUNKS: ExportRunOptions = { chunked: true, maxSegmentsPerChunk: 1, maxAudioSegmentsPerChunk: 1 };

/** Decoded samples of the first audio stream as float32, interleaved (channels as in the file). */
async function samples(file: string): Promise<{ data: Float32Array; channels: number }> {
  const j = await probeJson(file);
  const a = j.streams.find((s: any) => s.codec_type === 'audio');
  const { stdout } = await exec(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', '0:a:0', '-f', 'f32le', '-c:a', 'pcm_f32le', '-'],
    { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
  const b = stdout as unknown as Buffer;
  return { data: new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)), channels: a.channels };
}

/** RMS of channel 0 over sample frames [from, to). */
function rms(d: { data: Float32Array; channels: number }, from: number, to: number): number {
  let t = 0;
  for (let i = from; i < to; i++) { const v = d.data[i * d.channels]; t += v * v; }
  return Math.sqrt(t / Math.max(1, to - from));
}

/** Decoded video frame count and per-frame MD5s. */
async function frameMd5s(file: string): Promise<string[]> {
  const { stdout } = await exec(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', '0:v:0', '-f', 'framemd5', '-'], { maxBuffer: 64 * 1024 * 1024 });
  return stdout.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(',').pop()!.trim());
}

const colourTags = (s: any) => ({ space: s.color_space, primaries: s.color_primaries, transfer: s.color_transfer, range: s.color_range });

// The In/Out range 12..108: 96 frames = 4 s = 192000 samples at 48 kHz.
const RANGE_FRAMES = 96;
const RANGE_SAMPLES = 192000;

// ---------------------------------------------------------------------------------------------------
// Intermediates in MOV
// ---------------------------------------------------------------------------------------------------

describe('ProRes / DNxHR in MOV with PCM audio', () => {
  it('ProRes 422: prores_ks profile, yuv422p10le, exact frames and samples, PCM 24-bit stereo, MP4 colour tags', async () => {
    const s = sequence();
    const r = await runExport(req(s, { container: 'mov', intermediateCodec: 'prores', proresProfile: 'standard', rangeMode: 'inOut' }), undefined, undefined, NO_CHUNKS);
    expect(r.outputPath.endsWith('.mov')).toBe(true);
    const j = await probeJson(r.outputPath, ['-count_frames']);
    expect(j.format.format_name).toMatch(/mov/);
    const v = j.streams.find((x: any) => x.codec_type === 'video');
    const a = j.streams.find((x: any) => x.codec_type === 'audio');
    expect([v.codec_name, v.profile, v.pix_fmt, v.codec_tag_string]).toEqual(['prores', 'Standard', 'yuv422p10le', 'apcn']);
    expect(Number(v.nb_read_frames)).toBe(RANGE_FRAMES);
    expect(v.r_frame_rate).toBe('24/1');
    expect([a.codec_name, a.channels, a.channel_layout, Number(a.sample_rate)]).toEqual(['pcm_s24le', 2, 'stereo', SR]);
    expect((await samples(r.outputPath)).data.length / 2).toBe(RANGE_SAMPLES);
    // Colour tags: the same graph output as the MP4 export, so the same tags.
    const mp4 = await runExport(req(s, { rangeMode: 'inOut' }), undefined, undefined, NO_CHUNKS);
    const mv = (await probeJson(mp4.outputPath)).streams.find((x: any) => x.codec_type === 'video');
    expect(colourTags(v)).toEqual(colourTags(mv));
  }, 120000);

  it('DNxHR SQ: dnxhd dnxhr_sq, yuv422p, exact frames and samples, PCM 16-bit 5.1', async () => {
    const s = sequence();
    const r = await runExport(req(s, { container: 'mov', intermediateCodec: 'dnxhr', dnxhrProfile: 'sq', width: 256, height: 144, audioBitDepth: 16, audioChannels: 6, rangeMode: 'inOut' }), undefined, undefined, NO_CHUNKS);
    const j = await probeJson(r.outputPath, ['-count_frames']);
    const v = j.streams.find((x: any) => x.codec_type === 'video');
    const a = j.streams.find((x: any) => x.codec_type === 'audio');
    expect([v.codec_name, v.profile, v.pix_fmt, v.width, v.height]).toEqual(['dnxhd', 'DNXHR SQ', 'yuv422p', 256, 144]);
    expect(Number(v.nb_read_frames)).toBe(RANGE_FRAMES);
    expect([a.codec_name, a.channels, a.channel_layout]).toEqual(['pcm_s16le', 6, '5.1']);
    expect((await samples(r.outputPath)).data.length / 6).toBe(RANGE_SAMPLES);
  }, 120000);

  // Every profile encodes with its pixel format (6 frames each). ffprobe reports the decoder's format: the ProRes
  // decoder outputs 4444 as 12-bit.
  const expectFmt: Record<string, string> = { yuv444p10le: 'yuv444p12le' };
  for (const p of PRORES_PROFILES) {
    it(`ProRes profile ${p.label}`, async () => {
      const s = sequence(); s.view.inPoint = 0; s.view.outPoint = 6;
      const r = await runExport(req(s, { container: 'mov', intermediateCodec: 'prores', proresProfile: p.id, rangeMode: 'inOut', width: 256, height: 144 }), undefined, undefined, NO_CHUNKS);
      const v = (await probeJson(r.outputPath, ['-count_frames'])).streams.find((x: any) => x.codec_type === 'video');
      expect([v.codec_name, v.pix_fmt, Number(v.nb_read_frames)]).toEqual(['prores', expectFmt[p.pixFmt] ?? p.pixFmt, 6]);
    }, 60000);
  }
  for (const p of DNXHR_PROFILES) {
    it(`DNxHR profile ${p.label}`, async () => {
      const s = sequence(); s.view.inPoint = 0; s.view.outPoint = 6;
      const r = await runExport(req(s, { container: 'mov', intermediateCodec: 'dnxhr', dnxhrProfile: p.id, rangeMode: 'inOut', width: 256, height: 144 }), undefined, undefined, NO_CHUNKS);
      const v = (await probeJson(r.outputPath, ['-count_frames'])).streams.find((x: any) => x.codec_type === 'video');
      expect([v.codec_name, v.profile, v.pix_fmt, Number(v.nb_read_frames)]).toEqual(['dnxhd', `DNXHR ${p.id.toUpperCase()}`, p.pixFmt, 6]);
    }, 60000);
  }

  it('a chunked ProRes export is frame for frame and sample for sample the single pass', async () => {
    const s = sequence();
    const over: Partial<ExportSettings> = { container: 'mov', intermediateCodec: 'prores', proresProfile: 'lt', rangeMode: 'inOut', width: 256, height: 144 };
    const one = await runExport(req(s, over), undefined, undefined, NO_CHUNKS);
    const many = await runExport(req(s, over), undefined, undefined, SMALL_CHUNKS);
    expect(many.chunks).toBeGreaterThan(1);
    expect(path.extname(many.outputPath)).toBe('.mov');
    expect(await frameMd5s(many.outputPath)).toEqual(await frameMd5s(one.outputPath));
    const a = await samples(one.outputPath), b = await samples(many.outputPath);
    expect(b.data.length).toBe(a.data.length);
    let maxDiff = 0; for (let i = 0; i < a.data.length; i++) maxDiff = Math.max(maxDiff, Math.abs(a.data[i] - b.data[i]));
    expect(maxDiff).toBeLessThan(1e-5);
  }, 180000);
});

// ---------------------------------------------------------------------------------------------------
// Audio only
// ---------------------------------------------------------------------------------------------------

describe('audio-only WAV / FLAC', () => {
  it('WAV: no video, PCM 24-bit, exactly the range\'s samples, the sample rate chosen', async () => {
    const s = sequence();
    const r = await runExport(req(s, { container: 'wav', rangeMode: 'inOut' }), undefined, undefined, NO_CHUNKS);
    expect(r.outputPath.endsWith('.wav')).toBe(true);
    const j = await probeJson(r.outputPath);
    expect(j.streams.filter((x: any) => x.codec_type === 'video')).toEqual([]);
    const a = j.streams[0];
    expect([j.format.format_name, a.codec_name, a.channel_layout, Number(a.sample_rate)]).toEqual(['wav', 'pcm_s24le', 'stereo', SR]);
    expect((await samples(r.outputPath)).data.length / 2).toBe(RANGE_SAMPLES);

    const r44 = await runExport(req(s, { container: 'wav', rangeMode: 'inOut', sampleRate: 44100, audioBitDepth: 16 }), undefined, undefined, NO_CHUNKS);
    const a44 = (await probeJson(r44.outputPath)).streams[0];
    expect([a44.codec_name, Number(a44.sample_rate)]).toEqual(['pcm_s16le', 44100]);
    expect((await samples(r44.outputPath)).data.length / 2).toBe(176400);
  }, 120000);

  it('FLAC 24-bit and 16-bit', async () => {
    const s = sequence();
    const r = await runExport(req(s, { container: 'flac', rangeMode: 'inOut' }), undefined, undefined, NO_CHUNKS);
    const a = (await probeJson(r.outputPath)).streams[0];
    expect([path.extname(r.outputPath), a.codec_name, a.bits_per_raw_sample, a.channel_layout]).toEqual(['.flac', 'flac', '24', 'stereo']);
    expect((await samples(r.outputPath)).data.length / 2).toBe(RANGE_SAMPLES);
    const r16 = await runExport(req(s, { container: 'flac', audioBitDepth: 16, rangeMode: 'inOut' }), undefined, undefined, NO_CHUNKS);
    expect((await probeJson(r16.outputPath)).streams[0].sample_fmt).toBe('s16');
  }, 120000);

  it('a chunked audio-only export equals the single pass', async () => {
    const s = sequence();
    const one = await runExport(req(s, { container: 'wav', rangeMode: 'inOut' }), undefined, undefined, NO_CHUNKS);
    const many = await runExport(req(s, { container: 'wav', rangeMode: 'inOut' }), undefined, undefined, SMALL_CHUNKS);
    expect(many.audioChunks).toBeGreaterThan(1);
    const a = await samples(one.outputPath), b = await samples(many.outputPath);
    expect(b.data.length).toBe(a.data.length);
    let maxDiff = 0; for (let i = 0; i < a.data.length; i++) maxDiff = Math.max(maxDiff, Math.abs(a.data[i] - b.data[i]));
    expect(maxDiff).toBeLessThan(1e-5);
  }, 120000);

  it('burn-in does not apply to audio-only (warning, no failure); the sidecar is written next to the WAV', async () => {
    const s = sequence();
    const subtitles = [{ start: 1, end: 2, text: 'Hello' }];
    const r = await runExport(req(s, { container: 'wav', burnSubtitles: true, exportSubtitleSidecar: true }, { subtitles }), undefined, undefined, NO_CHUNKS);
    expect(r.warnings.some((w) => /burn-in does not apply/i.test(w))).toBe(true);
    expect(r.sidecarPath).toBe(r.outputPath.replace(/\.wav$/, '.srt'));
    expect(fs.readFileSync(r.sidecarPath!, 'utf8')).toContain('Hello');
  }, 60000);
});

// ---------------------------------------------------------------------------------------------------
// One WAV per audio track
// ---------------------------------------------------------------------------------------------------

describe('one WAV per audio track', () => {
  it('writes A1 and A2 (A3 is muted), sample-aligned, the same length, adding up to the mixed export', async () => {
    const s = sequence();
    const base = `stems${outN++}`;
    const subtitles = [{ start: 1, end: 2, text: 'Hello' }];
    const r = await runExport(req(s, { container: 'wav', audioPerTrack: true, rangeMode: 'inOut', fileName: `${base}.wav`, exportSubtitleSidecar: true }, { subtitles }), undefined, undefined, NO_CHUNKS);
    expect(r.outputPaths.map((p) => path.basename(p))).toEqual([`${base} - A1 Dialogue.wav`, `${base} - A2 Music.wav`]);
    expect(r.outputPath).toBe(r.outputPaths[0]);
    expect(r.warnings.some((w) => w.includes('A3 (muted)'))).toBe(true);
    expect(fs.existsSync(path.join(dir, `${base}.wav`))).toBe(false);
    // One sidecar for the set, named after the base.
    expect(r.sidecarPath).toBe(path.join(dir, `${base}.srt`));
    // No temp files left behind.
    expect(fs.readdirSync(dir).filter((f) => f.includes('recut-part'))).toEqual([]);

    const files = await Promise.all(r.outputPaths.map((p) => probeJson(p)));
    for (const j of files) {
      const a = j.streams[0];
      expect([j.format.format_name, a.codec_name, a.channel_layout, Number(a.sample_rate)]).toEqual(['wav', 'pcm_s24le', 'stereo', SR]);
      expect(j.streams.length).toBe(1);
    }
    const [d1, d2] = await Promise.all(r.outputPaths.map((p) => samples(p)));
    expect(d1.data.length / 2).toBe(RANGE_SAMPLES);
    expect(d2.data.length / 2).toBe(RANGE_SAMPLES);
    // A1 (440 Hz, 0..96) ends at frame 96 = range sample 168000; A2 (24..120) starts at frame 24 = range sample 24000.
    expect(rms(d1, 0, 160000)).toBeGreaterThan(0.03);
    expect(rms(d1, 170000, RANGE_SAMPLES)).toBeLessThan(1e-4);
    expect(rms(d2, 0, 22000)).toBeLessThan(1e-4);
    // Music at the source level, with the -6 dB clip gain and the track volume 0.5.
    const src = rms(await samples(music.path), 0, 4 * SR);
    expect(rms(d2, 26000, RANGE_SAMPLES) / (src * Math.pow(10, -6 / 20) * 0.5)).toBeCloseTo(1, 2);

    // The mixed export of the same range is the sum of the per-track files (24-bit rounding aside).
    const mix = await runExport(req(s, { container: 'wav', rangeMode: 'inOut' }), undefined, undefined, NO_CHUNKS);
    const m = await samples(mix.outputPath);
    expect(m.data.length).toBe(d1.data.length);
    let maxDiff = 0; for (let i = 0; i < m.data.length; i++) maxDiff = Math.max(maxDiff, Math.abs(m.data[i] - (d1.data[i] + d2.data[i])));
    expect(maxDiff).toBeLessThan(1e-5);
  }, 120000);

  it('solo picks the files; an active track with no clip in the range gets none; chunked equals single pass', async () => {
    const s = sequence();
    s.audioTracks[0].solo = true;              // only A1 is rendered by the mixed export...
    const base = `solo${outN++}`;
    const r = await runExport(req(s, { container: 'wav', audioPerTrack: true, rangeMode: 'inOut', fileName: base }), undefined, undefined, NO_CHUNKS);
    expect(r.outputPaths.map((p) => path.basename(p))).toEqual([`${base} - A1 Dialogue.wav`]);
    expect(r.warnings.some((w) => w.includes('A2 Music (not soloed)'))).toBe(true);

    const t = sequence();
    t.view.inPoint = 100; t.view.outPoint = 118; // A1 ends at 96: no clip in range
    const r2 = await runExport(req(t, { container: 'wav', audioPerTrack: true, rangeMode: 'inOut', fileName: `empty${outN++}` }), undefined, undefined, NO_CHUNKS);
    expect(r2.outputPaths.map((p) => path.basename(p).replace(/^empty\d+ - /, ''))).toEqual(['A2 Music.wav']);
    expect(r2.warnings.some((w) => w.includes('A1 Dialogue (no clips in the range)'))).toBe(true);

    const one = await runExport(req(sequence(), { container: 'wav', audioPerTrack: true, rangeMode: 'inOut', fileName: `c1-${outN++}` }), undefined, undefined, NO_CHUNKS);
    const many = await runExport(req(sequence(), { container: 'wav', audioPerTrack: true, rangeMode: 'inOut', fileName: `c2-${outN++}` }), undefined, undefined, SMALL_CHUNKS);
    for (let i = 0; i < 2; i++) {
      const a = await samples(one.outputPaths[i]), b = await samples(many.outputPaths[i]);
      expect(b.data.length).toBe(a.data.length);
      let maxDiff = 0; for (let k = 0; k < a.data.length; k++) maxDiff = Math.max(maxDiff, Math.abs(a.data[k] - b.data[k]));
      expect(maxDiff).toBeLessThan(1e-5);
    }
  }, 180000);

  it('refuses when no track would get a file, and asks before replacing existing files', async () => {
    const s = sequence();
    for (const t of s.audioTracks) t.muted = true;
    await expect(runExport(req(s, { container: 'wav', audioPerTrack: true }), undefined, undefined, NO_CHUNKS)).rejects.toThrow(/Nothing to export/);
    const base = `again${outN++}`;
    const first = await runExport(req(sequence(), { container: 'wav', audioPerTrack: true, rangeMode: 'inOut', fileName: base }), undefined, undefined, NO_CHUNKS);
    await expect(runExport(req(sequence(), { container: 'wav', audioPerTrack: true, rangeMode: 'inOut', fileName: base }), undefined, undefined, NO_CHUNKS))
      .rejects.toThrow(/already exists/);
    const again = await runExport(req(sequence(), { container: 'wav', audioPerTrack: true, rangeMode: 'inOut', fileName: base }, { overwrite: true }), undefined, undefined, NO_CHUNKS);
    expect(again.outputPaths).toEqual(first.outputPaths);
  }, 120000);
});
