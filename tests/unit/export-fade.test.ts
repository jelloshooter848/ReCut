/**
 * Fades and transitions in the export match the Program monitor's picture, frame by frame.
 *
 * - Fades to / from black (bugs/closed/2026-10-07-export-fade-to-black-ends-early.md): a single-sided transition
 *   (`inClipId` or `outClipId` null) renders with the preview's per-frame weights.
 * - Two-sided transitions (bugs/closed/2026-10-08-two-sided-transition-preview-mismatch.md): a Cross Dissolve is the
 *   linear mix (1 − t)·out + t·in, composited over what is below; a Dip to Black fades the outgoing clip to black over
 *   the first half and the incoming one up over the second, each on frames it shows anyway.
 *
 * The reference is the Program monitor's planner (src/playback/planner.ts planFrame) composited as
 * SequencePlayer.paint does: each layer at its alpha over what is below it, on black, and a dissolve's pair of layers
 * (LayerPlan.mixWith) added in premultiplied terms before going over what is below. Real FFmpeg exports of flat
 * colours are measured by mean luma (of the whole frame, or of a region where every layer is uniform) and must be
 * within 1.5 levels (of 219) of that composite on every frame.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExportSettings, ID, MediaItem, MediaProbe, Rational, Sequence, Transition } from '@shared/model';
import type { ExportRequest } from '@shared/ipc';
import { createSequence } from '@shared/project';
import { makeClip } from '@shared/timeline';
import { adaptFfmpegArgs, ffmpegMajorVersionSync } from '../../electron/media/ffmpeg';
import { buildRenderGraph } from '../../electron/export/renderGraph';
import { runExport, type ExportRunOptions } from '../../electron/export/exporter';
import { flattenSequence } from '@shared/nest';
import { mixesWith, planFrame, type LayerPlan } from '../../src/playback/planner';

const exec = promisify(execFile);
const FFMPEG = process.env.RECUT_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.RECUT_FFPROBE || 'ffprobe';
const F24: Rational = { num: 24, den: 1 };
/** Allowed error of the mean luma (levels of 219). */
const TOL = 1.5;

let dir: string;
let outN = 0;
let white: MediaItem, gray: MediaItem, dark: MediaItem;
/** A 4:3 picture (240x180): pillarboxed in the 320x180 sequence, transparent over the outer 40 columns. */
let dark43: MediaItem;
/** Mean luma of each source as the export renders it at full weight. */
const lumaOf = new Map<string, number>();

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

async function media(name: string, color: string, size = '320x180'): Promise<MediaItem> {
  const file = path.join(dir, `${name}.mp4`);
  await ff(['-f', 'lavfi', '-i', `color=c=${color}:s=${size}:r=24:d=12`, '-c:v', 'libx264', '-crf', '0', '-pix_fmt', 'yuv420p', file]);
  return {
    id: name, name, path: file, kind: 'video', category: 'Other', identity: {}, binId: null, probe: await probe(file), offline: false,
    proxy: { status: 'none' }, detectedScenes: [], subtitleTrackIds: [], notes: '', tags: [], addedAt: 0,
  };
}

const allMedia = (): Record<ID, MediaItem> => ({ [white.id]: white, [gray.id]: gray, [dark.id]: dark, [dark43.id]: dark43 });

function req(s: Sequence, over: Partial<ExportSettings> = {}, sequences?: Record<ID, Sequence>): ExportRequest {
  return {
    sequence: s, media: allMedia(), ...(sequences ? { sequences } : null),
    settings: {
      outputDir: dir, fileName: `f${outN++}.mp4`, width: s.width, height: s.height, fps: s.fps,
      videoCodec: 'libx264', qualityMode: 'crf', crf: 0, videoBitrateKbps: 2000, preset: 'ultrafast',
      audioCodec: 'aac', audioBitrateKbps: 192, audioChannels: 2, sampleRate: 48000,
      rangeMode: 'entire', burnSubtitles: false, exportSubtitleSidecar: false, useProxies: false, ...over,
    },
  };
}

