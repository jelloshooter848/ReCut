/**
 * Centre-channel utility with real FFmpeg (Roadmap §9): a generated 5.1 file carries one sine tone per channel
 * (FL 400 Hz, FR 600, FC 1000, LFE 60, BL 1400, BR 1800). Levels are measured per channel and per tone (Goertzel on
 * whole-cycle 1 s windows) against the source tone, within ±0.5 dB:
 *  - export, stereo: the centre extraction holds only the FC tone, at −3.01 dB on each side (equal-power centre);
 *  - export, 5.1: the centre extraction plays from the centre speaker only, at full level;
 *  - export: the controlled downmix (centre −3 dB, surround −6 dB) has FL / FR at 0 dB, FC at −3 dB, the surrounds at
 *    −6 dB on their side, and no LFE;
 *  - preview: the channel proxy job (electron/media/channelProxy.ts) produces the same levels as the stereo export
 *    (also from an AC-3 source, which Chromium cannot decode), and keeps a late-starting stream's offset.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-centre-'));
process.env.RECUT_CACHE_DIR = path.join(tmp, 'cache');

import type { AudioChannelSelection, ExportSettings, MediaItem } from '@shared/model';
import { createMediaItem, createSequence } from '@shared/project';
import { makeClip } from '@shared/timeline';
import { runExport } from '../../electron/export/exporter';
import { probeMedia } from '../../electron/media/probe';
import { startChannelProxyJob } from '../../electron/media/channelProxy';
import { JobQueue } from '../../electron/jobs/jobQueue';

const exec = promisify(execFile);
const FFMPEG = process.env.RECUT_FFMPEG || 'ffmpeg';
const FPS = { num: 24, den: 1 };
const TONES = { FL: 400, FR: 600, FC: 1000, LFE: 60, BL: 1400, BR: 1800 } as const;
const SR = 48000;

const files = { wav: path.join(tmp, 'tones51.wav'), late: path.join(tmp, 'late51.mkv') };
let outN = 0;

async function ff(args: string[]): Promise<void> {
  await exec(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { maxBuffer: 64 * 1024 * 1024 });
}

/** Explicit join map (a mono input is "FC", so join would otherwise put input 0 on the centre). */
const JOIN_MAP = 'map=0.0-FL|1.0-FR|2.0-FC|3.0-LFE|4.0-BL|5.0-BR';

/** Six sines joined into one 5.1 stream (input i -> channel i: FL FR FC LFE BL BR). */
function tonesArgs(seconds: number): string[] {
  const ins = Object.values(TONES).flatMap((f) => ['-f', 'lavfi', '-i', `sine=frequency=${f}:sample_rate=${SR}:duration=${seconds}`]);
  return [...ins, '-filter_complex', `[0:a][1:a][2:a][3:a][4:a][5:a]join=inputs=6:channel_layout=5.1:${JOIN_MAP}[a]`, '-map', '[a]'];
}

/** Decoded audio of a file's first audio stream: one Float32Array per channel. */
async function decode(file: string): Promise<Float32Array[]> {
  const info = await probeMedia(file);
  const ch = info.audio[0].channels;
  const { stdout } = await exec(FFMPEG, ['-v', 'error', '-i', file, '-map', '0:a:0', '-ar', String(SR), '-f', 'f32le', '-c:a', 'pcm_f32le', '-'], { encoding: 'buffer', maxBuffer: 1 << 28 });
  const all = new Float32Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.byteLength / 4));
  const n = Math.floor(all.length / ch);
  const out = Array.from({ length: ch }, () => new Float32Array(n));
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) out[c][i] = all[i * ch + c];
  return out;
}

/** Amplitude of `freq` in `x` over [t0, t0 + 1 s) (Goertzel; whole cycles for integer frequencies). */
function toneAmp(x: Float32Array, freq: number, t0 = 0.5): number {
  const start = Math.round(t0 * SR), n = SR;
  const w = 2 * Math.PI * freq / SR, coeff = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) { const s0 = x[start + i] + coeff * s1 - s2; s2 = s1; s1 = s0; }
  const re = s1 - s2 * Math.cos(w), im = s2 * Math.sin(w);
  return 2 * Math.sqrt(re * re + im * im) / n;
}
const db = (a: number, ref: number) => 20 * Math.log10(Math.max(a, 1e-12) / ref);

/** Level (dB re the source tone) of every tone in one channel. */
function levels(x: Float32Array, ref: number, t0 = 0.5): Record<keyof typeof TONES, number> {
  return Object.fromEntries(Object.entries(TONES).map(([k, f]) => [k, db(toneAmp(x, f, t0), ref)])) as Record<keyof typeof TONES, number>;
}

