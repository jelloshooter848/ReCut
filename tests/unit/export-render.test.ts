/**
 * Export rendering regressions, measured on real FFmpeg exports (ffprobe, per-frame luma, per-frame audio RMS):
 * - D1: non-square pixels (SAR) after even-rounding scales / crops and anamorphic sources broke concat / xfade,
 *       and anamorphic sources were rendered squeezed;
 * - D2: an In/Out range starting or ending inside a transition rendered differently from the full export;
 * - D3: burned-in subtitles were one frame off at about half the cue boundaries;
 * - D4: a range shorter than half an output frame (frame-rate conversion) produced no video stream;
 * - D5: AC-3 at 96 kHz failed after the export started;
 * - C8 / B5 / B7: outputFrameIndex for negative / non-finite input, hostile ranges, speeds and media ids.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExportSettings, MediaItem, MediaProbe, Rational, Sequence, Transition } from '@shared/model';
import type { ExportRequest } from '@shared/ipc';
import { createSequence } from '@shared/project';
import { makeClip } from '@shared/timeline';
import { framesToSeconds } from '@shared/time';
import { adaptFfmpegArgs, ffmpegMajorVersionSync } from '../../electron/media/ffmpeg';
import { buildRenderGraph, outputFrameIndex } from '../../electron/export/renderGraph';
import { runExport, type ExportRunOptions } from '../../electron/export/exporter';
import { applyPreset, initialExportSettings, validateExportSettings } from '../../src/panels/export/settings';

const exec = promisify(execFile);
const FFMPEG = process.env.RECUT_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.RECUT_FFPROBE || 'ffprobe';

const R = (num: number, den = 1): Rational => ({ num, den });
const F23 = R(24000, 1001), F24 = R(24), F25 = R(25), F29 = R(30000, 1001), F30 = R(30), F120 = R(120);
const key = (f: Rational) => `${f.num}/${f.den}`;

let dir: string;
let outN = 0;

beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-render-')); });
afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

// ---------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------

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

async function mediaItem(id: string, file: string, kind: MediaItem['kind'] = 'video'): Promise<MediaItem> {
  return {
    id, name: path.basename(file), path: file, kind, category: 'Other', identity: {}, binId: null,
    probe: await probe(file), offline: false, proxy: { status: 'none' }, detectedScenes: [], subtitleTrackIds: [],
    notes: '', tags: [], addedAt: 0,
  };
}

/** Luma ramp media: frame m has luma 16 + (8m mod 200); stereo 440 Hz tone (amplitude 1/8). */
async function lumaMedia(fps: Rational, dur: number, w = 64, h = 36, extra: string[] = []): Promise<MediaItem> {
  const name = `luma-${fps.num}-${fps.den}-${dur}-${w}x${h}`;
  const file = path.join(dir, `${name}.mp4`);
  await ff(['-f', 'lavfi', '-i', `nullsrc=s=${w}x${h}:r=${key(fps)}:d=${dur},geq=lum='16+mod(N*8,200)':cb=128:cr=128`,
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${dur}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-g', '12', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', ...extra, '-shortest', file]);
  return mediaItem(name, file);
}
const lumaOf = (mediaFrame: number) => 16 + ((mediaFrame * 8) % 200);