/** A rectangle of the 320x180 frame (pixels). */
interface Region { x: number; y: number; w: number; h: number }
/** The centre of the frame, inside the 4:3 picture of `dark43` (away from its edges). */
const CENTRE: Region = { x: 60, y: 0, w: 200, h: 180 };
/** The left pillar, where `dark43` is transparent. */
const PILLAR: Region = { x: 0, y: 0, w: 32, h: 180 };

/** Mean luma of every output frame (of `region` when given). */
async function frameLuma(file: string, region?: Region): Promise<number[]> {
  const { stdout: dims } = await exec(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]);
  let [w, h] = dims.trim().split(',').map(Number);
  const crop = region ? ['-vf', `crop=${region.w}:${region.h}:${region.x}:${region.y}`] : [];
  if (region) { w = region.w; h = region.h; }
  const { stdout } = await exec(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', '0:v:0', ...crop, '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-'],
    { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 });
  const buf = stdout as unknown as Buffer;
  const size = w * h * 3 / 2; const out: number[] = [];
  for (let i = 0; i + size <= buf.length; i += size) {
    let sum = 0;
    for (let j = i; j < i + w * h; j++) sum += buf[j];
    out.push(sum / (w * h));
  }
  return out;
}

/** Whether a layer covers `region` (1) or is transparent over it (0): only `dark43` leaves the pillars empty. */
function coverage(l: LayerPlan, region?: Region): number {
  return region === PILLAR && l.mediaId === dark43.id ? 0 : 1;
}

/**
 * The preview's picture at a frame (SequencePlayer.paint): on black (luma 16), every planned layer at its alpha over
 * what is below it; a Cross Dissolve pair (mixesWith) is summed premultiplied (the scratch canvas, `lighter`) and the
 * sum goes over what is below. `seqs`: the project sequences a nested clip plays (the planner gets the flattened
 * sequence, as the Program monitor does).
 */
function previewLuma(s: Sequence, frame: number, region?: Region, seqs?: Record<ID, Sequence>): number {
  const media = allMedia();
  const plan = planFrame(seqs ? flattenSequence(s, seqs, media) : s, media, frame, false);
  const layers = plan.layers.filter((l) => l.alpha > 0).sort((a, b) => a.trackIndex - b.trackIndex);
  const lumaAt = (l: LayerPlan) => {
    const v = lumaOf.get(l.mediaId);
    if (v === undefined) throw new Error(`no reference luma for ${l.mediaId}`);
    return v;
  };
  let y = 16;
  for (let i = 0; i < layers.length; i++) {
    const l = layers[i];
    const a = l.alpha * coverage(l, region);
    const next = layers[i + 1];
    if (next && mixesWith(l, next)) {
      const b = next.alpha * coverage(next, region);
      y = a * lumaAt(l) + b * lumaAt(next) + (1 - Math.min(1, a + b)) * y;
      i++;
      continue;
    }
    y = a * lumaAt(l) + (1 - a) * y;
  }
  return y;
}

const clipOf = (m: MediaItem, start: number, len: number, o: { sourceIn?: number; speed?: number } = {}) =>
  makeClip({ mediaId: m.id, name: m.name, sourceIn: o.sourceIn ?? 0, duration: len, kind: 'video', speed: o.speed }, start);
const fade = (id: string, outClipId: string | null, inClipId: string | null, duration: number, type: Transition['type'] = 'crossDissolve'): Transition =>
  ({ id, type, duration, outClipId, inClipId });

interface CheckOptions {
  settings?: Partial<ExportSettings>;
  run?: ExportRunOptions;
  /** Timeline frame of the first output frame (an In/Out range). */
  first?: number;
  /** Measure these regions instead of the whole frame. */
  regions?: Region[];
  /** Project sequences that nested clips play. */
  sequences?: Record<ID, Sequence>;
}

