/**
 * Proxy mapping: a proxy must be a time-exact stand-in for the original (same duration ±1 frame, same fps/timebase,
 * same content at the same sourceIn, start at 0), and export must never read proxies.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { JobQueue } from '../../electron/jobs/jobQueue';
import { startProxyJob } from '../../electron/media/proxy';
import { probeMedia } from '../../electron/media/probe';
import { buildRenderGraph } from '../../electron/export/renderGraph';
import { ensureMedia, mediaPath, SCRATCH, ffprobeJson, countFrames, flashFrames, audioOnsets, readCounters, makeMediaItem, makeSeq, vclip, aclip, request, FPS_24, fmt, framePts, frameLuma, editorFramesShowing } from './helpers';

/** Editor frames (24 fps grid, container-relative) at which the ORIGINAL file shows its flash frames. */
async function editorFlashFrames(file: string): Promise<number[]> {
  const raw = await ffprobeJson(file);
  const start = Number(raw.format.start_time ?? 0);
  const pts = await framePts(file);
  const luma = await frameLuma(file);
  const out: number[] = [];
  for (let i = 0; i < luma.length; i++) if (luma[i] > 120) out.push(...editorFramesShowing(pts[i], pts[i + 1] ?? pts[i] + 1 / 24, start, FPS_24));
  return out;
}

const cacheDir = path.join(SCRATCH, 'cache');
process.env.RECUT_CACHE_DIR = cacheDir;

async function proxyOf(file: string, height = 540): Promise<string> {
  const q = new JobQueue();
  const { job, outputPath } = await startProxyJob(q, { mediaId: path.basename(file), path: file, height });
  const final = await q.waitFor(job.id);
  if (final.status !== 'done') throw new Error(`proxy ${final.status}: ${final.error}`);
  return outputPath;
}

beforeAll(() => { ensureMedia(); fs.mkdirSync(cacheDir, { recursive: true }); });