/** A solid-color video (no audio). */
async function colorMedia(name: string, filter: string): Promise<MediaItem> {
  const file = path.join(dir, `${name}.mp4`);
  await ff(['-f', 'lavfi', '-i', filter, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', file]);
  return mediaItem(name, file);
}

function settings(fps: Rational, over: Partial<ExportSettings> = {}): ExportSettings {
  return {
    outputDir: dir, fileName: `r${outN++}.mp4`, width: 64, height: 36, fps,
    videoCodec: 'libx264', qualityMode: 'crf', crf: 10, videoBitrateKbps: 2000, preset: 'ultrafast',
    audioCodec: 'aac', audioBitrateKbps: 128, audioChannels: 2, sampleRate: 48000,
    rangeMode: 'entire', burnSubtitles: false, exportSubtitleSidecar: false, useProxies: false, ...over,
  };
}

function reqFor(s: Sequence, media: MediaItem[], out: Rational, over: Partial<ExportSettings> = {}, extra: Partial<ExportRequest> = {}): ExportRequest {
  const m: Record<string, MediaItem> = {};
  for (const x of media) m[x.id] = x;
  return { sequence: s, media: m, settings: settings(out, over), ...extra };
}

async function videoInfo(file: string): Promise<{ frames: number; sar: string; width: number; height: number; hasVideo: boolean; aRate?: number }> {
  const { stdout } = await exec(FFPROBE, ['-v', 'error', '-count_frames', '-show_entries',
    'stream=codec_type,nb_read_frames,sample_aspect_ratio,width,height,sample_rate', '-of', 'json', file]);
  const j = JSON.parse(stdout);
  const v = j.streams.find((s: any) => s.codec_type === 'video');
  const a = j.streams.find((s: any) => s.codec_type === 'audio');
  return {
    hasVideo: !!v, frames: Number(v?.nb_read_frames ?? 0), sar: v?.sample_aspect_ratio ?? 'N/A', width: v?.width ?? 0, height: v?.height ?? 0,
    aRate: a ? Number(a.sample_rate) : undefined,
  };
}

/** Raw Y planes (no range conversion) of every output frame. */
async function yPlanes(file: string): Promise<{ frames: Buffer[]; w: number; h: number }> {
  const { stdout: dims } = await exec(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]);
  const [w, h] = dims.trim().split(',').map(Number);
  const { stdout } = await exec(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', '0:v:0', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-'],
    { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 });
  const buf = stdout as unknown as Buffer;
  const size = w * h * 3 / 2; const frames: Buffer[] = [];
  for (let i = 0; i + size <= buf.length; i += size) frames.push(buf.subarray(i, i + w * h));
  return { frames, w, h };
}

/** Mean luma of every output frame. */
async function lumaPerFrame(file: string): Promise<number[]> {
  const { frames } = await yPlanes(file);
  return frames.map((y) => { let t = 0; for (const v of y) t += v; return Math.round(t / y.length); });
}

/** Max luma of every output frame (burned-in text on black). */
async function maxLumaPerFrame(file: string): Promise<number[]> {
  const { frames } = await yPlanes(file);
  return frames.map((y) => { let m = 0; for (const v of y) if (v > m) m = v; return m; });
}

/** Number of bright (> 200) pixels in row `row` of frame `frame`. */
async function brightColumns(file: string, frame: number, row: number): Promise<number> {
  const { frames, w } = await yPlanes(file);
  return [...frames[frame].subarray(row * w, (row + 1) * w)].filter((v) => v > 200).length;
}

/** Audio RMS (mono downmix) of each sequence frame (fps) of the first audio stream. */
async function rmsPerFrame(file: string, fps: Rational): Promise<number[]> {
  const { stdout } = await exec(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'],
    { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
  const b = stdout as unknown as Buffer;
  const samples = new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4));
  const out: number[] = [];
  for (let f = 0; ; f++) {
    const a = Math.round(f * 48000 * fps.den / fps.num), e = Math.round((f + 1) * 48000 * fps.den / fps.num);
    if (e > samples.length) break;
    let t = 0; for (let k = a; k < e; k++) t += samples[k] * samples[k];
    out.push(Math.sqrt(t / (e - a)));
  }
  return out;
}

function roundScaled(f: number, seq: Rational, out: Rational): number {
  const n = BigInt(f) * BigInt(seq.den) * BigInt(out.num), d = BigInt(seq.num) * BigInt(out.den);
  return Number((2n * n + d) / (2n * d));
}
/** Sequence frame (relative) shown by output frame n of a converted export of `frames` sequence frames. */
function seqFrameForOutput(n: number, seq: Rational, out: Rational, frames: number): number {
  if (seq.num === out.num && seq.den === out.den) return n;
  let i = Math.min(frames - 1, Math.floor(((n + 0.5) * seq.num * out.den) / (seq.den * out.num)) + 1);
  while (i > 0 && roundScaled(i, seq, out) > n) i--;
  return i;
}

const NO_CHUNKS: ExportRunOptions = { chunked: false };
const SMALL_CHUNKS: ExportRunOptions = { chunked: true, maxSegmentsPerChunk: 1, maxAudioSegmentsPerChunk: 1 };

// ---------------------------------------------------------------------------------------------------
// D1: sample aspect ratio
// ---------------------------------------------------------------------------------------------------