/**
 * Exports `s`, checks every frame against the preview within TOL and returns the largest error and the chunk count.
 * RECUT_FADE_LOG=1 prints every frame's export and preview luma.
 */
async function check(s: Sequence, label: string, o: CheckOptions = {}): Promise<{ worst: number; chunks: number }> {
  const res = await runExport(req(s, o.settings, o.sequences), undefined, undefined, o.run ?? { chunked: false });
  const first = o.first ?? 0;
  let worst = 0;
  for (const region of o.regions ?? [undefined]) {
    const name = region ? `${label} [${region === PILLAR ? 'pillar' : region === CENTRE ? 'centre' : JSON.stringify(region)}]` : label;
    const got = await frameLuma(res.outputPath, region);
    got.forEach((y, i) => {
      const want = previewLuma(s, first + i, region, o.sequences);
      const err = Math.abs(y - want);
      worst = Math.max(worst, err);
      if (process.env.RECUT_FADE_LOG) console.log(`${name} ${first + i} ${y.toFixed(2)} ${want.toFixed(2)}`);
      expect.soft(err, `${name}: frame ${first + i} luma ${y.toFixed(2)} vs preview ${want.toFixed(2)}`).toBeLessThan(TOL);
    });
  }
  return { worst, chunks: res.chunks };
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-fade-'));
  [white, gray, dark, dark43] = await Promise.all([
    media('white', 'white'), media('gray', '0x808080'), media('dark', '0x404040'), media('dark43', '0x404040', '240x180'),
  ]);
  for (const m of [white, gray, dark]) {
    const s = createSequence('ref', F24, 320, 180);
    s.videoTracks[0].clips.push(clipOf(m, 0, 2));
    const res = await runExport(req(s), undefined, undefined, { chunked: false });
    lumaOf.set(m.id, (await frameLuma(res.outputPath))[0]);
  }
  lumaOf.set(dark43.id, lumaOf.get(dark.id)!); // the same colour, measured inside the picture
}, 120000);
afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

