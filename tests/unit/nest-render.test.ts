/**
 * Nested sequences (Roadmap §8) exported with real FFmpeg: a nested timeline renders frame for frame (per-frame luma
 * of a frame-numbered ramp) and sample for sample (per-frame audio RMS) what the equivalent flat timeline renders,
 * in one pass and in chunks; transitions at a nested clip's edge render the preview's alpha / gain ramps; keyframes
 * on the nested clip (position, level) and inside it (opacity, level) render what the flat timeline with the same
 * motion renders (centroid within 0.25 px, mean luma within 1.5 levels, level within 0.5 dB).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Clip, ExportSettings, Keyframe, MediaItem, MediaProbe, Rational, Sequence } from '@shared/model';
import type { ExportRequest } from '@shared/ipc';
import { createSequence } from '@shared/project';
import { makeClip } from '@shared/timeline';
import { evaluateClipProperty } from '@shared/keyframes';
import { flattenSequence } from '@shared/nest';
import { planFrame } from '../../src/playback/planner';
import { runExport, type ExportRunOptions } from '../../electron/export/exporter';

const exec = promisify(execFile);
const FFMPEG = process.env.RECUT_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.RECUT_FFPROBE || 'ffprobe';
const R = (num: number, den = 1): Rational => ({ num, den });
const F24 = R(24), F25 = R(25);

let dir: string;
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

const NO_CHUNKS: ExportRunOptions = { chunked: false };
const SMALL_CHUNKS: ExportRunOptions = { chunked: true, maxSegmentsPerChunk: 1, maxAudioSegmentsPerChunk: 1 };

describe('nested sequence export equals the flat timeline export', () => {
  let A: MediaItem, B: MediaItem, C: MediaItem;
  let media: Record<string, MediaItem>;
  beforeAll(async () => {
    [A, B, C] = await Promise.all([lumaMedia('A', 440), lumaMedia('B', 660), lumaMedia('C', 880)]);
    media = { A, B, C };
  }, 120000);

  const v = (m: MediaItem, start: number, len: number, src: number, over: Partial<Clip> = {}) => Object.assign(makeClip({ mediaId: m.id, name: m.id, sourceIn: src, duration: len, kind: 'video' }, start), over);
  const a = (m: MediaItem, start: number, len: number, src: number, over: Partial<Clip> = {}) => Object.assign(makeClip({ mediaId: m.id, name: m.id, sourceIn: src, duration: len, kind: 'audio', audioStream: m.probe!.audio[0].index }, start), over);

  /** Inner (fps): A 2 s then B 2 s, 12-frame dissolve / crossfade between them, A at half volume on its track. */
  function inner(fps: Rational): Sequence {
    const s = createSequence('Inner', fps, 64, 36);
    const n = (sec: number) => Math.round(sec * fps.num / fps.den);
    const va = v(A, 0, n(2), 1), vb = v(B, n(2), n(2), 0.5);
    const aa = a(A, 0, n(2), 1), ab = a(B, n(2), n(2), 0.5);
    s.videoTracks[0].clips.push(va, vb);
    s.audioTracks[0].clips.push(aa, ab);
    s.videoTracks[0].transitions.push({ id: 'tv', type: 'crossDissolve', duration: 12, outClipId: va.id, inClipId: vb.id });
    s.audioTracks[0].transitions.push({ id: 'ta', type: 'audioCrossfade', duration: 12, outClipId: aa.id, inClipId: ab.id });
    s.audioTracks[0].volume = 0.5;
    return s;
  }
  /** Outer (24 fps): C 1 s, then the inner sequence from 0.5 s for 3 s (video + audio, linked). */
  function outer(I: Sequence): Sequence {
    const s = createSequence('Outer', F24, 64, 36);
    s.videoTracks[0].clips.push(v(C, 0, 24, 0), { ...v(C, 24, 72, 0.5), mediaId: I.id, sequenceId: I.id, name: 'Nest', linkId: 'L' });
    s.audioTracks[0].clips.push(a(C, 0, 24, 0), { ...a(C, 24, 72, 0.5), mediaId: I.id, sequenceId: I.id, name: 'Nest', linkId: 'L', audioStream: undefined });
    return s;
  }
  /** The flat equivalent of outer(inner(24)) placed by hand. */
  function flat24(): Sequence {
    const s = createSequence('Flat', F24, 64, 36);
    const va = v(A, 24, 36, 1.5), vb = v(B, 60, 36, 0.5);
    const aa = a(A, 24, 36, 1.5, { audio: { gain: 0, volume: 0.5, fadeIn: 0, fadeOut: 0, muted: false } }), ab = a(B, 60, 36, 0.5, { audio: { gain: 0, volume: 0.5, fadeIn: 0, fadeOut: 0, muted: false } });
    s.videoTracks[0].clips.push(v(C, 0, 24, 0), va, vb);
    s.audioTracks[0].clips.push(a(C, 0, 24, 0), aa, ab);
    s.videoTracks[0].transitions.push({ id: 'tv', type: 'crossDissolve', duration: 12, outClipId: va.id, inClipId: vb.id });
    s.audioTracks[0].transitions.push({ id: 'ta', type: 'audioCrossfade', duration: 12, outClipId: aa.id, inClipId: ab.id });
    return s;
  }
  async function render(req: ExportRequest, opts: ExportRunOptions) {
    const res = await runExport(req, undefined, undefined, opts);
    return { luma: await lumaPerFrame(res.outputPath), rms: await rmsPerFrame(res.outputPath) };
  }

  it('renders the same frames and samples (single pass and chunked)', async () => {
    const I = inner(F24);
    const O = outer(I);
    const ref = await render({ sequence: flat24(), media, settings: settings() }, NO_CHUNKS);
    expect(ref.luma).toHaveLength(96);
    const one = await render({ sequence: O, sequences: { [I.id]: I }, media, settings: settings() }, NO_CHUNKS);
    expect(one.luma).toEqual(ref.luma);
    one.rms.forEach((x, i) => expect(x, `rms @${i}`).toBeCloseTo(ref.rms[i], 3));
    const chunked = await render({ sequence: O, sequences: { [I.id]: I }, media, settings: settings() }, SMALL_CHUNKS);
    expect(chunked.luma).toEqual(ref.luma);
    chunked.rms.forEach((x, i) => expect(x, `chunked rms @${i}`).toBeCloseTo(ref.rms[i], 3));
  }, 180000);

  it('renders an inner sequence of another frame rate as the planner shows it', async () => {
    const I = inner(F25);
    const O = outer(I);
    const out = await render({ sequence: O, sequences: { [I.id]: I }, media, settings: settings() }, NO_CHUNKS);
    // The planner's choice for every frame (no transition frames: those blend two pictures).
    const flat = flattenSequence(O, { [I.id]: I }, media);
    for (let f = 0; f < 96; f++) {
      const layers = planFrame(flat, media, f, false).layers;
      if (layers.length !== 1) continue;
      const mediaFrame = Math.floor(layers[0].sourceTime * 24 + 0.5 + 1e-6);
      expect(out.luma[f], `frame ${f}`).toBe(16 + ((mediaFrame * 8) % 200));
    }
  }, 180000);

  it('renders a dissolve into a nested clip as the preview ramps', async () => {
    const I = inner(F24);
    const O = outer(I);
    const vx = O.videoTracks[0].clips[0], vn = O.videoTracks[0].clips[1];
    O.videoTracks[0].transitions.push({ id: 'tx', type: 'crossDissolve', duration: 8, outClipId: vx.id, inClipId: vn.id });
    const ax = O.audioTracks[0].clips[0], an = O.audioTracks[0].clips[1];
    O.audioTracks[0].transitions.push({ id: 'tax', type: 'audioCrossfade', duration: 8, outClipId: ax.id, inClipId: an.id });
    const out = await render({ sequence: O, sequences: { [I.id]: I }, media, settings: settings() }, NO_CHUNKS);
    const outChunked = await render({ sequence: O, sequences: { [I.id]: I }, media, settings: settings() }, SMALL_CHUNKS);
    expect(outChunked.luma).toEqual(out.luma);
    const flat = flattenSequence(O, { [I.id]: I }, media);
    for (let f = 16; f < 32; f++) {
      // Alpha-over composite of the planner's layers on black (luma 16), bottom to top.
      let y = 16;
      for (const l of planFrame(flat, media, f, false).layers) {
        const mf = Math.floor(l.sourceTime * 24 + 0.5 + 1e-6);
        y = y * (1 - l.alpha) + (16 + ((mf * 8) % 200)) * l.alpha;
      }
      expect(Math.abs(out.luma[f] - y), `frame ${f}: ${out.luma[f]} vs ${y}`).toBeLessThanOrEqual(2);
    }
    // Sound is continuous through the crossfade (no dip to silence, no doubled level).
    for (let f = 18; f < 30; f++) expect(out.rms[f], `rms ${f}`).toBeGreaterThan(0.02);
  }, 180000);
});