describe('D1: non-square pixels never reach concat / xfade; anamorphic sources are un-squeezed', () => {
  let sq: MediaItem, odd: MediaItem, wide: MediaItem, ana: MediaItem;
  beforeAll(async () => {
    sq = await lumaMedia(F24, 2, 320, 180);
    odd = await lumaMedia(F24, 2, 101, 57, ['-pix_fmt', 'yuv444p']);
    wide = await colorMedia('wide-1000x416', 'color=c=white:s=1000x416:r=24:d=2');
    // DVD 16:9: 720x480 storage, SAR 32:27 -> 853x480 display.
    ana = await colorMedia('anamorphic-720x480', 'color=c=white:s=720x480:r=24:d=2,setsar=32/27');
  }, 60000);

  const vclip = (m: MediaItem, start: number, len: number, name = 'v') => makeClip({ mediaId: m.id, name, sourceIn: 0, duration: len, kind: 'video' }, start);

  async function exportOk(build: (s: Sequence) => void, media: MediaItem[], opts = NO_CHUNKS) {
    const s = createSequence('SAR', F24, 320, 180);
    build(s);
    const res = await runExport(reqFor(s, media, F24, { width: 320, height: 180 }), undefined, undefined, opts);
    const info = await videoInfo(res.outputPath);
    return { res, info, s };
  }

  const cases: [string, (s: Sequence) => void, () => MediaItem[], number][] = [
    ['transform.scale 0.37 clip then a gap', (s) => {
      const c = vclip(sq, 0, 12); c.transform.scale = 0.37;
      s.videoTracks[0].clips.push(c, vclip(sq, 18, 12, 'v2'));
    }, () => [sq], 30],
    ['transform.scale 0.37 into a cross dissolve', (s) => {
      const a = makeClip({ mediaId: sq.id, name: 'a', sourceIn: 0.5, duration: 12, kind: 'video' }, 0); a.transform.scale = 0.37;
      const b = makeClip({ mediaId: sq.id, name: 'b', sourceIn: 0.5, duration: 12, kind: 'video' }, 12);
      s.videoTracks[0].clips.push(a, b);
      s.videoTracks[0].transitions.push({ id: 't', type: 'crossDissolve', duration: 6, outClipId: a.id, inClipId: b.id });
    }, () => [sq], 24],
    ['crop 0.13 left then a gap', (s) => {
      const c = vclip(sq, 0, 12); c.transform.crop = { left: 0.13, top: 0.07, right: 0, bottom: 0 };
      s.videoTracks[0].clips.push(c, vclip(sq, 18, 12, 'v2'));
    }, () => [sq], 30],
    ['101x57 source after a gap', (s) => { s.videoTracks[0].clips.push(vclip(odd, 5, 12)); }, () => [odd], 17],
    ['101x57 source hard cut to a 320x180 clip', (s) => { s.videoTracks[0].clips.push(vclip(odd, 0, 12), vclip(sq, 12, 12, 'v2')); }, () => [odd, sq], 24],
    ['1000x416 source after a gap', (s) => { s.videoTracks[0].clips.push(vclip(wide, 5, 12)); }, () => [wide], 17],
    ['720x480 SAR 32:27 source after a gap', (s) => { s.videoTracks[0].clips.push(vclip(ana, 5, 12)); }, () => [ana], 17],
  ];
  for (const [label, build, media, frames] of cases) {
    it(`${label}: exports with square pixels`, async () => {
      const { info } = await exportOk(build, media());
      expect(info.hasVideo).toBe(true);
      expect(info.frames).toBe(frames);
      expect(['1:1', 'N/A']).toContain(info.sar);
    }, 60000);
  }

  it('an anamorphic (SAR 32:27) source fills the 16:9 frame like the preview (not squeezed to 4:3)', async () => {
    const { res } = await exportOk((s) => { s.videoTracks[0].clips.push(vclip(ana, 0, 12)); }, [ana]);
    // 720x480 at SAR 32:27 is 853x480 on screen (16:9): it fills all 320 columns of a 320x180 frame.
    // Squeezed (SAR ignored) it was 270 columns wide.
    expect(await brightColumns(res.outputPath, 6, 90)).toBeGreaterThanOrEqual(318);
  }, 60000);

  it('chunked export with an anamorphic source and gaps', async () => {
    const { info } = await exportOk((s) => {
      s.videoTracks[0].clips.push(vclip(ana, 2, 8), vclip(odd, 12, 6, 'o'), vclip(sq, 20, 6, 'q'));
    }, [ana, odd, sq], SMALL_CHUNKS);
    expect(info.frames).toBe(26);
    expect(['1:1', 'N/A']).toContain(info.sar);
  }, 60000);
});

