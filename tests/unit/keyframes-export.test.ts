/**
 * Keyframes in the export (Roadmap §11): the filters the render graph emits (and does not emit for clips without
 * keyframes), and real FFmpeg exports measured against the evaluator in shared/keyframes.ts:
 *  - position: the centroid of a moving box is within 0.25 px of the evaluated position on every frame (linear,
 *    ease, a speed-changed clip, an In/Out range that starts inside the clip);
 *  - scale: the box's area is within 1.5 % of the evaluated size;
 *  - opacity: the mean luma of a white picture over black is within 1 level (of 219) of 16 + 219 × opacity;
 *  - level: the RMS of a tone over 10-period windows is within 0.5 dB of the evaluated gain (single pass and chunked);
 *  - a keyframed clip whose values match a static transform renders the same picture as the static chain.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExportSettings, Keyframe, MediaItem, MediaProbe, Rational, Sequence } from '@shared/model';
import type { ExportRequest } from '@shared/ipc';
import { createSequence } from '@shared/project';
import { makeClip } from '@shared/timeline';
import { evaluateClipProperty, evaluateKeyframes } from '@shared/keyframes';
import { adaptFfmpegArgs, ffmpegMajorVersionSync } from '../../electron/media/ffmpeg';
import { buildRenderGraph, LEVEL_BLOCK_SAMPLES } from '../../electron/export/renderGraph';
import { runExport } from '../../electron/export/exporter';
import { keyframedScaleRatio, sequenceExportWarnings } from '../../src/panels/export/settings';

const exec = promisify(execFile);
const FFMPEG = process.env.RECUT_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.RECUT_FFPROBE || 'ffprobe';
const F24: Rational = { num: 24, den: 1 };
const F23: Rational = { num: 24000, den: 1001 };
const kf = (frame: number, value: number, interp?: 'ease'): Keyframe => (interp ? { frame, value, interp } : { frame, value });

let dir: string;
let outN = 0;
beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-keyframes-')); });
afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

async function ff(args: string[]): Promise<void> {
  await exec(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...adaptFfmpegArgs(args, ffmpegMajorVersionSync(FFMPEG))], { maxBuffer: 64 * 1024 * 1024 });
}

async function probe(file: string): Promise<MediaProbe> {
  const { stdout } = await exec(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const j = JSON.parse(stdout);
  const v = j.streams.find((s: { codec_type: string }) => s.codec_type === 'video');
  const rat = (r: string) => { const [n, d] = r.split('/').map(Number); return { num: n, den: d || 1 }; };
  return {
    container: j.format.format_name, duration: Number(j.format.duration), size: Number(j.format.size),
    video: v ? { index: v.index, codec: v.codec_name, width: v.width, height: v.height, fps: rat(v.r_frame_rate), avgFps: rat(v.avg_frame_rate), isVfr: false } : undefined,
    audio: j.streams.filter((s: { codec_type: string }) => s.codec_type === 'audio').map((s: { index: number; codec_name: string; channels: number; channel_layout?: string; sample_rate: string }) => ({
      index: s.index, codec: s.codec_name, channels: s.channels, layout: s.channel_layout ?? '', sampleRate: Number(s.sample_rate),
    })),
    subtitles: [], startTime: Number(j.format.start_time ?? 0), browserPlayable: true,
  };
}

async function media(name: string, args: string[], ext = 'mp4', kind: MediaItem['kind'] = 'video'): Promise<MediaItem> {
  const file = path.join(dir, `${name}.${ext}`);
  await ff([...args, file]);
  return {
    id: name, name, path: file, kind, category: 'Other', identity: {}, binId: null, probe: await probe(file), offline: false,
    proxy: { status: 'none' }, detectedScenes: [], subtitleTrackIds: [], notes: '', tags: [], addedAt: 0,
  };
}

function req(s: Sequence, items: MediaItem[], over: Partial<ExportSettings> = {}): ExportRequest {
  const m: Record<string, MediaItem> = {};
  for (const x of items) m[x.id] = x;
  return {
    sequence: s, media: m,
    settings: {
      outputDir: dir, fileName: `k${outN++}.${over.container === 'wav' ? 'wav' : 'mp4'}`, width: s.width, height: s.height, fps: s.fps,
      videoCodec: 'libx264', qualityMode: 'crf', crf: 0, videoBitrateKbps: 2000, preset: 'ultrafast',
      audioCodec: 'aac', audioBitrateKbps: 192, audioChannels: 2, sampleRate: 48000,
      rangeMode: 'entire', burnSubtitles: false, exportSubtitleSidecar: false, useProxies: false, ...over,
    },
  };
}

/** Raw Y planes of every output frame. */
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