// ---------------------------------------------------------------------------------------------------
// Keyframes inside nested sequences
// ---------------------------------------------------------------------------------------------------

/** Raw Y planes of every output frame. */
async function yPlanes(file: string, w: number, h: number): Promise<Buffer[]> {
  const { stdout } = await exec(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', '0:v:0', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-'],
    { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 });
  const buf = stdout as unknown as Buffer;
  const size = (w * h * 3) / 2; const frames: Buffer[] = [];
  for (let i = 0; i + size <= buf.length; i += size) frames.push(buf.subarray(i, i + w * h));
  return frames;
}
/** Coverage-weighted centroid (pixel centres at +0.5) and mean luma of a white-on-black frame (as keyframes-export). */
function measure(y: Buffer, w: number): { cx: number; cy: number; mean: number } {
  let sw = 0, sx = 0, sy = 0, sum = 0;
  for (let i = 0; i < y.length; i++) {
    sum += y[i];
    const c = Math.min(1, Math.max(0, (y[i] - 16) / 219));
    if (c <= 0) continue;
    const px = i % w, py = (i - px) / w;
    sw += c; sx += c * (px + 0.5); sy += c * (py + 0.5);
  }
  return { cx: sx / sw, cy: sy / sw, mean: sum / y.length };
}

describe('keyframes inside a nested sequence export like the flat timeline', () => {
  let white: MediaItem;
  beforeAll(async () => {
    const wf = path.join(dir, 'white.mp4');
    await ff(['-f', 'lavfi', '-i', 'color=c=white:s=64x36:r=24:d=4', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', '-shortest', wf]);
    const item = async (id: string, file: string): Promise<MediaItem> => ({
      id, name: id, path: file, kind: 'video', category: 'Other', identity: {}, binId: null, probe: await probe(file),
      offline: false, proxy: { status: 'none' }, detectedScenes: [], subtitleTrackIds: [], notes: '', tags: [], addedAt: 0,
    });
    white = await item('white', wf);
  }, 120000);

  const kf = (frame: number, value: number, interp?: 'ease'): Keyframe => (interp ? { frame, value, interp } : { frame, value });

  it('the nested clip keyed for position and level, inner clip keyed for opacity and level: centroid, luma and level match', async () => {
    const W = 320, H = 180;
    const media = { white };
    // Inner: the white picture at 25 %, its opacity keyed; its sound, its level keyed.
    const I = createSequence('Inner', F24, W, H);
    const iv = makeClip({ mediaId: white.id, name: 'w', sourceIn: 0, duration: 72, kind: 'video' }, 0);
    iv.transform.scale = 0.25;
    iv.transform.keyframes = { opacity: [kf(0, 0.2), kf(40, 1, 'ease'), kf(71, 0.5)] };
    const ia = makeClip({ mediaId: white.id, name: 'w', sourceIn: 0, duration: 72, kind: 'audio', audioStream: white.probe!.audio[0].index }, 0);
    ia.audio.keyframes = { volume: [kf(0, 1), kf(36, 0.2), kf(71, 1.2)] };
    I.videoTracks[0].clips.push(iv);
    I.audioTracks[0].clips.push(ia);
    // Outer: the inner sequence from 0.5 s (inner frame 12) for 2 s, moved and its level keyed.
    const O = createSequence('Outer', F24, W, H);
    const nv: Clip = { ...makeClip({ mediaId: I.id, name: 'Nest', sourceIn: 0.5, duration: 48, kind: 'video' }, 0), sequenceId: I.id, linkId: 'L' };
    nv.transform.keyframes = { x: [kf(0, -100), kf(47, 100, 'ease')], y: [kf(0, 30), kf(47, -30)] };
    const na: Clip = { ...makeClip({ mediaId: I.id, name: 'Nest', sourceIn: 0.5, duration: 48, kind: 'audio' }, 0), sequenceId: I.id, linkId: 'L' };
    na.audio.keyframes = { volume: [kf(0, 0.5), kf(47, 1.5)] };
    O.videoTracks[0].clips.push(nv);
    O.audioTracks[0].clips.push(na);
    // Flat, by hand: N's position keys as they are, the inner opacity keys shifted by -12, the level product per frame.
    const F = createSequence('Flat', F24, W, H);
    const fv = makeClip({ mediaId: white.id, name: 'w', sourceIn: 0.5, duration: 48, kind: 'video' }, 0);
    fv.transform.scale = 0.25;
    fv.transform.keyframes = { x: nv.transform.keyframes.x, y: nv.transform.keyframes.y, opacity: [kf(-12, 0.2), kf(28, 1, 'ease'), kf(59, 0.5)] };
    const fa = makeClip({ mediaId: white.id, name: 'w', sourceIn: 0.5, duration: 48, kind: 'audio', audioStream: white.probe!.audio[0].index }, 0);
    const level: Keyframe[] = [];
    for (let f = 0; f < 48; f++) level.push(kf(f, evaluateClipProperty('volume', ia, f + 12) * evaluateClipProperty('volume', na, f)));
    fa.audio.keyframes = { volume: level };
    F.videoTracks[0].clips.push(fv);
    F.audioTracks[0].clips.push(fa);

    const run = async (req: ExportRequest) => {
      const res = await runExport(req, undefined, undefined, NO_CHUNKS);
      return { frames: await yPlanes(res.outputPath, W, H), rms: await rmsPerFrame(res.outputPath) };
    };
    const ref = await run({ sequence: F, media, settings: settings({ width: W, height: H }) });
    const got = await run({ sequence: O, sequences: { [I.id]: I }, media, settings: settings({ width: W, height: H }) });
    expect(ref.frames).toHaveLength(48);
    expect(got.frames).toHaveLength(48);
    for (let f = 0; f < 48; f++) {
      const a = measure(got.frames[f], W), b = measure(ref.frames[f], W);
      expect.soft(Math.abs(a.cx - b.cx), `x at frame ${f}`).toBeLessThan(0.25);
      expect.soft(Math.abs(a.cy - b.cy), `y at frame ${f}`).toBeLessThan(0.25);
      expect.soft(Math.abs(a.mean - b.mean), `luma at frame ${f}`).toBeLessThan(1.5);
      // The flat reference itself follows the keyframes (the picture moves, its opacity changes).
      expect.soft(Math.abs(b.cx - (W / 2 + evaluateClipProperty('x', fv, f))), `flat x at frame ${f}`).toBeLessThan(0.25);
    }
    expect(measure(ref.frames[28], W).mean - measure(ref.frames[0], W).mean).toBeGreaterThan(2);
    let checked = 0;
    for (let f = 1; f < 47; f++) {
      if (ref.rms[f] < 0.005) continue;
      expect.soft(Math.abs(20 * Math.log10(got.rms[f] / ref.rms[f])), `level at frame ${f}`).toBeLessThan(0.5);
      checked++;
    }
    expect(checked).toBeGreaterThan(40);
  }, 180000);
});