// ---------------------------------------------------------------------------------------------------
// D2: In/Out inside a transition
// ---------------------------------------------------------------------------------------------------

describe('D2: an In/Out range inside a transition renders exactly what the full export renders there', () => {
  let m: MediaItem;
  beforeAll(async () => { m = await lumaMedia(F24, 5); }, 60000);

  type Kind = 'xfade' | 'dip' | 'fadein' | 'fadeout';
  /** A [0,24) src 1 s, B [24,48) src 3 s (audio at 1/4 volume), C [48,72) src 0.5 s; video + linked audio. */
  function build(kind: Kind): Sequence {
    const s = createSequence('IO', F24, 64, 36);
    const srcs = [1, 3, 0.5];
    const v = srcs.map((src, k) => makeClip({ mediaId: m.id, name: `V${k}`, sourceIn: src, duration: 24, kind: 'video' }, 24 * k));
    const a = srcs.map((src, k) => makeClip({ mediaId: m.id, name: `A${k}`, sourceIn: src, duration: 24, kind: 'audio', audioStream: m.probe!.audio[0].index }, 24 * k));
    a[1].audio.volume = 0.25;
    s.videoTracks[0].clips.push(...v);
    s.audioTracks[0].clips.push(...a);
    const both = (t: Omit<Transition, 'id' | 'outClipId' | 'inClipId'>, out: number | null, inn: number | null) => {
      s.videoTracks[0].transitions.push({ ...t, id: `tv${out}${inn}`, outClipId: out === null ? null : v[out].id, inClipId: inn === null ? null : v[inn].id });
      s.audioTracks[0].transitions.push({ ...t, id: `ta${out}${inn}`, outClipId: out === null ? null : a[out].id, inClipId: inn === null ? null : a[inn].id });
    };
    if (kind === 'xfade') { both({ type: 'crossDissolve', duration: 8 }, 0, 1); both({ type: 'crossDissolve', duration: 6 }, 1, 2); }
    if (kind === 'dip') both({ type: 'dipToBlack', duration: 8 }, 0, 1);
    if (kind === 'fadein') both({ type: 'crossDissolve', duration: 8 }, null, 1);
    if (kind === 'fadeout') both({ type: 'crossDissolve', duration: 8 }, 1, null);
    return s;
  }

  const full = new Map<Kind, { luma: number[]; rms: number[] }>();
  async function fullExport(kind: Kind) {
    if (!full.has(kind)) {
      const res = await runExport(reqFor(build(kind), [m], F24), undefined, undefined, NO_CHUNKS);
      full.set(kind, { luma: await lumaPerFrame(res.outputPath), rms: await rmsPerFrame(res.outputPath, F24) });
    }
    return full.get(kind)!;
  }

  async function compare(kind: Kind, i: number, o: number, opts = NO_CHUNKS) {
    const ref = await fullExport(kind);
    const s = build(kind); s.view.inPoint = i; s.view.outPoint = o;
    const r = reqFor(s, [m], F24, { rangeMode: 'inOut' });
    const g = buildRenderGraph(r);
    const res = await runExport(r, undefined, undefined, opts);
    const luma = await lumaPerFrame(res.outputPath);
    const rms = await rmsPerFrame(res.outputPath, F24);
    const vdiff: string[] = [], adiff: string[] = [];
    for (let n = 0; n < o - i; n++) if (!(Math.abs(luma[n] - ref.luma[i + n]) <= 3)) vdiff.push(`f${i + n}: ${luma[n]} vs full ${ref.luma[i + n]}`);
    // Last frame excluded: the AAC tail of a short file is not comparable.
    for (let n = 0; n < o - i - 1; n++) if (!(Math.abs(rms[n] - ref.rms[i + n]) <= 0.006)) adiff.push(`f${i + n}: ${rms[n]?.toFixed(4)} vs full ${ref.rms[i + n]?.toFixed(4)}`);
    return { n: luma.length, vdiff, adiff, warnings: g.warnings };
  }

  const cases: [Kind, number, number][] = [
    ['xfade', 22, 40], ['xfade', 10, 26], ['xfade', 24, 40], ['xfade', 21, 50], ['dip', 21, 36], ['fadein', 27, 40], ['fadeout', 43, 60],
  ];
  for (const [kind, i, o] of cases) {
    it(`${kind}, In ${i} Out ${o}`, async () => {
      const r = await compare(kind, i, o);
      expect(r.n).toBe(o - i);
      expect(r.vdiff).toEqual([]);
      expect(r.adiff).toEqual([]);
      expect(r.warnings.filter((w) => /edge of the export range|shortened|dropped/.test(w))).toEqual([]);
    }, 60000);
  }

  it('chunked export with In/Out inside transitions matches the full export', async () => {
    const r = await compare('xfade', 22, 50, SMALL_CHUNKS);
    expect(r.n).toBe(28);
    expect(r.vdiff).toEqual([]);
    expect(r.adiff).toEqual([]);
  }, 60000);

  it('the "shortened (source handles)" warning only appears when the source handles are short', () => {
    const odd = build('xfade');
    odd.videoTracks[0].transitions[0].duration = 13; // odd length: 12 rendered frames, plenty of handles
    expect(buildRenderGraph(reqFor(odd, [m], F24)).warnings.filter((w) => /shortened/.test(w))).toEqual([]);
    const short = build('xfade');
    short.videoTracks[0].clips[1].sourceIn = 2 / 24; // B has 2 frames of handle before its in-point
    const w = buildRenderGraph(reqFor(short, [m], F24)).warnings.filter((x) => /shortened/.test(x));
    expect(w.length).toBe(1);
    expect(w[0]).toMatch(/from 8 to 4 frames.*source handles/);
  });
});