/** Coverage-weighted centroid (pixel centres at +0.5), area and mean luma of a white-on-black frame. */
function measure(y: Buffer, w: number): { cx: number; cy: number; area: number; mean: number } {
  let sw = 0, sx = 0, sy = 0, sum = 0;
  for (let i = 0; i < y.length; i++) {
    sum += y[i];
    const c = Math.min(1, Math.max(0, (y[i] - 16) / 219));
    if (c <= 0) continue;
    const px = i % w, py = (i - px) / w;
    sw += c; sx += c * (px + 0.5); sy += c * (py + 0.5);
  }
  return { cx: sx / sw, cy: sy / sw, area: sw, mean: sum / y.length };
}

const vclip = (m: MediaItem, start: number, len: number, o: { sourceIn?: number; speed?: number; name?: string } = {}) =>
  makeClip({ mediaId: m.id, name: o.name ?? 'v', sourceIn: o.sourceIn ?? 0, duration: len, kind: 'video', speed: o.speed }, start);

// ---------------------------------------------------------------------------------------------------
// Render graph strings
// ---------------------------------------------------------------------------------------------------

describe('render graph', () => {
  const m: MediaItem = {
    id: 'm', name: 'm', path: '/media/m.mp4', kind: 'video', category: 'Other', identity: {}, binId: null, offline: false,
    probe: { container: 'mp4', duration: 60, size: 1, startTime: 0, browserPlayable: true, subtitles: [],
      video: { index: 0, codec: 'h264', width: 1920, height: 1080, fps: F24, avgFps: F24, isVfr: false },
      audio: [{ index: 1, codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48000 }] },
    proxy: { status: 'none' }, detectedScenes: [], subtitleTrackIds: [], notes: '', tags: [], addedAt: 0,
  };
  const graph = (build: (s: Sequence) => void, over: Partial<ExportSettings> = {}) => {
    const s = createSequence('g', F24, 1920, 1080);
    build(s);
    return buildRenderGraph(req(s, [m], over)).filterGraph;
  };

  it('clips without keyframes get none of the per-frame filters', () => {
    const script = graph((s) => {
      const v = vclip(m, 0, 48); v.transform.scale = 0.5; v.transform.opacity = 0.5;
      const a = makeClip({ mediaId: 'm', name: 'a', sourceIn: 0, duration: 48, kind: 'audio' }, 0); a.audio.volume = 0.5;
      s.videoTracks[0].clips.push(v); s.audioTracks[0].clips.push(a);
    });
    expect(script).not.toMatch(/perspective|sendcmd|lut@|eval=frame|asetnsamples/);
    expect(script).toContain("lut=a='val*0.5'");
    expect(script).toContain('volume=0.5');
  });

  it('keyframed position / scale: perspective per frame after the exact-length trim, frame counter offset by the clip frame', () => {
    const script = graph((s) => {
      const v = vclip(m, 10, 48, { sourceIn: 1 });
      v.transform.keyframes = { x: [kf(0, 0), kf(24, 100, 'ease')], scale: [kf(0, 0.5), kf(24, 0.25)] };
      s.videoTracks[0].clips.push(v);
    }, { rangeMode: 'inOut' });
    const chain = script.split('\n').find((l) => l.includes('perspective'))!;
    expect(chain).toBeDefined();
    expect(chain.indexOf('perspective')).toBeGreaterThan(chain.indexOf('trim=end_frame=48'));
    expect(chain).toContain('sense=destination:eval=frame');
    expect(chain).toContain('(in-1+0)');
    // the largest scale used (0.5) is applied first with bicubic; the canvas centres the picture
    expect(chain).toMatch(/scale=w='max\(2,trunc\(iw\*0\.5\/2\)\*2\)'/);
    expect(chain).toContain("pad=w='iw+4*ceil((1928-iw)/4)'");
    expect(chain).toContain("crop=w=1920:h=1080:x='2*floor((iw-1920)/4)'");
  });

  it('an In/Out range that starts inside the clip offsets the clip frame', () => {
    const s = createSequence('g', F24, 1920, 1080);
    const v = vclip(m, 10, 48, { sourceIn: 1 });
    v.transform.keyframes = { x: [kf(0, 0), kf(24, 100)] };
    s.videoTracks[0].clips.push(v);
    s.view.inPoint = 20; s.view.outPoint = 50;
    const script = buildRenderGraph(req(s, [m], { rangeMode: "inOut" })).filterGraph;
    expect(script).toContain('(in-1+10)');
  });

  it('keyframed opacity: sendcmd drives a named lut, only when the value changes', () => {
    const script = graph((s) => {
      const v = vclip(m, 0, 48);
      v.transform.opacity = 0.2; // ignored while animated
      v.transform.keyframes = { opacity: [kf(10, 0), kf(14, 1)] };
      s.videoTracks[0].clips.push(v);
    });
    expect(script).not.toContain("lut=a='val*0.2'");
    const m1 = /sendcmd=c='([^']*)',(lut@kfo\d+)=a='val\*0'/.exec(script);
    expect(m1).not.toBeNull();
    const cmds = m1![1].split(';');
    expect(cmds).toHaveLength(4); // frames 11, 12, 13, 14 (frame 10 holds 0, after 14 it holds 1)
    expect(cmds[0]).toBe(`0.4375-0.479167 ${m1![2]} a val*0.25`);
    expect(cmds[3]).toBe(`0.5625-2.020833 ${m1![2]} a val*1`);
  });

  it('keyframed level: volume per 256-sample block at the block middle, the static level skipped', () => {
    const script = graph((s) => {
      const a = makeClip({ mediaId: 'm', name: 'a', sourceIn: 0, duration: 48, kind: 'audio' }, 0);
      a.audio.volume = 0.3; a.audio.gain = -6;
      a.audio.keyframes = { volume: [kf(0, 1, 'ease'), kf(24, 0.5)] };
      s.audioTracks[0].clips.push(a);
    }, { container: 'wav' });
    expect(LEVEL_BLOCK_SAMPLES).toBe(256);
    expect(script).toContain('volume=-6dB');
    expect(script).not.toContain('volume=0.3');
    expect(script).toContain("asetnsamples=n=256:p=0,volume=volume='st(0,(if(isnan(t),0,t)+128/sample_rate)*24/1+0);1+(-0.5)*clip((ld(0)-0)/24,0,1)*clip((ld(0)-0)/24,0,1)*(3-2*clip((ld(0)-0)/24,0,1))':eval=frame");
  });
});