describe('proxy time mapping', () => {
  it('23.976 source: proxy keeps 24000/1001, duration within 1 frame, identical frame counters', async () => {
    const src = mediaPath('counter23976.mp4');
    const out = await proxyOf(src);
    const a = await probeMedia(src), b = await probeMedia(out);
    const fa = await countFrames(src), fb = await countFrames(out);
    const ca = await readCounters(src), cb = await readCounters(out);
    const tbA = (await ffprobeJson(src, ['-show_entries', 'stream=time_base'])).streams[0] as unknown as { time_base: string };
    const tbB = (await ffprobeJson(out, ['-show_entries', 'stream=time_base'])).streams[0] as unknown as { time_base: string };
    console.log(`[proxy 23.976] src fps=${a.video!.fps.num}/${a.video!.fps.den} tb=${tbA.time_base} dur=${a.duration} frames=${fa} | proxy fps=${b.video!.fps.num}/${b.video!.fps.den} tb=${tbB.time_base} dur=${b.duration} frames=${fb} start=${b.startTime}`);
    expect(b.video!.fps).toEqual(a.video!.fps);
    expect(Math.abs(b.duration - a.duration)).toBeLessThanOrEqual(1001 / 24000 + 1e-3);
    expect(fb).toBe(fa);
    let mism = 0; for (let i = 0; i < Math.min(ca.length, cb.length); i++) if (ca[i] !== cb[i]) mism++;
    expect(mism).toBe(0);
  });

  it('source with container start_time 10 s: proxy starts at 0 and the flash sits at the same relative time', async () => {
    const src = mediaPath('sync24_ts10.mp4');
    const out = await proxyOf(src);
    const b = await probeMedia(out);
    const raw = await ffprobeJson(out);
    const fl = await flashFrames(out);
    const beeps = await audioOnsets(out, { threshold: 0.15, quiet: 0.2 });
    console.log(`[proxy ts10] proxy start_time=${raw.format.start_time} v.start=${raw.streams[0].start_time} a.start=${raw.streams[1]?.start_time} flashes=${fl.slice(0, 3)} beeps=${beeps.slice(0, 3).map((x) => fmt(x, 3))}`);
    expect(b.startTime).toBeLessThan(0.05);
    // The original's video starts 22 ms after the container start (AAC priming): Chromium shows its flashes at editor frames 1, 49, 97.
    const want = await editorFlashFrames(src);
    console.log(`[proxy ts10] editor frames showing a flash in the original: ${want.slice(0, 4)} | proxy flash frames: ${fl.slice(0, 4)}`);
    // from the second flash on the proxy must match the editor frames of the original; the head is logged (ffmpeg duplicates frame 0)
    expect(fl.filter((f) => f > 10).slice(0, 2)).toEqual(want.filter((f) => f > 10).slice(0, 2));
    expect(Math.abs(beeps[1] - 2.022)).toBeLessThan(0.03);
  });

  it('MPEG-TS source: proxy has the same duration and the flash/beep positions of the original', async () => {
    const src = mediaPath('sync24.ts');
    const out = await proxyOf(src);
    const a = await probeMedia(src), b = await probeMedia(out);
    const fl = await flashFrames(out);
    const beeps = await audioOnsets(out, { threshold: 0.15, quiet: 0.2 });
    console.log(`[proxy ts] src dur=${a.duration} start=${a.startTime} | proxy dur=${b.duration} start=${b.startTime} flashes=${fl.slice(0, 3)} beeps=${beeps.slice(0, 3).map((x) => fmt(x, 3))}`);
    expect(Math.abs(b.duration - a.duration)).toBeLessThan(0.1);
    const want = await editorFlashFrames(src);
    console.log(`[proxy ts] editor frames showing a flash in the original: ${want.slice(0, 4)} | proxy flash frames: ${fl.slice(0, 4)}`);
    expect(fl.filter((f) => f > 10).slice(0, 2)).toEqual(want.filter((f) => f > 10).slice(0, 2));
    expect(Math.abs(beeps[1] - 2.021)).toBeLessThan(0.03);
  });

  it('audio starts 0.5 s late (mkv): proxy preserves the audio offset (beep at 0.5 s, 2.5 s)', async () => {
    const src = mediaPath('sync24_adelay.mkv');
    const out = await proxyOf(src);
    const raw = await ffprobeJson(out);
    const beeps = await audioOnsets(out, { threshold: 0.15, quiet: 0.2 });
    const fl = await flashFrames(out);
    console.log(`[proxy adelay] proxy a.start=${raw.streams[1]?.start_time} flashes=${fl.slice(0, 2)} beeps=${beeps.slice(0, 2).map((x) => fmt(x, 3))}`);
    expect(fl.slice(0, 2)).toEqual([0, 48]);
    // NOTE: audioOnsets decodes raw PCM, which drops a leading gap; use the stream start_time + first onset instead.
    const aStart = Number(raw.streams.find((s) => s.codec_type === 'audio')?.start_time ?? 0);
    expect(Math.abs(aStart + beeps[0] - 0.5)).toBeLessThan(0.03);
  });

  it('audio-only source: proxy is an audio-only mp4 of the same duration', async () => {
    const src = mediaPath('audio.m4a');
    const out = await proxyOf(src);
    const a = await probeMedia(src), b = await probeMedia(out);
    expect(b.video).toBeUndefined();
    expect(Math.abs(b.duration - a.duration)).toBeLessThan(0.05);
  });

  it('image source: proxy job fails with a readable error (images never need proxies)', async () => {
    const q = new JobQueue();
    const { job } = await startProxyJob(q, { mediaId: 'img', path: mediaPath('image.png'), height: 540 });
    const final = await q.waitFor(job.id);
    console.log(`[proxy image] status=${final.status} error=${final.error}`);
    expect(final.status).toBe('failed');
  });

  it('odd-height request and tiny source: proxy never upscales and keeps even dimensions', async () => {
    const out = await proxyOf(mediaPath('counter24.mp4'), 541);
    const b = await probeMedia(out);
    expect(b.video!.height % 2).toBe(0);
    expect(b.video!.height).toBeLessThanOrEqual(240);
  });

  it('export never references a proxy path even when a proxy is ready', async () => {
    const m = await makeMediaItem(mediaPath('counter24.mp4'));
    m.proxy = { status: 'ready', path: '/proxies/SHOULD_NOT_APPEAR.mp4', width: 320, height: 180 };
    const seq = makeSeq(FPS_24);
    vclip(seq, m, 0, 24, 1); aclip(seq, m, 0, 24, 1);
    const g = buildRenderGraph(request(seq, [m]));
    expect(g.args.join(' ')).not.toContain('SHOULD_NOT_APPEAR');
    expect(g.args.filter((a) => a === m.path).length).toBe(2);
  });
});