// ---------------------------------------------------------------------------------------------------
// D3: burn-in subtitle frame timing
// ---------------------------------------------------------------------------------------------------

describe('D3: burned-in subtitles appear on exactly the cue frames', () => {
  const CUES: [number, number][] = [[1, 4], [9, 12], [16, 20], [18, 23], [25, 29], [33, 37], [41, 44], [52, 55]];
  const FRAMES = 64;
  const blacks = new Map<string, MediaItem>();
  beforeAll(async () => {
    for (const f of [F23, F24, F25, F29]) blacks.set(key(f), await colorMedia(`black-${f.num}-${f.den}`, `color=c=black:s=160x90:r=${key(f)}:d=3`));
  }, 60000);

  async function check(seqFps: Rational, outFps: Rational, opts: ExportRunOptions, inOut?: [number, number]) {
    const m = blacks.get(key(seqFps))!;
    const s = createSequence('S', seqFps, 160, 90);
    // Three black clips (chunk boundaries at 20 and 40); the burned text is the only bright pixel.
    s.videoTracks[0].clips.push(
      makeClip({ mediaId: m.id, name: 'b0', sourceIn: 0, duration: 20, kind: 'video' }, 0),
      makeClip({ mediaId: m.id, name: 'b1', sourceIn: 0, duration: 20, kind: 'video' }, 20),
      makeClip({ mediaId: m.id, name: 'b2', sourceIn: 0, duration: FRAMES - 40, kind: 'video' }, 40),
    );
    const subs = CUES.map(([a, b], i) => ({ start: framesToSeconds(a, seqFps), end: framesToSeconds(b, seqFps), text: `CUE ${i}` }));
    const over: Partial<ExportSettings> = { burnSubtitles: true, exportSubtitleSidecar: true, width: 160, height: 90 };
    if (inOut) { s.view.inPoint = inOut[0]; s.view.outPoint = inOut[1]; over.rangeMode = 'inOut'; }
    const res = await runExport(reqFor(s, [m], outFps, over, { subtitles: subs }), undefined, undefined, opts);
    const maxL = await maxLumaPerFrame(res.outputPath);
    const start = inOut ? inOut[0] : 0, end = inOut ? inOut[1] : FRAMES;
    const wrong: string[] = [];
    for (let n = 0; n < maxL.length; n++) {
      const f = start + seqFrameForOutput(n, seqFps, outFps, end - start);
      const want = CUES.some(([a, b]) => f >= a && f < b), got = maxL[n] > 100;
      if (want !== got) wrong.push(`out ${n} (seq ${f}): ${got ? 'shown' : 'hidden'}`);
    }
    // The sidecar keeps the exact cue times.
    const sidecar = fs.readFileSync(res.sidecarPath!, 'utf8');
    return { n: maxL.length, wrong, sidecar };
  }

  for (const f of [F23, F24, F25, F29]) {
    it(`${key(f)} fps, single pass`, async () => {
      const r = await check(f, f, NO_CHUNKS);
      expect(r.n).toBe(FRAMES);
      expect(r.wrong).toEqual([]);
    }, 60000);
  }
  it('23.976 fps, In/Out from frame 7', async () => {
    const r = await check(F23, F23, NO_CHUNKS, [7, 60]);
    expect(r.wrong).toEqual([]);
    expect(r.sidecar).toContain('00:00:00,375 --> 00:00:00,542'); // cue [16,20) - 7 frames at 23.976, exact times
  }, 60000);
  it('23.976 -> 30 fps conversion', async () => { expect((await check(F23, F30, NO_CHUNKS)).wrong).toEqual([]); }, 60000);
  it('24 -> 25 fps conversion, In/Out from frame 7', async () => { expect((await check(F24, F25, NO_CHUNKS, [7, 60])).wrong).toEqual([]); }, 60000);
  it('23.976 fps, chunked (a cue crosses a chunk boundary)', async () => {
    const r = await check(F23, F23, SMALL_CHUNKS);
    expect(r.n).toBe(FRAMES);
    expect(r.wrong).toEqual([]);
  }, 60000);
});