describe('pre-export warnings', () => {
  const m: MediaItem = {
    id: 'm', name: 'm', path: '/media/m.mp4', kind: 'video', category: 'Other', identity: {}, binId: null, offline: false,
    probe: { container: 'mp4', duration: 60, size: 1, startTime: 0, browserPlayable: true, subtitles: [],
      video: { index: 0, codec: 'h264', width: 1920, height: 1080, fps: F24, avgFps: F24, isVfr: false }, audio: [] },
    proxy: { status: 'none' }, detectedScenes: [], subtitleTrackIds: [], notes: '', tags: [], addedAt: 0,
  };
  it('lists keyframed clips (info) and warns when a keyframed scale shrinks below half of what the export pre-filters', () => {
    const s = createSequence('w', F24, 1920, 1080);
    const plain = vclip(m, 0, 24, { name: 'plain' });
    const gentle = vclip(m, 24, 24, { name: 'gentle' });
    gentle.transform.keyframes = { scale: [kf(0, 1), kf(23, 1.6)], opacity: [kf(0, 0), kf(10, 1)] };
    const shrink = vclip(m, 48, 24, { name: 'shrink' });
    shrink.transform.keyframes = { scale: [kf(0, 0.8), kf(23, 0.3)] };
    s.videoTracks[0].clips.push(plain, gentle, shrink);
    expect(keyframedScaleRatio(plain)).toBe(1);
    expect(keyframedScaleRatio(gentle)).toBe(1);
    expect(keyframedScaleRatio(shrink)).toBeCloseTo(0.375, 9);
    const items = sequenceExportWarnings(s, { m }, 0, 72);
    const info = items.find((i) => i.text.startsWith('Keyframes on 2 clips'))!;
    expect(info.level).toBe('info');
    expect(info.target!.clipIds).toEqual([gentle.id, shrink.id]);
    const warn = items.find((i) => i.text.startsWith('Keyframed scale shrinks'))!;
    expect(warn.level).toBe('warning');
    expect(warn.target).toEqual({ frame: 48, clipIds: [shrink.id] });
    expect(sequenceExportWarnings(s, { m }, 0, 24).some((i) => /Keyframe/.test(i.text))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------
// Real FFmpeg
// ---------------------------------------------------------------------------------------------------

describe('real FFmpeg exports match the evaluator', () => {
  let white: MediaItem, pattern: MediaItem, tone: MediaItem;
  beforeAll(async () => {
    white = await media('white', ['-f', 'lavfi', '-i', 'color=c=white:s=64x36:r=24:d=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-pix_fmt', 'yuv420p']);
    pattern = await media('pattern', ['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=24:d=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-pix_fmt', 'yuv420p']);
    tone = await media('tone', ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4', '-ac', '2', '-c:a', 'pcm_s16le'], 'wav', 'audio');
  }, 60000);

  it('position (linear, ease, speed-changed clip, range starting inside a clip): centroid within 0.25 px', async () => {
    const s = createSequence('pos', F24, 320, 180);
    const a = vclip(white, 0, 30);
    a.transform.scale = 0.25;
    a.transform.keyframes = { x: [kf(2, -100, 'ease'), kf(26, 100)], y: [kf(0, -40), kf(29, 50)] };
    const b = vclip(white, 30, 20, { speed: 2, sourceIn: 0.5 });
    b.transform.scale = 0.25;
    b.transform.keyframes = { x: [kf(0, 80), kf(19, -80)], y: [kf(0, 10.5)] };
    s.videoTracks[0].clips.push(a, b);
    s.view.inPoint = 4; s.view.outPoint = 50;
    const res = await runExport(req(s, [white], { rangeMode: 'inOut' }), undefined, undefined, { chunked: false });
    const { frames, w } = await yPlanes(res.outputPath);
    expect(frames).toHaveLength(46);
    for (let n = 0; n < frames.length; n++) {
      const f = 4 + n;
      const c = f < 30 ? a : b;
      const got = measure(frames[n], w);
      expect.soft(Math.abs(got.cx - (160 + evaluateClipProperty('x', c, f))), `x at frame ${f}`).toBeLessThan(0.25);
      expect.soft(Math.abs(got.cy - (90 + evaluateClipProperty('y', c, f))), `y at frame ${f}`).toBeLessThan(0.25);
    }
  }, 120000);

  it('scale (ease, with a down-scale pre-pass): width and height within 1 px, centred', async () => {
    const s = createSequence('scale', F24, 320, 180);
    const c = vclip(white, 0, 24);
    c.transform.keyframes = { scale: [kf(0, 0.2, 'ease'), kf(20, 0.6)] };
    s.videoTracks[0].clips.push(c);
    const res = await runExport(req(s, [white]), undefined, undefined, { chunked: false });
    const { frames, w } = await yPlanes(res.outputPath);
    expect(frames).toHaveLength(24);
    frames.forEach((y, f) => {
      const S = evaluateKeyframes(c.transform.keyframes!.scale!, f);
      const got = measure(y, w);
      // coverage summed along the middle row / column: the box's width / height
      let bw = 0, bh = 0;
      for (let x = 0; x < w; x++) bw += Math.min(1, Math.max(0, (y[90 * w + x] - 16) / 219));
      for (let r = 0; r < 180; r++) bh += Math.min(1, Math.max(0, (y[r * w + 160] - 16) / 219));
      expect.soft(Math.abs(bw - 320 * S), `width at frame ${f}`).toBeLessThan(1);
      expect.soft(Math.abs(bh - 180 * S), `height at frame ${f}`).toBeLessThan(1);
      expect.soft(Math.abs(got.cx - 160), `centre x at frame ${f}`).toBeLessThan(0.25);
      expect.soft(Math.abs(got.cy - 90), `centre y at frame ${f}`).toBeLessThan(0.25);
    });
  }, 120000);

  it('opacity (ease, then linear): mean luma within 1.5 levels; a fade to black multiplies it like a static opacity', async () => {
    const render = async (keys: Keyframe[] | null) => {
      const s = createSequence('opacity', F24, 320, 180);
      const c = vclip(white, 0, 36);
      if (keys) c.transform.keyframes = { opacity: keys };
      s.videoTracks[0].clips.push(c);
      s.videoTracks[0].transitions.push({ id: 't', type: 'crossDissolve', duration: 6, outClipId: c.id, inClipId: null });
      const res = await runExport(req(s, [white]), undefined, undefined, { chunked: false });
      return { c, ...(await yPlanes(res.outputPath)) };
    };
    const keyed = await render([kf(0, 0, 'ease'), kf(12, 1), kf(24, 0.3), kf(30, 1)]);
    const plain = await render(null);
    expect(keyed.frames).toHaveLength(36);
    keyed.frames.forEach((y, f) => {
      const got = measure(y, keyed.w).mean;
      if (f < 30) {
        const want = 16 + 219 * evaluateClipProperty('opacity', keyed.c, f);
        expect.soft(Math.abs(got - want), `luma at frame ${f}`).toBeLessThan(1.5);
      } else {
        // the fade to black (frames 30-35) over opacity 1: the same picture as the static chain's fade
        expect.soft(Math.abs(got - measure(plain.frames[f], plain.w).mean), `fade at frame ${f}`).toBeLessThan(1);
      }
    });
  }, 120000);

  it('a keyframed clip holding a static transform renders like the static chain (crop, rotation, offset)', async () => {
    const t = { x: 40, y: -20, scale: 0.8, rotation: 2.5, opacity: 1, crop: { left: 0.05, top: 0, right: 0.05, bottom: 0.1 } };
    const render = async (keyed: boolean) => {
      const s = createSequence('geo', F24, 320, 180);
      const c = vclip(pattern, 0, 12);
      c.transform = { ...t, crop: { ...t.crop }, ...(keyed ? { keyframes: { x: [kf(0, 40)], scale: [kf(0, 0.8), kf(11, 0.8)] } } : {}) };
      s.videoTracks[0].clips.push(c);
      const res = await runExport(req(s, [pattern]), undefined, undefined, { chunked: false });
      return yPlanes(res.outputPath);
    };
    const [st, kd] = [await render(false), await render(true)];
    for (const n of [0, 6, 11]) {
      let d = 0;
      for (let i = 0; i < st.frames[n].length; i++) d += Math.abs(st.frames[n][i] - kd.frames[n][i]);
      expect(d / st.frames[n].length, `mean |Δluma| at frame ${n}`).toBeLessThan(3);
    }
  }, 120000);

  it('level (ease down, hold, linear up) on a 23.976 fps sequence: within 0.5 dB, single pass and chunked', async () => {
    const s = createSequence('level', F23, 320, 180);
    const c = makeClip({ mediaId: tone.id, name: 'tone', sourceIn: 0.25, duration: 72, kind: 'audio' }, 12);
    c.audio.keyframes = { volume: [kf(0, 1, 'ease'), kf(24, 0.1), kf(36, 0.1), kf(60, 1.5)] };
    c.audio.fadeOut = 6;
    s.audioTracks[0].clips.push(c);
    const ref = 0.125 / Math.SQRT2; // RMS of the sine source (amplitude 1/8)
    for (const chunked of [false, true]) {
      const res = await runExport(req(s, [tone], { container: 'wav' }), undefined, undefined,
        chunked ? { chunked: true, maxSegmentsPerChunk: 1, maxAudioSegmentsPerChunk: 1 } : { chunked: false });
      const { stdout } = await exec(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', res.outputPath, '-map', '0:a:0', '-ac', '1', '-f', 'f32le', '-'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
      const b = stdout as unknown as Buffer;
      const pcm = new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4));
      const fps = 24000 / 1001;
      const win = 1091; // ten periods of 440 Hz
      let checked = 0;
      for (let start = Math.round(12 / fps * 48000); start + win < Math.round(84 / fps * 48000); start += 480) {
        let e = 0, g2 = 0;
        for (let i = start; i < start + win; i++) {
          e += pcm[i] * pcm[i];
          const g = evaluateClipProperty('volume', c, (i + 0.5) / 48000 * fps) * Math.min(1, Math.max(0, (84 - (i + 0.5) / 48000 * fps) / 6));
          g2 += g * g;
        }
        const want = ref * Math.sqrt(g2 / win);
        if (want < ref * 0.05) continue; // the last frames of the fade-out
        const db = 20 * Math.log10(Math.sqrt(e / win) / want);
        expect.soft(Math.abs(db), `${chunked ? 'chunked' : 'single'}: level at ${(start / 48000).toFixed(3)} s`).toBeLessThan(0.5);
        checked++;
      }
      expect(checked).toBeGreaterThan(250);
    }
  }, 120000);
});