let ref = 0; // amplitude of a source tone (lavfi sine: 1/8 full scale)
let media: MediaItem;

function settings(over: Partial<ExportSettings> = {}): ExportSettings {
  return {
    outputDir: tmp, fileName: `centre${outN++}.mp4`, width: 160, height: 120, fps: FPS, videoCodec: 'libx264', qualityMode: 'crf', crf: 35,
    videoBitrateKbps: 500, preset: 'ultrafast', audioCodec: 'aac', audioBitrateKbps: 320, audioChannels: 2, sampleRate: SR,
    rangeMode: 'entire', burnSubtitles: false, exportSubtitleSidecar: false, useProxies: false, ...over,
  };
}

async function exportWith(sel: AudioChannelSelection | undefined, over: Partial<ExportSettings> = {}): Promise<Float32Array[]> {
  const seq = createSequence('c', FPS, 160, 120);
  const c = makeClip({ mediaId: media.id, name: 'tones', sourceIn: 0, duration: 48, kind: 'audio', audioStream: media.probe!.audio[0].index }, 0);
  if (sel) c.audio.channelSelection = sel;
  seq.audioTracks[0].clips.push(c);
  const res = await runExport({ sequence: seq, media: { [media.id]: media }, settings: settings(over) });
  expect(res.warnings).toEqual([]);
  return decode(res.outputPath);
}

async function channelProxy(file: string, sel: AudioChannelSelection): Promise<Float32Array[]> {
  const q = new JobQueue({ throttleMs: 10 });
  const job = await startChannelProxyJob(q, { mediaId: 'm', path: file, stream: 0, selection: sel });
  const final = await q.waitFor(job.id);
  expect(final.error).toBeUndefined();
  expect(final.status).toBe('done');
  const out = (final.result as { path: string }).path;
  const p = await probeMedia(out);
  expect(p.audio).toHaveLength(1);
  expect(p.audio[0]).toMatchObject({ codec: 'aac', channels: 2 });
  expect(p.video).toBeUndefined();
  expect(p.browserPlayable).toBe(true);
  return decode(out);
}

const FC: AudioChannelSelection = { mode: 'channel', channel: 'FC' };
const DOWNMIX: AudioChannelSelection = { mode: 'downmix', centreDb: -3, surroundDb: -6 };
const CENTRE_DB = 20 * Math.log10(Math.SQRT1_2); // -3.01
const SILENT = -50;

beforeAll(async () => {
  await ff([...tonesArgs(4), '-c:a', 'pcm_s16le', files.wav]);
  media = { ...createMediaItem(files.wav, 'tones51.wav'), id: 'M', kind: 'audio', probe: await probeMedia(files.wav) };
  ref = toneAmp((await decode(files.wav))[0], TONES.FL);
}, 120_000);

afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

describe('the generated 5.1 source', () => {
  it('probes as 5.1 with one tone per channel', async () => {
    expect(media.probe!.audio[0]).toMatchObject({ channels: 6, layout: '5.1' });
    expect(media.probe!.audio[0]).not.toHaveProperty('layoutGuessed');
    const src = await decode(files.wav);
    (Object.keys(TONES) as (keyof typeof TONES)[]).forEach((name, i) => {
      const l = levels(src[i], ref);
      expect(Math.abs(l[name])).toBeLessThan(0.1);
      for (const other of Object.keys(TONES) as (keyof typeof TONES)[]) if (other !== name) expect(l[other]).toBeLessThan(-60);
    });
  });
});