// ---------------------------------------------------------------------------------------------------
// D4: range shorter than half an output frame
// ---------------------------------------------------------------------------------------------------

describe('#134: burn-in highlights the spoken word', () => {
  const F = R(25);
  let black: MediaItem;
  beforeAll(async () => { black = await colorMedia('black-hl', 'color=c=black:s=640x360:r=25:d=3'); }, 60000);

  /** Yellow (highlight) and white pixels of output frame `n`. */
  async function colours(file: string, n: number): Promise<{ yellow: number; white: number }> {
    const out = path.join(dir, `hl-${outN++}.rgb`);
    await ff(['-i', file, '-vf', `select=eq(n\\,${n}),format=rgb24`, '-frames:v', '1', '-f', 'rawvideo', out]);
    const d = fs.readFileSync(out);
    let yellow = 0, white = 0;
    for (let i = 0; i + 2 < d.length; i += 3) {
      if (d[i] > 200 && d[i + 1] > 150 && d[i + 2] < 140) yellow++;
      else if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200) white++;
    }
    return { yellow, white };
  }

  async function render(highlightWords: boolean) {
    const s = createSequence('S', F, 640, 360);
    s.videoTracks[0].clips.push(makeClip({ mediaId: black.id, name: 'b', sourceIn: 0, duration: 60, kind: 'video' }, 0));
    // A cue over frames 5-55; its words start at frames 20, 30 and 40 (nothing highlighted before 20).
    const sec = (f: number) => framesToSeconds(f, F);
    const subtitles = [{ start: sec(5), end: sec(55), text: 'AAA BBB CCC',
      words: [{ start: sec(20), end: sec(29), text: 'AAA' }, { start: sec(30), end: sec(39), text: 'BBB' }, { start: sec(40), end: sec(50), text: 'CCC' }] }];
    const res = await runExport(reqFor(s, [black], F, { burnSubtitles: true, highlightWords, width: 640, height: 360 }, { subtitles }), undefined, undefined, NO_CHUNKS);
    return res.outputPath;
  }

  it('the word being spoken is yellow, the rest of the line white; nothing yellow before the first word or when off', async () => {
    const on = await render(true);
    const before = await colours(on, 12);
    expect(before.white).toBeGreaterThan(150);
    expect(before.yellow).toBe(0);
    for (const n of [25, 35, 45]) {
      const c = await colours(on, n);
      expect(c.yellow, `frame ${n}`).toBeGreaterThan(30);
      expect(c.white, `frame ${n}`).toBeGreaterThan(100);
    }
    const off = await render(false);
    expect((await colours(off, 35)).yellow).toBe(0);
  }, 60000);
});

