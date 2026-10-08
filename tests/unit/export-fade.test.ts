/**
 * Fades to / from black in the export (bugs/closed/2026-10-07-export-fade-to-black-ends-early.md): a single-sided
 * transition (`inClipId` or `outClipId` null) must render with the preview's per-frame weights. The reference is the
 * Program monitor's planner (src/playback/planner.ts planFrame): each layer drawn at its alpha over what is below it,
 * on black. Real FFmpeg exports of flat colours are measured by mean luma and must be within 1.5 levels (of 219) of
 * that composite on every frame: fade out and fade in, single-sided Dip to Black at both ends of a clip, a clip with a
 * speed change, static and keyframed opacity (the fade multiplies them), a fading clip over a lower track (the fade
 * reveals it, as in the preview), a chunked export and an In/Out range that starts inside a fade.
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
import { adaptFfmpegArgs, ffmpegMajorVersionSync } from '../../electron/media/ffmpeg';
import { buildRenderGraph } from '../../electron/export/renderGraph';
import { runExport, type ExportRunOptions } from '../../electron/export/exporter';
import { planFrame } from '../../src/playback/planner';

const exec = promisify(execFile);
const FFMPEG = process.env.RECUT_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.RECUT_FFPROBE || 'ffprobe';
const F24: Rational = { num: 24, den: 1 };
/** Allowed error of the mean luma (levels of 219). */
const TOL = 1.5;

let dir: string;
let outN = 0;
let white: MediaItem, gray: MediaItem;
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
    audio: [], subtitles: [], startTime: Number(j.format.start_time ?? 0), browserPlayable: true,
  };
}

async function media(name: string, color: string): Promise<MediaItem> {
  const file = path.join(dir, `${name}.mp4`);
  await ff(['-f', 'lavfi', '-i', `color=c=${color}:s=320x180:r=24:d=12`, '-c:v', 'libx264', '-crf', '0', '-pix_fmt', 'yuv420p', file]);
  return {
    id: name, name, path: file, kind: 'video', category: 'Other', identity: {}, binId: null, probe: await probe(file), offline: false,
    proxy: { status: 'none' }, detectedScenes: [], subtitleTrackIds: [], notes: '', tags: [], addedAt: 0,
  };
}

function req(s: Sequence, over: Partial<ExportSettings> = {}): ExportRequest {
  return {
    sequence: s, media: { [white.id]: white, [gray.id]: gray },
    settings: {
      outputDir: dir, fileName: `f${outN++}.mp4`, width: s.width, height: s.height, fps: s.fps,
      videoCodec: 'libx264', qualityMode: 'crf', crf: 0, videoBitrateKbps: 2000, preset: 'ultrafast',
      audioCodec: 'aac', audioBitrateKbps: 192, audioChannels: 2, sampleRate: 48000,
      rangeMode: 'entire', burnSubtitles: false, exportSubtitleSidecar: false, useProxies: false, ...over,
    },
  };
}

/** Mean luma of every output frame. */
async function frameLuma(file: string): Promise<number[]> {
  const { stdout: dims } = await exec(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]);
  const [w, h] = dims.trim().split(',').map(Number);
  const { stdout } = await exec(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', '0:v:0', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-'],
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

/** The preview's picture at a frame: every planned layer at its alpha over what is below it, on black (luma 16). */
function previewLuma(s: Sequence, frame: number): number {
  const plan = planFrame(s, { [white.id]: white, [gray.id]: gray }, frame, false);
  let y = 16;
  for (const l of [...plan.layers].sort((a, b) => a.trackIndex - b.trackIndex)) {
    const src = lumaOf.get(l.mediaId);
    if (src === undefined) throw new Error(`no reference luma for ${l.mediaId}`);
    y = l.alpha * src + (1 - l.alpha) * y;
  }
  return y;
}

const clipOf = (m: MediaItem, start: number, len: number, o: { sourceIn?: number; speed?: number } = {}) =>
  makeClip({ mediaId: m.id, name: m.name, sourceIn: o.sourceIn ?? 0, duration: len, kind: 'video', speed: o.speed }, start);
const fade = (id: string, outClipId: string | null, inClipId: string | null, duration: number, type: Transition['type'] = 'crossDissolve'): Transition =>
  ({ id, type, duration, outClipId, inClipId });

/**
 * Exports `s`, checks every frame against the preview within TOL and returns the largest error and the chunk count.
 * RECUT_FADE_LOG=1 prints every frame's export and preview luma.
 */
async function check(s: Sequence, label: string, over: Partial<ExportSettings> = {}, opts: ExportRunOptions = { chunked: false }, first = 0): Promise<{ worst: number; chunks: number }> {
  const res = await runExport(req(s, over), undefined, undefined, opts);
  const got = await frameLuma(res.outputPath);
  let worst = 0;
  got.forEach((y, i) => {
    const want = previewLuma(s, first + i);
    const err = Math.abs(y - want);
    worst = Math.max(worst, err);
    if (process.env.RECUT_FADE_LOG) console.log(`${label} ${first + i} ${y.toFixed(2)} ${want.toFixed(2)}`);
    expect.soft(err, `${label}: frame ${first + i} luma ${y.toFixed(2)} vs preview ${want.toFixed(2)}`).toBeLessThan(TOL);
  });
  return { worst, chunks: res.chunks };
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-fade-'));
  [white, gray] = await Promise.all([media('white', 'white'), media('gray', '0x808080')]);
  for (const m of [white, gray]) {
    const s = createSequence('ref', F24, 320, 180);
    s.videoTracks[0].clips.push(clipOf(m, 0, 2));
    const res = await runExport(req(s), undefined, undefined, { chunked: false });
    lumaOf.set(m.id, (await frameLuma(res.outputPath))[0]);
  }
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
    expect((await check(s, 'chunked', {}, { chunked: true, maxSegmentsPerChunk: 1 })).chunks).toBeGreaterThan(1);
    s.view = { ...s.view, inPoint: 14, outPoint: 40 };
    await check(s, 'in/out', { rangeMode: 'inOut' }, { chunked: false }, 14);
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

/**
 * Not this bug: two-sided transitions also differ from the preview (bugs/open/2026-10-08-two-sided-transition-preview-mismatch.md).
 * RECUT_FADE_LOG=1 runs this repro, which fails today.
 */
describe.runIf(process.env.RECUT_FADE_LOG)('two-sided transitions (repro of the open bug)', () => {
  it('Dip to Black and Cross Dissolve between two clips', async () => {
    const s = createSequence('dip2', F24, 320, 180);
    const a = clipOf(white, 0, 12, { sourceIn: 1 });
    const b = clipOf(gray, 12, 12, { sourceIn: 1 });
    const c = clipOf(white, 24, 12, { sourceIn: 1 });
    s.videoTracks[0].clips.push(a, b, c);
    s.videoTracks[0].transitions.push(fade('d', a.id, b.id, 6, 'dipToBlack'), fade('x', b.id, c.id, 6));
    await check(s, 'two-sided');
  }, 120000);
});