describe('fade to / from black: export matches the preview per frame', () => {
  it('fade out at the end of a clip with nothing after it (the reported case)', async () => {
    const s = createSequence('out', F24, 320, 180);
    const c = clipOf(white, 0, 36);
    s.videoTracks[0].clips.push(c);
    s.videoTracks[0].transitions.push(fade('t', c.id, null, 6));
    // Before the fix: 196, 157, 118, 78, 39 on frames 31-35 instead of 198.5, 162, 125.5, 89, 52.5.
    await check(s, 'fade out');
  }, 120000);

  it('fade in at the start of a clip with nothing before it', async () => {
    const s = createSequence('in', F24, 320, 180);
    const c = clipOf(white, 0, 24);
    s.videoTracks[0].clips.push(c);
    s.videoTracks[0].transitions.push(fade('t', null, c.id, 8));
    await check(s, 'fade in');
  }, 120000);

  it('single-sided Dip to Black at both ends of a clip, after a gap; a clip with a speed change', async () => {
    const s = createSequence('dip', F24, 320, 180);
    const a = clipOf(white, 4, 20);
    const b = clipOf(white, 30, 16, { speed: 2, sourceIn: 1 });
    s.videoTracks[0].clips.push(a, b);
    s.videoTracks[0].transitions.push(
      fade('t1', null, a.id, 5, 'dipToBlack'), fade('t2', a.id, null, 7, 'dipToBlack'),
      fade('t3', null, b.id, 6), fade('t4', b.id, null, 6),
    );
    await check(s, 'dip / speed');
  }, 120000);

  it('the fade multiplies static and keyframed opacity', async () => {
    const s = createSequence('opacity', F24, 320, 180);
    const a = clipOf(white, 0, 18);
    a.transform.opacity = 0.5;
    const b = clipOf(white, 18, 24);
    b.transform.keyframes = { opacity: [{ frame: 0, value: 0.2 }, { frame: 23, value: 0.9 }] };
    s.videoTracks[0].clips.push(a, b);
    s.videoTracks[0].transitions.push(fade('t1', null, a.id, 6), fade('t2', b.id, null, 10));
    await check(s, 'opacity');
  }, 120000);

  it('a fading clip over a lower track reveals that track, as in the preview', async () => {
    const s = createSequence('layers', F24, 320, 180);
    s.videoTracks[0].clips.push(clipOf(gray, 0, 24));
    const top = clipOf(white, 0, 24);
    s.videoTracks[1].clips.push(top);
    s.videoTracks[1].transitions.push(fade('t1', null, top.id, 6), fade('t2', top.id, null, 6));
    await check(s, 'over V1');
  }, 120000);

  it('chunked export, and an In/Out range that starts inside a fade', async () => {
    const s = createSequence('chunks', F24, 320, 180);
    const clips = [0, 1, 2, 3].map((i) => clipOf(i % 2 ? gray : white, i * 12, 12, { sourceIn: i * 0.25 }));
    s.videoTracks[0].clips.push(...clips);
    clips.forEach((c, i) => s.videoTracks[0].transitions.push(fade(`i${i}`, null, c.id, 4), fade(`o${i}`, c.id, null, 5)));
    // Chunk boundaries are never inside a fade (chunks.ts); each fade renders whole in its chunk.
    expect((await check(s, 'chunked', { run: { chunked: true, maxSegmentsPerChunk: 1 } })).chunks).toBeGreaterThan(1);
    s.view = { ...s.view, inPoint: 14, outPoint: 40 };
    await check(s, 'in/out', { settings: { rangeMode: 'inOut' }, first: 14 });
  }, 180000);

  it('emits no colour fade (vf_fade treats yuva420p as full range: luma went to 0, not 16)', () => {
    const s = createSequence('g', F24, 320, 180);
    const c = clipOf(white, 0, 36);
    s.videoTracks[0].clips.push(c);
    s.videoTracks[0].transitions.push(fade('t1', null, c.id, 6), fade('t2', c.id, null, 6));
    const g = buildRenderGraph(req(s)).filterGraph;
    expect(g).not.toMatch(/(^|[,\]])fade=/);
  });
});