describe('D4: a range shorter than half an output frame still exports one video frame', () => {
  let m120: MediaItem;
  beforeAll(async () => { m120 = await lumaMedia(F120, 1); }, 60000);
  for (const out of [F23, F24, F30]) {
    it(`1 frame of a 120 fps sequence -> ${key(out)} fps`, async () => {
      const s = createSequence('S', F120, 64, 36);
      s.videoTracks[0].clips.push(makeClip({ mediaId: m120.id, name: 'v', sourceIn: 0, duration: 120, kind: 'video' }, 0));
      s.audioTracks[0].clips.push(makeClip({ mediaId: m120.id, name: 'a', sourceIn: 0, duration: 120, kind: 'audio', audioStream: m120.probe!.audio[0].index }, 0));
      s.view.inPoint = 100; s.view.outPoint = 101;
      const r = reqFor(s, [m120], out, { rangeMode: 'inOut' });
      expect(buildRenderGraph(r).outputFrameCount).toBe(1);
      const res = await runExport(r, undefined, undefined, NO_CHUNKS);
      const info = await videoInfo(res.outputPath);
      expect(info.hasVideo).toBe(true);
      expect(info.frames).toBe(1);
      expect((await lumaPerFrame(res.outputPath))[0]).toBeCloseTo(lumaOf(100), -0.6);
    }, 60000);
  }
});

// ---------------------------------------------------------------------------------------------------
// D5: AC-3 sample rate
// ---------------------------------------------------------------------------------------------------

describe('D5: AC-3 is never asked for more than 48 kHz', () => {
  let m: MediaItem;
  beforeAll(async () => { m = await lumaMedia(F24, 1); }, 60000);
  const seq = () => {
    const s = createSequence('S', F24, 64, 36);
    s.videoTracks[0].clips.push(makeClip({ mediaId: m.id, name: 'v', sourceIn: 0, duration: 12, kind: 'video' }, 0));
    s.audioTracks[0].clips.push(makeClip({ mediaId: m.id, name: 'a', sourceIn: 0, duration: 12, kind: 'audio', audioStream: m.probe!.audio[0].index }, 0));
    return s;
  };

  it('the dialog validation flags AC-3 above 48 kHz (AAC at 96 kHz is fine)', () => {
    const s = seq();
    const base = initialExportSettings(s, null, { fallbackDir: dir });
    const ac3 = validateExportSettings({ ...base, audioCodec: 'ac3', sampleRate: 96000 });
    expect(ac3.ok).toBe(false);
    expect(ac3.issues.find((i) => i.field === 'sampleRate')?.message).toMatch(/AC-3.*48/);
    expect(validateExportSettings({ ...base, audioCodec: 'aac', sampleRate: 96000 }).ok).toBe(true);
    expect(validateExportSettings({ ...base, audioCodec: 'ac3', sampleRate: 48000 }).ok).toBe(true);
  });

  it('saved / preset settings are clamped to 48 kHz when the codec is AC-3', () => {
    const s = seq(); s.sampleRate = 96000;
    const saved = initialExportSettings(s, { sequenceId: s.id, settings: { ...settings(F24), audioCodec: 'ac3', sampleRate: 96000 } }, { fallbackDir: dir });
    expect(saved.sampleRate).toBe(48000);
    const preset = applyPreset({ ...settings(F24), sampleRate: 96000 }, { name: '5.1', settings: { audioChannels: 6 } });
    expect(preset.audioCodec).toBe('ac3');
    expect(preset.sampleRate).toBe(48000);
  });

  it('buildRenderGraph clamps AC-3 to 48 kHz with a warning, and the export succeeds', async () => {
    const r = reqFor(seq(), [m], F24, { audioCodec: 'ac3', audioBitrateKbps: 320, sampleRate: 96000 });
    const g = buildRenderGraph(r);
    expect(g.sampleRate).toBe(48000);
    expect(g.audioCodecArgs).toEqual(expect.arrayContaining(['-ar', '48000']));
    expect(g.warnings.some((w) => /AC-3.*48/.test(w))).toBe(true);
    const res = await runExport(r, undefined, undefined, NO_CHUNKS);
    expect((await videoInfo(res.outputPath)).aRate).toBe(48000);
  }, 60000);
});

// ---------------------------------------------------------------------------------------------------
// C8 / B5 / B7: hostile numbers and ids
// ---------------------------------------------------------------------------------------------------

