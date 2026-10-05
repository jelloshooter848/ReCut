/**
 * Output frame-rate conversion (Export dialog "Frame rate" != sequence frame rate).
 *
 * Timeline maths stay at the sequence rate; only the final video is resampled to the output rate
 * (output frame n shows the sequence frame on screen at the middle of output frame n), so runtime and
 * A/V sync do not change. Real FFmpeg exports, checked with ffprobe and per-frame luma.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExportSettings, MediaItem, MediaProbe, Rational, Sequence } from '@shared/model';
import type { ExportRequest } from '@shared/ipc';
import { createSequence } from '@shared/project';
import { makeClip } from '@shared/timeline';
import { adaptFfmpegArgs, ffmpegMajorVersionSync } from '../../electron/media/ffmpeg';
import { buildRenderGraph, outputFrameIndex } from '../../electron/export/renderGraph';
import { runExport } from '../../electron/export/exporter';
import { planExportChunks } from '../../electron/export/chunks';
import { effectiveExportFps, exportOutputFrames, initialExportSettings } from '../../src/panels/export/settings';

const exec = promisify(execFile);
const FFMPEG = process.env.RECUT_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.RECUT_FFPROBE || 'ffprobe';

const R = (num: number, den = 1): Rational => ({ num, den });
const F23 = R(24000, 1001), F24 = R(24), F25 = R(25), F29 = R(30000, 1001), F30 = R(30), F50 = R(50), F59 = R(60000, 1001), F60 = R(60);
const ALL = [F23, F24, F25, F29, F30, F50, F59, F60];
/** An absolute output folder on every platform (win32: the current drive's \\out). */
const OUT_DIR = path.resolve('/out');
const key = (f: Rational) => `${f.num}/${f.den}`;
const val = (f: Rational) => f.num / f.den;

let dir: string;
let outN = 0;
/** Luma ramp media per frame rate: 64x36, frame m has luma 16 + (8m mod 200); 440 Hz stereo tone. 4 s. */
const lumaMedia = new Map<string, MediaItem>();

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

function settings(fps: Rational, over: Partial<ExportSettings> = {}): ExportSettings {
  return {
    outputDir: dir, fileName: `fps${outN++}.mp4`, width: 64, height: 36, fps,
    videoCodec: 'libx264', qualityMode: 'crf', crf: 10, videoBitrateKbps: 2000, preset: 'ultrafast',
    audioCodec: 'aac', audioBitrateKbps: 128, audioChannels: 2, sampleRate: 48000,
    rangeMode: 'entire', burnSubtitles: false, exportSubtitleSidecar: false, useProxies: false, ...over,
  };
}

/** Clip lengths (sequence frames) laid end to end; clip k starts at media frame (5k mod 17). Video + linked audio. */
function rampSeq(fps: Rational, lengths: number[]): { s: Sequence; media: MediaItem; srcFrame: (f: number) => number; frames: number } {
  const media = lumaMedia.get(key(fps))!;
  const s = createSequence('FPS', fps, 64, 36);
  const starts: { start: number; len: number; src: number }[] = [];
  let pos = 0;
  lengths.forEach((len, k) => {
    const src = (5 * k) % 17;
    const sourceIn = (src * fps.den) / fps.num;
    s.videoTracks[0].clips.push(makeClip({ mediaId: media.id, name: `v${k}`, sourceIn, duration: len, kind: 'video' }, pos));
    s.audioTracks[0].clips.push(makeClip({ mediaId: media.id, name: `a${k}`, sourceIn, duration: len, kind: 'audio', audioStream: media.probe!.audio[0].index }, pos));
    starts.push({ start: pos, len, src });
    pos += len;
  });
  const srcFrame = (f: number) => { const c = starts.find((x) => f >= x.start && f < x.start + x.len)!; return c.src + (f - c.start); };
  return { s, media, srcFrame, frames: pos };
}

const reqFor = (s: Sequence, media: MediaItem, out: Rational, over: Partial<ExportSettings> = {}): ExportRequest =>
  ({ sequence: s, media: { [media.id]: media }, settings: settings(out, over) });