describe('two-sided transitions: export matches the preview per frame', () => {
  /** Clips of `len` frames alternating white / gray from frame 0 (1 s of source handles), joined by `type` transitions. */
  function chain(name: string, type: Transition['type'], lengths: number[], len = 16): Sequence {
    const s = createSequence(name, F24, 320, 180);
    const clips = Array.from({ length: lengths.length + 1 }, (_, i) => clipOf(i % 2 ? gray : white, i * len, len, { sourceIn: 1 }));
    s.videoTracks[0].clips.push(...clips);
    lengths.forEach((D, i) => s.videoTracks[0].transitions.push(fade(`t${i}`, clips[i].id, clips[i + 1].id, D, type)));
    return s;
  }

  it('the reported case: a Dip to Black and a Cross Dissolve of 6 frames', async () => {
    const s = createSequence('dip2', F24, 320, 180);
    const a = clipOf(white, 0, 12, { sourceIn: 1 });
    const b = clipOf(gray, 12, 12, { sourceIn: 1 });
    const c = clipOf(white, 24, 12, { sourceIn: 1 });
    s.videoTracks[0].clips.push(a, b, c);
    s.videoTracks[0].transitions.push(fade('d', a.id, b.id, 6, 'dipToBlack'), fade('x', b.id, c.id, 6));
    // Before the fix, frames 9-15 exported 235, 16, 15, 43, 77, 105, 126 (xfade=fadeblack) against the preview's 235,
    // 162, 89, 16, 52.7, 89.3, 126; frames 21-27 of the dissolve were a linear mix in the export while the preview
    // dimmed to 153 at the cut (both layers over black). Now both are the linear mix: 126, 144, 162, 180, 198, 216, 235.
    const { worst } = await check(s, 'reported');
    expect(worst).toBeLessThan(TOL);
    expect(previewLuma(s, 24)).toBeCloseTo((lumaOf.get(white.id)! + lumaOf.get(gray.id)!) / 2, 6);
  }, 120000);

  it('Cross Dissolve of 1 to 8 frames (an odd length renders one frame less, in both)', async () => {
    await check(chain('xd', 'crossDissolve', [1, 2, 3, 4, 5, 6, 7, 8]), 'dissolve');
  }, 120000);

  it('Dip to Black of 1 to 8 and 12 frames', async () => {
    await check(chain('dip', 'dipToBlack', [1, 2, 3, 4, 5, 6, 7, 8, 12]), 'dip');
  }, 120000);

  it('Dip to Black needs no source handles: it renders in full where a dissolve would be dropped', async () => {
    const s = createSequence('nohandles', F24, 320, 180);
    // The white clip ends at the end of its media, the gray one starts at the start of its media.
    const a = clipOf(white, 0, 24, { sourceIn: 11 });
    const b = clipOf(gray, 24, 24);
    s.videoTracks[0].clips.push(a, b);
    s.videoTracks[0].transitions.push(fade('d', a.id, b.id, 10, 'dipToBlack'));
    expect(buildRenderGraph(req(s)).warnings.join('\n')).not.toMatch(/Transition/);
    await check(s, 'no handles');
  }, 120000);

  it('on V2 over V1: opacity and a pillarboxed picture mix over the track below', async () => {
    const s = createSequence('v2', F24, 320, 180);
    s.videoTracks[0].clips.push(clipOf(gray, 0, 48));
    const a = clipOf(white, 0, 16, { sourceIn: 1 });
    a.transform.opacity = 0.6;
    const b = clipOf(dark43, 16, 16, { sourceIn: 1 });
    const c = clipOf(white, 32, 16, { sourceIn: 1 });
    s.videoTracks[1].clips.push(a, b, c);
    s.videoTracks[1].transitions.push(fade('x', a.id, b.id, 8), fade('d', b.id, c.id, 6, 'dipToBlack'));
    // The centre has both pictures; in the pillars the 4:3 clip is transparent, so there the dissolve takes the white
    // clip out over V1 linearly (it does not darken the gray below).
    await check(s, 'V2', { regions: [CENTRE, PILLAR] });
    // Mid-dissolve in the pillar: (1 − t)·(white at 0.6 over gray) + t·gray, t = 1/2.
    const W = lumaOf.get(white.id)!, G = lumaOf.get(gray.id)!;
    expect(previewLuma(s, 16, PILLAR)).toBeCloseTo(0.5 * (0.6 * W + 0.4 * G) + 0.5 * G, 6);
  }, 120000);

  it('with keyframed and static opacity', async () => {
    const s = createSequence('kf', F24, 320, 180);
    const a = clipOf(white, 0, 24, { sourceIn: 1 });
    a.transform.keyframes = { opacity: [{ frame: 0, value: 1 }, { frame: 28, value: 0.3 }] };
    const b = clipOf(gray, 24, 24, { sourceIn: 1 });
    b.transform.opacity = 0.5;
    const c = clipOf(white, 48, 24, { sourceIn: 1 });
    c.transform.keyframes = { opacity: [{ frame: 0, value: 0.2 }, { frame: 23, value: 0.9 }] };
    s.videoTracks[0].clips.push(a, b, c);
    s.videoTracks[0].transitions.push(fade('x', a.id, b.id, 10), fade('d', b.id, c.id, 7, 'dipToBlack'));
    await check(s, 'keyframed');
  }, 120000);

  it('inside a nested sequence, and at the nested clip\'s edges (ramps, #73)', async () => {
    const I = createSequence('Inner', F24, 320, 180);
    const ia = clipOf(white, 0, 24, { sourceIn: 1 }), ib = clipOf(gray, 24, 24, { sourceIn: 1 }), ic = clipOf(white, 48, 24, { sourceIn: 1 });
    I.videoTracks[0].clips.push(ia, ib, ic);
    I.videoTracks[0].transitions.push(fade('ix', ia.id, ib.id, 6), fade('id', ib.id, ic.id, 5, 'dipToBlack'));
    const O = createSequence('Outer', F24, 320, 180);
    const before = clipOf(dark, 0, 24, { sourceIn: 1 });
    // Inner frames 6..66 at outer 24..84: the inner dissolve at outer 42, the inner dip at outer 66.
    const nest = { ...makeClip({ mediaId: I.id, name: 'Nest', sourceIn: 0.25, duration: 60, kind: 'video' }, 24), sequenceId: I.id };
    const after = clipOf(dark, 84, 24, { sourceIn: 1 });
    O.videoTracks[0].clips.push(before, nest, after);
    O.videoTracks[0].transitions.push(fade('ox', before.id, nest.id, 8), fade('od', nest.id, after.id, 6, 'dipToBlack'));
    await check(O, 'nested', { sequences: { [I.id]: I } });
  }, 120000);

  it('in a chunked export, and an In/Out range that starts inside a dissolve', async () => {
    const s = createSequence('chunks2', F24, 320, 180);
    const clips = [0, 1, 2, 3, 4, 5, 6].map((i) => clipOf(i % 2 ? gray : white, i * 16, 16, { sourceIn: 1 + i * 0.25 }));
    s.videoTracks[0].clips.push(...clips);
    // Cut 2 (frame 48) is a plain cut, so a chunk boundary can go there.
    const kinds: ([number, Transition['type']] | null)[] = [[6, 'crossDissolve'], [5, 'dipToBlack'], null, [8, 'crossDissolve'], [4, 'dipToBlack'], [3, 'crossDissolve']];
    kinds.forEach((k, i) => { if (k) s.videoTracks[0].transitions.push(fade(`t${i}`, clips[i].id, clips[i + 1].id, k[0], k[1])); });
    // Chunk boundaries are never inside a transition window (chunks.ts); each transition renders whole in its chunk.
    expect((await check(s, 'chunked transitions', { run: { chunked: true, maxSegmentsPerChunk: 1 } })).chunks).toBeGreaterThan(1);
    s.view = { ...s.view, inPoint: 14, outPoint: 70 };
    await check(s, 'in/out transitions', { settings: { rangeMode: 'inOut' }, first: 14 });
  }, 180000);

  it('the graph: a dissolve mixes premultiplied pictures over its window only; no fadeblack; nothing extra without one', () => {
    const s = chain('graph', 'crossDissolve', [6, 4]);
    s.videoTracks[0].transitions[1].type = 'dipToBlack';
    const g = buildRenderGraph(req(s)).filterGraph;
    expect(g).not.toMatch(/fadeblack/);
    expect(g.match(/xfade=transition=fade:duration=0\.25:offset=0,unpremultiply=inplace=1,format=yuva420p/g)).toHaveLength(1);
    expect(g.match(/format=yuva444p,premultiply=inplace=1/g)).toHaveLength(2);
    // The dissolve's windows: the first clip's last 6 frames (3 clip + 3 handle frames), the second clip's first 6.
    expect(g).toMatch(/trim=start_frame=13:end_frame=19,setpts=PTS-STARTPTS/);
    expect(g).toMatch(/trim=start_frame=0:end_frame=6,setpts=PTS-STARTPTS/);
    // A track of cuts, fades and dips only: no split, no 4:4:4, no premultiply, no xfade.
    const plain = chain('plain', 'dipToBlack', [6, 4]);
    plain.videoTracks[0].transitions.push(fade('f', null, plain.videoTracks[0].clips[0].id, 4));
    expect(buildRenderGraph(req(plain)).filterGraph).not.toMatch(/split=|yuva444p|premultiply|xfade/);
  });
});