describe('outputFrameIndex (C8)', () => {
  it('rounds halves up with floor semantics for negative input', () => {
    expect(outputFrameIndex(-1, F24, F24)).toBe(-1);
    expect(outputFrameIndex(-3, F24, F30)).toBe(-4);   // -3.75
    expect(outputFrameIndex(-1, R(48), F24)).toBe(0);  // -0.5 rounds up to 0
    expect(outputFrameIndex(-3, R(48), F24)).toBe(-1); // -1.5 rounds up to -1
    expect(outputFrameIndex(3, R(48), F24)).toBe(2);   // 1.5 rounds up to 2
    for (let f = -50; f <= 50; f++) expect(outputFrameIndex(f, F23, F30)).toBe(Math.floor(f * 30 * 1001 / 24000 + 0.5));
  });
  it('throws a clear error for non-finite or non-integer frames and invalid rates', () => {
    for (const bad of [NaN, Infinity, -Infinity, 1.5]) expect(() => outputFrameIndex(bad, F24, F30)).toThrow(/frame index/i);
    expect(() => outputFrameIndex(1, R(24, 0), F30)).toThrow(/frame rate/i);
  });
});

describe('hostile ranges, speeds and media ids (B5 / B7)', () => {
  const m: MediaItem = {
    id: 'm1', name: 'm1.mp4', path: '/media/m1.mp4', kind: 'video', category: 'Other', identity: {}, binId: null,
    probe: { container: 'mov,mp4,m4a,3gp,3g2,mj2', duration: 10, size: 1, video: { index: 0, codec: 'h264', width: 64, height: 36, fps: F24, avgFps: F24, isVfr: false }, audio: [{ index: 1, codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48000 }], subtitles: [], startTime: 0, browserPlayable: true },
    offline: false, proxy: { status: 'none' }, detectedScenes: [], subtitleTrackIds: [], notes: '', tags: [], addedAt: 0,
  };
  const seq = () => {
    const s = createSequence('S', F24, 64, 36);
    s.videoTracks[0].clips.push(makeClip({ mediaId: 'm1', name: 'v', sourceIn: 1, duration: 48, kind: 'video' }, 0));
    s.audioTracks[0].clips.push(makeClip({ mediaId: 'm1', name: 'a', sourceIn: 1, duration: 48, kind: 'audio' }, 0));
    return s;
  };
  const build = (s: Sequence, over: Partial<ExportSettings> = {}, out: Rational = F30) => buildRenderGraph(reqFor(s, [m], out, over));
  const expectUserError = (fn: () => unknown, re: RegExp) => {
    let err: unknown;
    try { fn(); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RangeError);
    expect((err as Error).message).toMatch(re);
  };

  it('rejects non-finite or absurd In/Out ranges', () => {
    for (const out of [Infinity, 1e21, 1e12]) {
      const s = seq(); s.view.inPoint = 0; s.view.outPoint = out;
      expectUserError(() => build(s, { rangeMode: 'inOut' }), /export range/i);
    }
  });
  it('rejects a sequence that ends absurdly late', () => {
    const s = seq(); s.videoTracks[0].clips[0].start = 1e21;
    expectUserError(() => build(s), /export range/i);
  });
  it('rejects absurd clip speeds instead of building setpts=PTS/0 or 1000 atempo stages', () => {
    for (const speed of [1e-6, 1e300]) {
      const s = seq(); s.videoTracks[0].clips[0].speed = speed; s.audioTracks[0].clips[0].speed = speed;
      expectUserError(() => build(s, {}, F24), /speed/i);
    }
  });
  it('rejects absurd source positions instead of building -ss 1e+21', () => {
    for (const src of [1e21, NaN]) {
      const s = seq(); s.videoTracks[0].clips[0].sourceIn = src;
      expectUserError(() => build(s, {}, F24), /source position/i);
    }
  });
  it('treats media ids like "constructor" as missing media', () => {
    for (const id of ['constructor', 'toString', '__proto__']) {
      const s = seq(); s.videoTracks[0].clips[0].mediaId = id; s.audioTracks[0].clips[0].mediaId = id;
      const g = buildRenderGraph({ sequence: s, media: {}, settings: settings(F24) });
      expect(g.inputCount).toBe(0);
      expect(g.args.join(' ')).not.toContain('undefined');
      expect(g.warnings.some((w) => /missing/.test(w))).toBe(true);
    }
  });
});
