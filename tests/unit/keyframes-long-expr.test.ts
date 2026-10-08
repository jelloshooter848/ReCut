/**
 * Keyframe lists at the per-property limit (MAX_KEYFRAMES_PER_PROPERTY = 2,000, what a composed nested-sequence
 * property can reach, shared/nest.ts composeKeyList) render with real FFmpeg: the position / scale corner expressions
 * of `perspective` and the level expression of `volume` (shared/keyframes.ts keyframesExpr, about 100 characters per
 * keyframe) do not hit an expression or filter-script limit.
 */
import { it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExportSettings, MediaItem, MediaProbe, Rational } from '@shared/model';
import type { ExportRequest } from '@shared/ipc';
import { createSequence } from '@shared/project';
import { makeClip } from '@shared/timeline';
import { MAX_KEYFRAMES_PER_PROPERTY } from '@shared/keyframes';
import { runExport } from '../../electron/export/exporter';

const exec = promisify(execFile);
const FFMPEG = process.env.RECUT_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.RECUT_FFPROBE || 'ffprobe';
const R = (num: number, den = 1): Rational => ({ num, den });
const F24 = R(24);

let dir: string;
const MAXK = MAX_KEYFRAMES_PER_PROPERTY;
let outN = 0;
beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-nest-')); });
afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

async function ff(args: string[]): Promise<void> {
  await exec(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 64 * 1024 * 1024 });
}
async function probe(file: string): Promise<MediaProbe> {
  const { stdout } = await exec(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const j = JSON.parse(stdout);
  const v = j.streams.find((s: { codec_type: string }) => s.codec_type === 'video');
  const rat = (r: string) => { const [n, d] = r.split('/').map(Number); return { num: n, den: d || 1 }; };
  return {
    container: j.format.format_name, duration: Number(j.format.duration), size: Number(j.format.size),
    video: { index: v.index, codec: v.codec_name, width: v.width, height: v.height, fps: rat(v.r_frame_rate), avgFps: rat(v.avg_frame_rate), isVfr: false },
    audio: j.streams.filter((s: { codec_type: string }) => s.codec_type === 'audio').map((s: { index: number; codec_name: string; channels: number; channel_layout?: string; sample_rate: string }) => ({
      index: s.index, codec: s.codec_name, channels: s.channels, layout: s.channel_layout ?? '', sampleRate: Number(s.sample_rate),
    })),
    subtitles: [], startTime: Number(j.format.start_time ?? 0), browserPlayable: true,
  };
}
/** Luma ramp: frame m has luma 16 + (8m mod 200); a sine whose frequency identifies the file. */
async function lumaMedia(name: string, freq: number, dur = 6): Promise<MediaItem> {
  const file = path.join(dir, `${name}.mp4`);
  await ff(['-f', 'lavfi', '-i', `nullsrc=s=64x36:r=24:d=${dur},geq=lum='16+mod(N*8,200)':cb=128:cr=128`,
    '-f', 'lavfi', '-i', `sine=frequency=${freq}:sample_rate=48000:duration=${dur}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-g', '12', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', '-shortest', file]);
  return {
    id: name, name, path: file, kind: 'video', category: 'Other', identity: {}, binId: null, probe: await probe(file),
    offline: false, proxy: { status: 'none' }, detectedScenes: [], subtitleTrackIds: [], notes: '', tags: [], addedAt: 0,
  };
}
function settings(over: Partial<ExportSettings> = {}): ExportSettings {
  return {
    outputDir: dir, fileName: `n${outN++}.mp4`, width: 64, height: 36, fps: F24,
    videoCodec: 'libx264', qualityMode: 'crf', crf: 0, videoBitrateKbps: 2000, preset: 'ultrafast',
    audioCodec: 'aac', audioBitrateKbps: 192, audioChannels: 2, sampleRate: 48000,
    rangeMode: 'entire', burnSubtitles: false, exportSubtitleSidecar: false, useProxies: false, ...over,
  };
}
async function lumaPerFrame(file: string): Promise<number[]> {
  const { stdout } = await exec(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', '0:v:0', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-'],
    { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
  const buf = stdout as unknown as Buffer;
  const y = 64 * 36, size = (y * 3) / 2; const out: number[] = [];
  for (let i = 0; i + size <= buf.length; i += size) { let t = 0; for (let k = i; k < i + y; k++) t += buf[k]; out.push(Math.round(t / y)); }
  return out;
}
async function rmsPerFrame(file: string): Promise<number[]> {
  const { stdout } = await exec(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'],
    { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
  const b = stdout as unknown as Buffer;
  const s = new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4));
  const out: number[] = [];
  for (let f = 0; (f + 1) * 2000 <= s.length; f++) { let t = 0; for (let k = f * 2000; k < (f + 1) * 2000; k++) t += s[k] * s[k]; out.push(Math.sqrt(t / 2000)); }
  return out;
}


it(`renders a clip with ${MAX_KEYFRAMES_PER_PROPERTY} keyframes on x, scale and level`, async () => {
  const A = await lumaMedia('A', 440, 3);
  const n = MAXK;
  const keys = (f: (i: number) => number) => Array.from({ length: n }, (_, i) => ({ frame: Math.round(i * 47 / (n - 1) * 1e6) / 1e6, value: f(i) }));
  const c = Object.assign(makeClip({ mediaId: 'A', name: 'A', sourceIn: 0, duration: 48, kind: 'video' }, 0), {});
  c.transform = { ...c.transform, keyframes: { x: keys((i) => Math.sin(i / 50) * 10), scale: keys((i) => 0.5 + (i % 7) / 20) } };
  const ca = Object.assign(makeClip({ mediaId: 'A', name: 'A', sourceIn: 0, duration: 48, kind: 'audio', audioStream: A.probe!.audio[0].index }, 0), {});
  ca.audio = { ...ca.audio, keyframes: { volume: keys((i) => 0.5 + 0.4 * Math.sin(i / 100)) } };
  const s = createSequence('S', F24, 64, 36);
  s.videoTracks[0].clips.push(c); s.audioTracks[0].clips.push(ca);
  const res = await runExport({ sequence: s, media: { A }, settings: settings() } as ExportRequest, undefined, undefined, { chunked: false });
  expect((await lumaPerFrame(res.outputPath)).length).toBe(48);
  const rms = await rmsPerFrame(res.outputPath);
  expect(rms.length).toBeGreaterThanOrEqual(47);
  expect(Math.min(...rms.slice(1, 46))).toBeGreaterThan(0.003);
}, 120000);