describe('audio crossfade: the export\'s gain law is the preview\'s', () => {
  let tone: MediaItem, silence: MediaItem;
  beforeAll(async () => {
    const mk = async (name: string, src: string): Promise<MediaItem> => {
      const file = path.join(dir, `${name}.wav`);
      await ff(['-f', 'lavfi', '-i', src, '-t', '12', '-ac', '2', '-c:a', 'pcm_s16le', file]);
      return {
        id: name, name, path: file, kind: 'audio', category: 'Other', identity: {}, binId: null, probe: await probe(file), offline: false,
        proxy: { status: 'none' }, detectedScenes: [], subtitleTrackIds: [], notes: '', tags: [], addedAt: 0,
      };
    };
    [tone, silence] = await Promise.all([mk('tone', 'sine=frequency=1000:sample_rate=48000'), mk('silence', 'anullsrc=r=48000:cl=stereo')]);
  }, 60000);

  it('linear (1 − t, t) on both sides; at the start of every frame the export\'s gain is the preview\'s', async () => {
    const s = createSequence('xfade', F24, 320, 180);
    const aclip = (m: MediaItem, start: number) => makeClip({ mediaId: m.id, name: m.name, sourceIn: 1, duration: 24, kind: 'audio', audioStream: m.probe!.audio[0].index }, start);
    const a = aclip(tone, 0), b = aclip(silence, 24), c = aclip(tone, 48);
    s.audioTracks[0].clips.push(a, b, c);
    s.audioTracks[0].transitions.push(fade('x1', a.id, b.id, 12, 'audioCrossfade'), fade('x2', b.id, c.id, 7, 'audioCrossfade'));
    const media = { [tone.id]: tone, [silence.id]: silence };
    const res = await runExport({ sequence: s, media, settings: { ...req(s).settings, fileName: `a${outN++}.wav`, container: 'wav', audioBitDepth: 24 } },
      undefined, undefined, { chunked: false });
    const { stdout } = await exec(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', res.outputPath, '-ac', '1', '-f', 'f32le', '-'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
    const buf = stdout as unknown as Buffer;
    const x = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
    const SPF = 2000; // samples per frame at 48 kHz, 24 fps
    /** RMS of `n` samples from `i` (whole periods of the 1 kHz tone). */
    const rms = (i: number, n: number) => { let q = 0; for (let k = i; k < i + n; k++) q += x[k] * x[k]; return Math.sqrt(q / n); };
    const full = rms(2 * SPF, 4 * SPF);
    const rows: string[] = [];
    let worstStart = 0, worstMean = 0;
    for (let f = 14; f < 58; f++) {
      const want = planFrame(s, media, f, false).audio.filter((p) => p.mediaId === tone.id).reduce((t, p) => t + p.gain, 0);
      const atStart = rms(f * SPF, 96) / full; // the first 2 ms (two periods) of the frame
      const mean = rms(f * SPF, SPF) / full;
      worstStart = Math.max(worstStart, Math.abs(atStart - want));
      worstMean = Math.max(worstMean, Math.abs(mean - want));
      rows.push(`${f} ${want.toFixed(3)} ${atStart.toFixed(3)} ${mean.toFixed(3)}`);
    }
    if (process.env.RECUT_FADE_LOG) console.log(`frame preview-gain export-at-frame-start export-frame-rms\n${rows.join('\n')}`);
    expect(worstStart, rows.join('\n')).toBeLessThan(0.02);
    // Within a frame the export ramps on while the preview holds the frame's gain: at most one frame's step apart.
    expect(worstMean).toBeLessThan(1 / 6 + 0.02);
  }, 120000);
});