/** Exact round(f * out / seq) (half away from zero), like FFmpeg's av_rescale_q_rnd(NEAR_INF). */
function roundScaled(f: number, seq: Rational, out: Rational): number {
  const n = BigInt(f) * BigInt(seq.den) * BigInt(out.num), d = BigInt(seq.num) * BigInt(out.den);
  return Number((2n * n + d) / (2n * d));
}
/** Sequence frame shown by output frame n: the last frame i with round(i * out / seq) <= n. */
function seqFrameForOutput(n: number, seq: Rational, out: Rational, frames: number): number {
  let i = Math.min(frames - 1, Math.floor(((n + 0.5) * seq.num * out.den) / (seq.den * out.num)) + 1);
  while (i > 0 && roundScaled(i, seq, out) > n) i--;
  return i;
}

interface OutProbe { rFrameRate: string; frames: number; vDur: number; aDur: number; formatDur: number }
async function probeOut(file: string): Promise<OutProbe> {
  const { stdout } = await exec(FFPROBE, ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,r_frame_rate,nb_read_frames,duration:format=duration', '-of', 'json', file]);
  const j = JSON.parse(stdout);
  const v = j.streams.find((s: any) => s.codec_type === 'video');
  const a = j.streams.find((s: any) => s.codec_type === 'audio');
  return { rFrameRate: v.r_frame_rate, frames: Number(v.nb_read_frames), vDur: Number(v.duration), aDur: Number(a.duration), formatDur: Number(j.format.duration) };
}

/** Mean luma of every output frame. */
async function lumaPerFrame(file: string): Promise<number[]> {
  const { stdout } = await exec(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', '0:v:0', '-vf', 'extractplanes=y,scale=1:1:flags=area', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  return [...(stdout as unknown as Buffer)];
}
const lumaOf = (mediaFrame: number) => 16 + ((mediaFrame * 8) % 200);

/** Frames whose luma does not match the expected sequence frame (first 10). */
function mismatches(luma: number[], seq: Rational, out: Rational, frames: number, srcFrame: (f: number) => number): string[] {
  const bad: string[] = [];
  for (let n = 0; n < luma.length; n++) {
    const want = lumaOf(srcFrame(seqFrameForOutput(n, seq, out, frames)));
    if (Math.abs(luma[n] - want) > 3) bad.push(`out ${n}: luma ${luma[n]} != ${want}`);
  }
  return bad.slice(0, 10);
}

function expectTiming(p: OutProbe, seq: Rational, out: Rational, frames: number): void {
  const seqDur = (frames * seq.den) / seq.num;
  const outFd = out.den / out.num;
  expect(p.rFrameRate).toBe(key(out));
  expect(Math.abs(p.frames - Math.round(seqDur * val(out)))).toBeLessThanOrEqual(1);
  expect(p.frames).toBe(roundScaled(frames, seq, out));
  expect(Math.abs(p.vDur - seqDur)).toBeLessThanOrEqual(outFd);
  expect(Math.abs(p.aDur - seqDur)).toBeLessThanOrEqual(outFd);
  expect(Math.abs(p.vDur - p.aDur)).toBeLessThanOrEqual(outFd);
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-export-fps-'));
  await Promise.all(ALL.map(async (f) => {
    const file = path.join(dir, `luma-${f.num}-${f.den}.mp4`);
    await ff(['-f', 'lavfi', '-i', `nullsrc=s=64x36:r=${key(f)}:d=4,geq=lum='16+mod(N*8,200)':cb=128:cr=128`,
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-g', '12', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', '-shortest', file]);
    const id = `m${f.num}_${f.den}`;
    lumaMedia.set(key(f), {
      id, name: path.basename(file), path: file, kind: 'video', category: 'Other', identity: {}, binId: null,
      probe: await probe(file), offline: false, proxy: { status: 'none' }, detectedScenes: [], subtitleTrackIds: [],
      notes: '', tags: [], addedAt: 0,
    });
  }));
}, 120000);

afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('export frame-rate conversion (single pass)', () => {
  const PAIRS: [string, Rational, Rational][] = [
    ['23.976 -> 30', F23, F30],
    ['59.94 -> 23.976 (down)', F59, F23],
    ['60 -> 24 (down)', F60, F24],
    ['25 -> 29.97', F25, F29],
    ['24 -> 50', F24, F50],
    ['29.97 -> 25', F29, F25],
    ['30 -> 59.94', F30, F59],
    ['50 -> 60', F50, F60],
  ];
  for (const [label, seqFps, outFps] of PAIRS) {
    it(`${label}: output rate, frame count, duration and frame choice`, async () => {
      // About 2 s of 3 clips (cuts inside the sequence exercise the frame choice at cuts).
      const n = Math.round(2 * val(seqFps));
      const a = Math.floor(n / 3), b = Math.floor(n / 4);
      const { s, media, srcFrame, frames } = rampSeq(seqFps, [a, b, n - a - b]);
      const res = await runExport(reqFor(s, media, outFps), undefined, undefined, { chunked: false });
      const p = await probeOut(res.outputPath);
      console.log(`[fps ${label}] r_frame_rate=${p.rFrameRate} frames=${p.frames} (seq ${frames}, expected ${roundScaled(frames, seqFps, outFps)}) v=${p.vDur} a=${p.aDur} seq=${(frames * seqFps.den / seqFps.num).toFixed(6)}`);
      expectTiming(p, seqFps, outFps, frames);
      expect(mismatches(await lumaPerFrame(res.outputPath), seqFps, outFps, frames, srcFrame)).toEqual([]);
      expect(res.warnings.filter((w) => /frame rate/i.test(w))).toEqual([]);
    }, 60000);
  }

  it('keeps NTSC rates rational in the graph and args (30000/1001, never 29.97)', () => {
    const { s, media } = rampSeq(F25, [50]);
    const g = buildRenderGraph(reqFor(s, media, F29));
    expect(g.videoCodecArgs.slice(-4)).toEqual(['-r', '30000/1001', '-fps_mode', 'cfr']);
    expect(g.filterGraph).toContain('fps=fps=30000/1001');
    expect(g.filterGraph + g.args.join(' ')).not.toMatch(/29\.97/);
    expect(g.outputFps).toEqual(F29);
    expect(g.outputFrameCount).toBe(60); // 2 s * 29.97 = 59.94 -> 60
    expect(g.frameCount).toBe(50); // sequence frames rendered
  });
});

describe('export frame-rate conversion: equal or invalid rates', () => {
  const fake = (fps: Rational): MediaItem => ({
    id: 'mf', name: 'a.mp4', path: '/media/a.mp4', kind: 'video', category: 'Other', identity: {}, binId: null,
    probe: {
      container: 'mov,mp4,m4a,3gp,3g2,mj2', duration: 10, size: 1, startTime: 0, browserPlayable: true, subtitles: [],
      video: { index: 0, codec: 'h264', width: 64, height: 36, fps, avgFps: fps, isVfr: false },
      audio: [{ index: 1, codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48000 }],
    },
    offline: false, proxy: { status: 'none' }, detectedScenes: [], subtitleTrackIds: [], notes: '', tags: [], addedAt: 0,
  });
  const fixedReq = (fps: Rational, outFps: Rational | undefined): ExportRequest => {
    const m = fake(fps);
    const s = createSequence('Fixed', fps, 64, 36);
    s.videoTracks[0].clips.push(makeClip({ mediaId: m.id, name: 'v', sourceIn: 1, duration: 30, kind: 'video' }, 0));
    s.audioTracks[0].clips.push(makeClip({ mediaId: m.id, name: 'a', sourceIn: 1, duration: 30, kind: 'audio', audioStream: 1 }, 0));
    return { sequence: s, media: { [m.id]: m }, settings: { ...settings(F23), outputDir: OUT_DIR, fileName: 'x.mp4', fps: outFps as Rational } };
  };

  // Recorded from the renderer before output frame-rate conversion existed (sequence 23.976, export 23.976).
  const BEFORE_FILTER = [
    "[0:v:0]trim=start=0.979146:duration=1.522104,settb=AVTB,setpts=PTS-1.000001/TB,fps=24000/1001:start_time=0,format=yuva420p,scale=w='if(gt(sar,1.000001),max(2,round(iw*sar/2)*2),iw)':h='if(lt(sar,0.999999),max(2,round(ih/sar/2)*2),ih)':flags=bicubic,setsar=1,scale=64:36:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=bicubic,setsar=1,pad=64:36:(ow-iw)/2:(oh-ih)/2:color=black@0,tpad=stop=30:stop_mode=clone,trim=end_frame=30,setpts=PTS-STARTPTS[v0]",
    '[v0]settb=1001/24000,setpts=N[tv1]',
    'color=c=black:s=64x36:r=24000/1001:d=1.292958,format=yuv420p,trim=end_frame=30,setpts=PTS-STARTPTS[vbase]',
    '[vbase][tv1]overlay=0:0:eof_action=pass:shortest=0[vcomp]',
    '[vcomp]format=yuv420p[vout]',
    '[0:1]atrim=start=1:duration=1.50125,asetpts=PTS-1/TB,aresample=async=1:first_pts=0,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad=whole_dur=1.25125,atrim=duration=1.25125,asetpts=PTS-STARTPTS[a2]',
    '[a2]asetpts=PTS-STARTPTS[ta3]',
    '[ta3]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[aout]',
  ].join(';\n');
  const BEFORE_ARGS = ['-hide_banner', '-nostdin', '-y', '-copyts', '-start_at_zero', '-t', '2.50125', '-i', '/media/a.mp4',
    '-filter_complex_script', '__FILTER_SCRIPT__', '-map', '[vout]', '-map', '[aout]',
    '-map_metadata:g', '-1', '-map_metadata:s', '-1', '-map_chapters', '-1',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '10', '-pix_fmt', 'yuv420p', '-r', '24000/1001', '-fps_mode', 'cfr',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', '-t', '1.25125', '-f', 'mp4', path.join(OUT_DIR, 'x.mp4')];

  it('equal rates produce byte-identical args and graph to before (no fps conversion added)', () => {
    const g = buildRenderGraph(fixedReq(F23, F23));
    expect(g.filterGraph).toBe(BEFORE_FILTER);
    expect(g.args).toEqual(BEFORE_ARGS);
    expect(g.warnings).toEqual([]);
    // An equivalent but unreduced rational is the same rate.
    const g2 = buildRenderGraph(fixedReq(F23, R(48000, 2002)));
    expect(g2.filterGraph).toBe(BEFORE_FILTER);
    expect(g2.args).toEqual(BEFORE_ARGS);
  });

  it('invalid export rates fall back to the sequence rate', () => {
    for (const bad of [R(0, 1), R(30, 0), R(-30, 1), R(29.97, 1), R(30, 1.5), R(NaN, 1), R(Infinity, 1), undefined]) {
      const g = buildRenderGraph(fixedReq(F23, bad));
      expect(g.filterGraph).toBe(BEFORE_FILTER);
      expect(g.args).toEqual(BEFORE_ARGS);
      expect(g.outputFps).toEqual(F23);
      expect(g.outputFrameCount).toBe(30);
    }
  });
});

describe('export frame-rate conversion: chunked export', () => {
  it('chunk graphs map to absolute output frames (no drift): outputs sum to the single-pass count', () => {
    const lengths = [1, 7, 5, 11, 1, 3, 9, 2, 13, 1, 4, 6, 1, 8];
    const { s, media, frames } = rampSeq(F23, lengths);
    for (const out of [F30, F25, F59, F24]) {
      const r = reqFor(s, media, out);
      const full = buildRenderGraph(r);
      expect(full.outputFrameCount).toBe(roundScaled(frames, F23, out));
      let sum = 0;
      for (const c of planExportChunks({ req: r, startF: 0, endF: frames }, 1, 'video')) {
        const k = outputFrameIndex(c.endF - full.startF, F23, out) - outputFrameIndex(c.startF - full.startF, F23, out);
        if (k === 0) continue; // the exporter merges a chunk without output frames into the next one
        const g = buildRenderGraph(r, { range: { startF: c.startF, endF: c.endF }, streams: 'video' });
        expect(g.outputFrameCount).toBe(k);
        sum += g.outputFrameCount;
      }
      expect(sum).toBe(full.outputFrameCount);
    }
  });

  const CHUNKED: [string, Rational, Rational, number[]][] = [
    ['23.976 -> 30', F23, F30, [1, 7, 5, 11, 1, 3, 9, 2, 13, 1, 4, 6, 1, 8, 5]],
    // 1-frame clips at 60 -> 24 make chunks with no output frame of their own (round(0.4) = round(0)).
    ['60 -> 24 (down, empty chunks)', F60, F24, [1, 1, 2, 7, 1, 5, 3, 1, 1, 9, 4, 1, 12, 2, 6, 1, 3, 8, 11, 2]],
    ['25 -> 29.97', F25, F29, [3, 7, 2, 9, 4, 1, 6, 5, 8, 2, 3]],
  ];
  for (const [label, seqFps, outFps, lengths] of CHUNKED) {
    it(`${label}: chunked output equals the single pass frame for frame`, async () => {
      const { s, media, srcFrame, frames } = rampSeq(seqFps, lengths);
      const progress: number[] = [];
      const res = await runExport(reqFor(s, media, outFps), (p) => progress.push(p), undefined, { chunked: true, maxSegmentsPerChunk: 1, maxAudioSegmentsPerChunk: 2 });
      expect(res.chunks).toBeGreaterThanOrEqual(5);
      for (let i = 1; i < progress.length; i++) expect(progress[i]).toBeGreaterThanOrEqual(progress[i - 1] - 1e-9);
      expect(progress[progress.length - 1]).toBe(1);
      const p = await probeOut(res.outputPath);
      console.log(`[fps chunked ${label}] ${res.chunks} chunks, r_frame_rate=${p.rFrameRate} frames=${p.frames} (seq ${frames}, expected ${roundScaled(frames, seqFps, outFps)}) v=${p.vDur} a=${p.aDur} seq=${(frames * seqFps.den / seqFps.num).toFixed(6)}`);
      expectTiming(p, seqFps, outFps, frames);
      const chunkedLuma = await lumaPerFrame(res.outputPath);
      expect(mismatches(chunkedLuma, seqFps, outFps, frames, srcFrame)).toEqual([]);

      const single = await runExport(reqFor(s, media, outFps), undefined, undefined, { chunked: false });
      const singleLuma = await lumaPerFrame(single.outputPath);
      expect(chunkedLuma.length).toBe(singleLuma.length);
      expect(chunkedLuma.map((v, i) => Math.abs(v - singleLuma[i]) <= 3).every(Boolean)).toBe(true);
    }, 120000);
  }
});

describe('export dialog frame-rate helpers', () => {
  it('dialog output frame count matches the render graph for every preset pair', () => {
    const fake: MediaItem = {
      id: 'mf', name: 'a.mp4', path: '/media/a.mp4', kind: 'video', category: 'Other', identity: {}, binId: null,
      probe: { container: 'mp4', duration: 100, size: 1, startTime: 0, browserPlayable: true, subtitles: [], audio: [],
        video: { index: 0, codec: 'h264', width: 64, height: 36, fps: F24, avgFps: F24, isVfr: false } },
      offline: false, proxy: { status: 'none' }, detectedScenes: [], subtitleTrackIds: [], notes: '', tags: [], addedAt: 0,
    };
    for (const seqFps of ALL) for (const outFps of ALL) for (const frames of [1, 2, 7, 1001, 1439]) {
      const s = createSequence('H', seqFps, 64, 36);
      s.videoTracks[0].clips.push(makeClip({ mediaId: fake.id, name: 'v', sourceIn: 0, duration: frames, kind: 'video' }, 0));
      const g = buildRenderGraph({ sequence: s, media: { [fake.id]: fake }, settings: { ...settings(outFps), outputDir: OUT_DIR } });
      expect(exportOutputFrames(frames, s, { fps: outFps })).toBe(g.outputFrameCount);
      expect(g.outputFrameCount).toBe(Math.max(1, roundScaled(frames, seqFps, outFps)));
    }
  });

  it('invalid saved / chosen frame rates fall back to the sequence rate', () => {
    const s = createSequence('H', F23, 64, 36);
    for (const bad of [R(0, 1), R(29.97, 1), R(30, 0), R(NaN, 1), undefined as unknown as Rational]) {
      expect(effectiveExportFps({ fps: bad }, s)).toBe(s.fps);
      expect(exportOutputFrames(48, s, { fps: bad })).toBe(48);
      const init = initialExportSettings(s, { sequenceId: s.id, settings: { ...settings(F30), fps: bad } }, { fallbackDir: '/x' });
      expect(init.fps).toEqual(F23);
    }
    expect(effectiveExportFps({ fps: F30 }, s)).toEqual(F30);
    expect(exportOutputFrames(48, s, { fps: F30 })).toBe(60);
  });
});