describe('export (render graph pan filter)', () => {
  it('centre extraction, stereo: only the FC tone, at -3.01 dB on each side', async () => {
    const [L, R] = await exportWith(FC);
    for (const x of [L, R]) {
      const l = levels(x, ref);
      expect(Math.abs(l.FC - CENTRE_DB)).toBeLessThan(0.5);
      for (const k of ['FL', 'FR', 'LFE', 'BL', 'BR'] as const) expect(l[k]).toBeLessThan(SILENT);
    }
  }, 60_000);

  it('centre extraction, 5.1: the centre speaker only, at full level', async () => {
    const out = await exportWith(FC, { audioChannels: 6, audioCodec: 'ac3', audioBitrateKbps: 448 });
    expect(out).toHaveLength(6);
    const c = levels(out[2], ref);
    expect(Math.abs(c.FC)).toBeLessThan(0.5);
    for (const k of ['FL', 'FR', 'LFE', 'BL', 'BR'] as const) expect(c[k]).toBeLessThan(SILENT);
    for (const i of [0, 1, 3, 4, 5]) expect(levels(out[i], ref).FC).toBeLessThan(SILENT);
  }, 60_000);

  it('controlled downmix (centre -3 dB, surround -6 dB): exact levels, LFE omitted', async () => {
    const [L, R] = await exportWith(DOWNMIX);
    const l = levels(L, ref), r = levels(R, ref);
    const f = (o: Record<string, number>) => Object.entries(o).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ');
    console.log(`[downmix export] L: ${f(l)}\n[downmix export] R: ${f(r)}`);
    expect(Math.abs(l.FL)).toBeLessThan(0.5);
    expect(Math.abs(l.FC - -3)).toBeLessThan(0.5);
    expect(Math.abs(l.BL - -6)).toBeLessThan(0.5);
    for (const k of ['FR', 'BR', 'LFE'] as const) expect(l[k]).toBeLessThan(SILENT);
    expect(Math.abs(r.FR)).toBeLessThan(0.5);
    expect(Math.abs(r.FC - -3)).toBeLessThan(0.5);
    expect(Math.abs(r.BR - -6)).toBeLessThan(0.5);
    for (const k of ['FL', 'BL', 'LFE'] as const) expect(r[k]).toBeLessThan(SILENT);
  }, 60_000);
});

describe('preview (channel proxy job)', () => {
  it('the centre proxy matches the stereo export: FC only, -3.01 dB each side', async () => {
    const [L, R] = await channelProxy(files.wav, FC);
    for (const x of [L, R]) {
      const l = levels(x, ref);
      expect(Math.abs(l.FC - CENTRE_DB)).toBeLessThan(0.5);
      for (const k of ['FL', 'FR', 'LFE', 'BL', 'BR'] as const) expect(l[k]).toBeLessThan(SILENT);
    }
  }, 60_000);

  it('the downmix proxy matches the export levels; a second request is served from the cache', async () => {
    const [L, R] = await channelProxy(files.wav, DOWNMIX);
    const l = levels(L, ref), r = levels(R, ref);
    expect(Math.abs(l.FL)).toBeLessThan(0.5);
    expect(Math.abs(l.FC - -3)).toBeLessThan(0.5);
    expect(Math.abs(l.BL - -6)).toBeLessThan(0.5);
    expect(l.LFE).toBeLessThan(SILENT);
    expect(Math.abs(r.BR - -6)).toBeLessThan(0.5);
    expect(r.BL).toBeLessThan(SILENT);
    const q = new JobQueue({ throttleMs: 10 });
    const again = await q.waitFor((await startChannelProxyJob(q, { mediaId: 'm', path: files.wav, stream: 0, selection: DOWNMIX })).id);
    expect(again.result).toMatchObject({ cached: true, key: '0.dm-c-3-s-6' });
  }, 60_000);

  it('works from AC-3 5.1 (not decodable by Chromium) and keeps a late-starting stream at its offset', async () => {
    // Video from 0 s, AC-3 5.1 starting 1 s later.
    const lateTones = Object.values(TONES).flatMap((f) => ['-itsoffset', '1', '-f', 'lavfi', '-i', `sine=frequency=${f}:sample_rate=${SR}:duration=4`]);
    await ff(['-f', 'lavfi', '-i', 'color=c=gray:s=160x120:r=24:d=5', ...lateTones,
      '-filter_complex', `[1:a][2:a][3:a][4:a][5:a][6:a]join=inputs=6:channel_layout=5.1:${JOIN_MAP}[a]`, '-map', '0:v', '-map', '[a]',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'ac3', '-b:a', '448k', files.late]);
    const p = await probeMedia(files.late);
    expect(p.audio[0]).toMatchObject({ codec: 'ac3', channels: 6 });
    expect(p.browserPlayable).toBe(false);
    const q = new JobQueue({ throttleMs: 10 });
    const job = await startChannelProxyJob(q, { mediaId: 'm', path: files.late, stream: p.audio[0].index, selection: FC });
    const final = await q.waitFor(job.id);
    expect(final.status).toBe('done');
    const [L] = await decode((final.result as { path: string }).path);
    // Silence before the stream starts, the centre tone after (AC-3 is lossy: a wider tolerance on the level).
    expect(levels(L, ref, 0).FC).toBeLessThan(SILENT);
    const after = levels(L, ref, 1.5);
    expect(Math.abs(after.FC - CENTRE_DB)).toBeLessThan(1);
    for (const k of ['FL', 'FR', 'BL', 'BR'] as const) expect(after[k]).toBeLessThan(-40);
  }, 90_000);
});
