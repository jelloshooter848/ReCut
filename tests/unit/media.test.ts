/**
 * Integration-style unit tests for the FFmpeg media layer. Synthetic media is generated with
 * ffmpeg into a temp dir; the cache is redirected via RECUT_CACHE_DIR.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-media-test-'));
process.env.RECUT_CACHE_DIR = path.join(tmp, 'cache');

// Import after the env var is set (modules read it lazily anyway).
import { getFfmpegPath, getFfprobePath, getFfmpegVersion, runFfmpeg, runFfprobeJson, FfmpegError } from '../../electron/media/ffmpeg';
import { probeMedia, classifyKind, parseRational, probeFromFfprobe } from '../../electron/media/probe';
import { getCacheDir, cacheKeyForFile, cacheKeyForPath } from '../../electron/media/cache';
import { getThumbnail, getFilmstrip, frameSeekTime } from '../../electron/media/thumbs';
import { getWaveform, computeWaveform } from '../../electron/media/waveform';
import { downsamplePeaks } from '../../electron/media/peaks';
import { startProxyJob, buildProxyArgs, proxyOutputPath } from '../../electron/media/proxy';
import { startSceneDetectJob, enforceMinSceneGap, parseShowinfoPts } from '../../electron/media/sceneDetect';
import { extractSubtitles } from '../../electron/media/subtitlesExtract';
import { JobQueue, laneFor } from '../../electron/jobs/jobQueue';
import { mediaHandlers, jobQueue } from '../../electron/media/index';

const FF = getFfmpegPath() ?? 'ffmpeg';
const files = {
  aac: path.join(tmp, 'aac.mp4'),
  ac3: path.join(tmp, 'ac3.mp4'),
  scene: path.join(tmp, 'scene.mp4'),
  subs: path.join(tmp, 'subs.mp4'),
  srt: path.join(tmp, 'tiny.srt'),
  long: path.join(tmp, 'long.mp4'),
  png: path.join(tmp, 'still.png'),
  silent: path.join(tmp, 'silent.mp4'),
  audioOnly: path.join(tmp, 'tone.m4a'),
};

function ff(args: string[]): void {
  execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 120_000 });
}

beforeAll(() => {
  // 6s testsrc + 440Hz sine, h264 + aac
  ff(['-f', 'lavfi', '-i', 'testsrc=duration=6:size=320x240:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6,volume=15dB',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', files.aac]);
  // same with ac3 audio
  ff(['-f', 'lavfi', '-i', 'testsrc=duration=6:size=320x240:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'ac3', '-shortest', files.ac3]);
  // scene cut at 3.0s: red → blue
  ff(['-f', 'lavfi', '-i', 'color=c=red:size=320x240:rate=24:duration=3', '-f', 'lavfi', '-i', 'color=c=blue:size=320x240:rate=24:duration=3',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', files.scene]);
  // subtitles: mux a tiny SRT as mov_text
  fs.writeFileSync(files.srt, '1\n00:00:00,500 --> 00:00:02,000\nHello world\n\n2\n00:00:03,000 --> 00:00:04,500\nSecond line\n', 'utf8');
  ff(['-i', files.aac, '-i', files.srt, '-map', '0', '-map', '1', '-c', 'copy', '-c:s', 'mov_text', '-metadata:s:s:0', 'language=eng', files.subs]);
  // longer / larger clip for cancel test
  ff(['-f', 'lavfi', '-i', 'testsrc=duration=40:size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=40',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '35', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', files.long]);
  // still image
  ff(['-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=1', '-frames:v', '1', files.png]);
  // video without audio
  ff(['-f', 'lavfi', '-i', 'testsrc=duration=2:size=160x120:rate=24', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', files.silent]);
  // audio only
  ff(['-f', 'lavfi', '-i', 'sine=frequency=330:duration=3', '-c:a', 'aac', files.audioOnly]);
}, 180_000);

afterAll(async () => {
  jobQueue.cancelAll();
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
});

// ------------------------------------------------------------------
describe('ffmpeg wrapper', () => {
  it('resolves binaries and version', async () => {
    expect(getFfmpegPath()).toBeTruthy();
    expect(getFfprobePath()).toBeTruthy();
    const v = await getFfmpegVersion();
    expect(v).toMatch(/^(n?\d|N-|git-)/); // release (6.1.1, n7.1) or development (N-…) build
  });

  it('reports progress 0..1 and rejects with readable errors', async () => {
    const progress: number[] = [];
    const out = path.join(tmp, 'prog.mp4');
    await runFfmpeg(['-i', files.aac, '-c:v', 'libx264', '-preset', 'ultrafast', '-an', '-f', 'mp4', out], {
      duration: 6,
      onProgress: (p) => progress.push(p),
    }).promise;
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[progress.length - 1]).toBe(1);
    for (const p of progress) { expect(p).toBeGreaterThanOrEqual(0); expect(p).toBeLessThanOrEqual(1); }

    await expect(runFfmpeg(['-i', path.join(tmp, 'missing.mp4'), '-f', 'null', '-']).promise)
      .rejects.toThrow(/No such file|exited with code/);
  });

  it('cancel kills the process', async () => {
    const run = runFfmpeg(['-i', files.long, '-c:v', 'libx264', '-preset', 'veryslow', '-f', 'null', '-'], { duration: 40 });
    setTimeout(() => run.cancel(), 200);
    const err = await run.promise.catch((e) => e);
    expect(err).toBeInstanceOf(FfmpegError);
    expect((err as FfmpegError).canceled).toBe(true);
  });

  it('runFfprobeJson parses JSON', async () => {
    const j = await runFfprobeJson<{ format: { format_name: string } }>(['-show_format', files.aac]);
    expect(j.format.format_name).toContain('mp4');
  });
});

// ------------------------------------------------------------------
describe('probe', () => {
  it('probes an h264/aac mp4', async () => {
    const p = await probeMedia(files.aac);
    expect(p.container).toBe('mp4');
    expect(p.duration).toBeGreaterThan(5.8);
    expect(p.duration).toBeLessThan(6.3);
    expect(p.size).toBeGreaterThan(0);
    expect(p.video).toBeDefined();
    expect(p.video!.codec).toBe('h264');
    expect(p.video!.width).toBe(320);
    expect(p.video!.height).toBe(240);
    expect(p.video!.fps).toEqual({ num: 24, den: 1 });
    expect(p.video!.isVfr).toBe(false);
    expect(p.video!.pixFmt).toBe('yuv420p');
    expect(p.audio).toHaveLength(1);
    expect(p.audio[0].codec).toBe('aac');
    expect(p.audio[0].channels).toBe(1);
    expect(p.audio[0].layout).toBe('mono');
    expect(p.audio[0].sampleRate).toBe(44100);
    expect(p.browserPlayable).toBe(true);
    expect(p.playabilityReason).toBeUndefined();
    expect(classifyKind(p, files.aac)).toBe('video');
  });

  it('flags ac3 audio as not browser playable', async () => {
    const p = await probeMedia(files.ac3);
    expect(p.audio[0].codec).toBe('ac3');
    expect(p.browserPlayable).toBe(false);
    expect(p.playabilityReason).toMatch(/ac3/);
  });

  it('classifies images, audio-only and subtitle streams', async () => {
    const img = await probeMedia(files.png);
    expect(classifyKind(img, files.png)).toBe('image');
    expect(img.duration).toBe(0);
    expect(img.video?.width).toBe(64);

    const au = await probeMedia(files.audioOnly);
    expect(au.video).toBeUndefined();
    expect(classifyKind(au, files.audioOnly)).toBe('audio');
    expect(au.browserPlayable).toBe(true);

    const subs = await probeMedia(files.subs);
    expect(subs.subtitles).toHaveLength(1);
    expect(subs.subtitles[0].codec).toBe('mov_text');
    expect(subs.subtitles[0].language).toBe('eng');
  });

  it('parses rationals and detects VFR / 10-bit', () => {
    expect(parseRational('24000/1001')).toEqual({ num: 24000, den: 1001 });
    expect(parseRational('48/2')).toEqual({ num: 24, den: 1 });
    expect(parseRational('0/0')).toEqual({ num: 0, den: 1 });
    const p = probeFromFfprobe({
      format: { format_name: 'matroska,webm', duration: '10' },
      streams: [
        { index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, r_frame_rate: '60/1', avg_frame_rate: '24000/1001', pix_fmt: 'yuv420p10le' },
        { index: 1, codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } },
        { index: 2, codec_type: 'audio', codec_name: 'eac3', channels: 6 },
      ],
    }, '/x/movie.mkv', 123);
    expect(p.container).toBe('matroska');
    expect(p.video!.index).toBe(0);
    expect(p.video!.isVfr).toBe(true);
    expect(p.audio[0].layout).toBe('5.1');
    expect(p.browserPlayable).toBe(false);
    expect(p.playabilityReason).toMatch(/high bit depth/);
    expect(p.size).toBe(123);
  });
});

// ------------------------------------------------------------------
describe('cache', () => {
  it('uses RECUT_CACHE_DIR and stable keys', async () => {
    expect(getCacheDir()).toBe(path.join(tmp, 'cache'));
    expect(cacheKeyForFile('/a/b.mp4', 10, 20)).toBe(cacheKeyForFile('/a/b.mp4', 10, 20));
    expect(cacheKeyForFile('/a/b.mp4', 10, 20)).not.toBe(cacheKeyForFile('/a/b.mp4', 11, 20));
    expect(await cacheKeyForPath(files.aac)).toMatch(/^[0-9a-f]{40}$/);
  });
});

// ------------------------------------------------------------------
describe('thumbnails', () => {
  it('extracts and caches a thumbnail', async () => {
    const t0 = Date.now();
    const p = await getThumbnail({ path: files.aac, time: 2, width: 160 });
    const first = Date.now() - t0;
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.statSync(p).size).toBeGreaterThan(1000);
    expect(p).toMatch(/[\\/]thumbs[\\/][0-9a-f]{40}[\\/]2000_160\.jpg$/);
    const t1 = Date.now();
    const p2 = await getThumbnail({ path: files.aac, time: 2, width: 160 });
    const second = Date.now() - t1;
    expect(p2).toBe(p);
    expect(second).toBeLessThan(Math.max(50, first / 2));
    // JPEG magic
    const head = fs.readFileSync(p).subarray(0, 3);
    expect([...head]).toEqual([0xff, 0xd8, 0xff]);
  });

  it('falls back when the time is beyond the end', async () => {
    const p = await getThumbnail({ path: files.aac, time: 99, width: 120 });
    expect(fs.existsSync(p)).toBe(true);
  });

  it('deduplicates concurrent identical requests', async () => {
    const reqs = Array.from({ length: 5 }, () => getThumbnail({ path: files.aac, time: 4.25, width: 100 }));
    const paths = await Promise.all(reqs);
    expect(new Set(paths).size).toBe(1);
    expect(fs.existsSync(paths[0])).toBe(true);
  });

  it('filmstrip returns aligned paths (batched, including a past-EOF time)', async () => {
    const times = [0, 1, 2, 3, 4, 5, 5.5, 50];
    const paths = await getFilmstrip({ path: files.aac, times, width: 96 });
    expect(paths).toHaveLength(times.length);
    for (const [i, p] of paths.entries()) {
      expect(fs.existsSync(p)).toBe(true);
      expect(fs.statSync(p).size).toBeGreaterThan(500);
      expect(path.basename(p)).toBe(`${Math.round(times[i] * 1000)}_96.jpg`);
    }
    // second call is fully cached
    const again = await getFilmstrip({ path: files.aac, times, width: 96 });
    expect(again).toEqual(paths);
    // no stray .part files
    const dir = path.dirname(paths[0]);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.part'))).toHaveLength(0);
  });

  it('thumbnails a still image', async () => {
    const p = await getThumbnail({ path: files.png, time: 0, width: 32 });
    expect(fs.statSync(p).size).toBeGreaterThan(200);
  });
});

// ------------------------------------------------------------------
describe('waveform', () => {
  it('computes peaks at 50/sec and caches them', async () => {
    const key = await cacheKeyForPath(files.aac);
    const w = await getWaveform(files.aac, key);
    expect(w.rate).toBe(50);
    expect(w.duration).toBeGreaterThan(5.8);
    expect(Math.abs(w.peaks.length - 300)).toBeLessThanOrEqual(5);
    let max = 0;
    for (const v of w.peaks) max = Math.max(max, v);
    expect(max).toBeGreaterThan(100);
    // every bucket of a continuous sine should be loud
    const quiet = [...w.peaks.subarray(5, 290)].filter((v) => v < 50).length;
    expect(quiet).toBe(0);

    expect(fs.existsSync(path.join(getCacheDir(), 'waves', `${key}.pk`))).toBe(true);
    expect(fs.existsSync(path.join(getCacheDir(), 'waves', `${key}.json`))).toBe(true);
    const cached = await getWaveform(files.aac, key);
    expect(cached.peaks.length).toBe(w.peaks.length);
    expect([...cached.peaks.subarray(0, 20)]).toEqual([...w.peaks.subarray(0, 20)]);
  });

  it('returns empty peaks for files without audio', async () => {
    const w = await computeWaveform(files.silent);
    expect(w.peaks.length).toBe(0);
    expect(w.rate).toBe(50);
    expect(w.duration).toBeGreaterThan(1.5);
  });

  it('downsamplePeaks is a max-reducer', () => {
    const peaks = new Uint8Array(100);
    peaks[10] = 200; peaks[55] = 90;
    const out = downsamplePeaks(peaks, 50, 0, 2, 4); // 2s → 4 buckets of 0.5s (25 src each)
    expect([...out]).toEqual([200, 0, 90, 0]);
    expect([...downsamplePeaks(peaks, 50, -1, 0, 2)]).toEqual([0, 0]);
  });
});

// ------------------------------------------------------------------
describe('jobs', () => {
  it('proxy job completes and output probes OK', async () => {
    const q = new JobQueue({ throttleMs: 10 });
    const snapshots: number[] = [];
    q.subscribe((jobs) => snapshots.push(jobs.length));
    const { job, outputPath } = await startProxyJob(q, { mediaId: 'm1', path: files.aac, height: 180 });
    expect(['queued', 'running']).toContain(job.status); // add() starts immediately when a lane is free
    expect(outputPath).toMatch(/_180p_all\.mp4$/);
    const final = await q.waitFor(job.id);
    expect(final.status).toBe('done');
    expect(final.progress).toBe(1);
    const result = final.result as { path: string; height?: number };
    expect(result.path).toBe(outputPath);
    expect(fs.existsSync(outputPath)).toBe(true);
    expect(fs.existsSync(`${outputPath}.part`)).toBe(false);
    const p = await probeMedia(outputPath);
    expect(p.video!.height).toBe(180);
    expect(p.video!.width).toBe(240);
    expect(p.video!.codec).toBe('h264');
    expect(p.audio[0].codec).toBe('aac');
    expect(p.audio[0].channels).toBe(2);
    expect(p.duration).toBeGreaterThan(5.5);
    expect(p.browserPlayable).toBe(true);
    // cached second run
    const second = await startProxyJob(q, { mediaId: 'm1', path: files.aac, height: 180 });
    const f2 = await q.waitFor(second.job.id);
    expect(f2.status).toBe('done');
    expect((f2.result as { cached: boolean }).cached).toBe(true);
    q.flush();
    expect(snapshots.length).toBeGreaterThan(0);
  }, 60_000);

  it('starting the same proxy twice returns the in-flight job (QA-06)', async () => {
    const q = new JobQueue();
    const [a, b] = await Promise.all([
      startProxyJob(q, { mediaId: 'dup', path: files.long, height: 144 }),
      startProxyJob(q, { mediaId: 'dup', path: files.long, height: 144 }),
    ]);
    expect(b.job.id).toBe(a.job.id);
    expect(b.outputPath).toBe(a.outputPath);
    expect(q.list().filter((j) => j.kind === 'proxy')).toHaveLength(1);
    q.cancel(a.job.id);
    await q.waitFor(a.job.id);
    // settled: a new request starts a new job
    const c = await startProxyJob(q, { mediaId: 'dup', path: files.long, height: 144 });
    expect(c.job.id).not.toBe(a.job.id);
    q.cancel(c.job.id);
    await q.waitFor(c.job.id);
    expect(fs.readdirSync(path.dirname(a.outputPath)).filter((f) => f.includes('.part'))).toEqual([]);
  }, 60_000);

  it('scene detection is de-duplicated by media + threshold (QA-06)', async () => {
    const q = new JobQueue();
    const req = { mediaId: 'sd', path: files.long, threshold: 0.3, duration: 40 };
    const a = startSceneDetectJob(q, req);
    const b = startSceneDetectJob(q, req);
    const c = startSceneDetectJob(q, { ...req, threshold: 0.5 });
    expect(b.id).toBe(a.id);
    expect(c.id).not.toBe(a.id);
    q.cancel(a.id); q.cancel(c.id);
    await Promise.all([q.waitFor(a.id), q.waitFor(c.id)]);
  }, 60_000);

  it('audio-only proxy produces an audio mp4', async () => {
    const q = new JobQueue();
    const { job, outputPath } = await startProxyJob(q, { mediaId: 'a', path: files.audioOnly, height: 540 });
    const final = await q.waitFor(job.id);
    expect(final.status).toBe('done');
    const p = await probeMedia(outputPath);
    expect(p.video).toBeUndefined();
    expect(p.audio[0].codec).toBe('aac');
  }, 60_000);

  it('canceling a running proxy leaves no output behind', async () => {
    const q = new JobQueue();
    const { job, outputPath } = await startProxyJob(q, { mediaId: 'long', path: files.long, height: 720 });
    // wait until running + a little encoding time
    const deadline = Date.now() + 10_000;
    while (q.get(job.id)?.status !== 'running' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(q.get(job.id)?.status).toBe('running');
    await new Promise((r) => setTimeout(r, 400));
    q.cancel(job.id);
    const final = await q.waitFor(job.id);
    expect(final.status).toBe('canceled');
    await new Promise((r) => setTimeout(r, 50));
    expect(fs.existsSync(outputPath)).toBe(false);
    expect(fs.existsSync(`${outputPath}.part`)).toBe(false);
  }, 60_000);

  it('scene detection finds the cut', async () => {
    const q = new JobQueue();
    const job = startSceneDetectJob(q, { mediaId: 's', path: files.scene, threshold: 0.3, duration: 6 });
    const final = await q.waitFor(job.id);
    expect(final.status).toBe('done');
    const r = final.result as { boundaries: number[]; duration: number };
    expect(r.duration).toBe(6);
    expect(r.boundaries.length).toBe(1);
    expect(Math.abs(r.boundaries[0] - 3)).toBeLessThan(0.2);
    const key = await cacheKeyForPath(files.scene);
    expect(fs.existsSync(path.join(getCacheDir(), 'scenes', `${key}_0.300.json`))).toBe(true);
    // cached path
    const job2 = startSceneDetectJob(q, { mediaId: 's', path: files.scene, threshold: 0.3, duration: 6 });
    const f2 = await q.waitFor(job2.id);
    expect((f2.result as { boundaries: number[] }).boundaries).toEqual(r.boundaries);
  }, 60_000);

  it('scene helpers', () => {
    expect(parseShowinfoPts('[Parsed_showinfo_2 @ 0x1] n:   0 pts:  73728 pts_time:3.00000 duration: 512')).toBeCloseTo(3);
    expect(parseShowinfoPts('frame=  10 fps=0.0')).toBeNull();
    expect(enforceMinSceneGap([0.2, 1.0, 1.5, 2.1, 5], 1)).toEqual([1.0, 2.1, 5]);
  });

  it('JobQueue: concurrency, cancel while queued, clear, throttled snapshots', async () => {
    const q = new JobQueue({ mediaConcurrency: 2, throttleMs: 50 });
    let emits = 0;
    const unsub = q.subscribe(() => { emits++; });
    const started: string[] = [];
    const mk = (name: string, ms: number) => q.add({
      kind: 'waveform', title: name, run: (ctx) => new Promise<string>((resolve, reject) => {
        started.push(name);
        const t = setTimeout(() => resolve(name), ms);
        ctx.onCancel(() => { clearTimeout(t); reject(new Error('canceled')); });
        for (let i = 0; i < 50; i++) ctx.setProgress(i / 50);
      }),
    });
    const a = mk('a', 150), b = mk('b', 150), c = mk('c', 50);
    expect(q.list().map((j) => j.status)).toEqual(['running', 'running', 'queued']);
    q.cancel(c.id);
    expect(q.get(c.id)?.status).toBe('canceled');
    q.cancel(b.id);
    const [fa, fb] = await Promise.all([q.waitFor(a.id), q.waitFor(b.id)]);
    expect(fa.status).toBe('done');
    expect(fa.result).toBe('a');
    expect(fb.status).toBe('canceled');
    expect(started).toEqual(['a', 'b']);
    const failing = q.add({ kind: 'probe', title: 'f', run: async () => { throw new Error('boom'); } });
    const ff2 = await q.waitFor(failing.id);
    expect(ff2.status).toBe('failed');
    expect(ff2.error).toBe('boom');
    q.flush();
    // 100 setProgress calls per job must not produce 100 emits
    expect(emits).toBeLessThan(20);
    expect(emits).toBeGreaterThan(0);
    q.clear();
    expect(q.list()).toHaveLength(0);
    unsub();
  });

  it('export lane is separate from the media lane', async () => {
    const q = new JobQueue({ mediaConcurrency: 1 });
    const slow = q.add({ kind: 'proxy', title: 'slow', run: () => new Promise((r) => setTimeout(() => r(1), 100)) });
    const exp = q.add({ kind: 'export', title: 'exp', run: async () => 2 });
    expect(q.get(exp.id)?.status).toBe('running');
    await Promise.all([q.waitFor(slow.id), q.waitFor(exp.id)]);
  });

  it('scene detection has its own lane (concurrency 1): long detects never starve proxies (P-07)', async () => {
    expect(laneFor('sceneDetect')).toBe('background');
    expect(laneFor('proxy')).toBe('media');
    expect(laneFor('waveform')).toBe('media');
    expect(laneFor('export')).toBe('export');
    const q = new JobQueue();
    const releases: (() => void)[] = [];
    const longJob = (title: string) => q.add({ kind: 'sceneDetect', title, run: (ctx) => new Promise<void>((resolve, reject) => {
      releases.push(resolve);
      ctx.onCancel(() => reject(new Error('canceled')));
    }) });
    const d1 = longJob('detect 1'), d2 = longJob('detect 2');
    // Only one detect runs; the second waits in the background lane.
    expect(q.get(d1.id)?.status).toBe('running');
    expect(q.get(d2.id)?.status).toBe('queued');
    // Proxies and waveforms start immediately, both media slots free.
    const p1 = q.add({ kind: 'proxy', title: 'p1', run: async () => 'p1' });
    const p2 = q.add({ kind: 'proxy', title: 'p2', run: async () => 'p2' });
    const w = q.add({ kind: 'waveform', title: 'w', run: async () => 'w' });
    expect(q.get(p1.id)?.status).toBe('running');
    expect(q.get(p2.id)?.status).toBe('running');
    expect(q.get(w.id)?.status).toBe('queued'); // media lane limit 2
    const done = await Promise.all([q.waitFor(p1.id), q.waitFor(p2.id), q.waitFor(w.id)]);
    expect(done.map((j) => j.status)).toEqual(['done', 'done', 'done']);
    expect(q.get(d1.id)?.status).toBe('running');
    // Finishing the first detect starts the second.
    releases[0]();
    await q.waitFor(d1.id);
    await new Promise((r) => setTimeout(r, 0));
    expect(q.get(d2.id)?.status).toBe('running');
    q.cancel(d2.id);
    expect((await q.waitFor(d2.id)).status).toBe('canceled');
    await new Promise((r) => setTimeout(r, 0));
    expect(q.activeCount).toBe(0);
  });

  it('OCR shares the background lane with scene detection; language downloads run 2 at a time in the network lane', async () => {
    expect(laneFor('ocr')).toBe('background');
    expect(laneFor('download')).toBe('network');
    expect(laneFor('transcribe')).toBe('media');
    const q = new JobQueue({ mediaConcurrency: 1 });
    const releases: (() => void)[] = [];
    const held = (kind: 'ocr' | 'sceneDetect' | 'download', title: string) => q.add({ kind, title, run: () => new Promise<void>((resolve) => { releases.push(resolve); }) });
    const detect = held('sceneDetect', 'detect');
    const ocr = held('ocr', 'ocr');
    const d1 = held('download', 'd1'), d2 = held('download', 'd2'), d3 = held('download', 'd3');
    const proxy = q.add({ kind: 'proxy', title: 'p', run: async () => 'p' });
    expect(q.get(detect.id)?.status).toBe('running');
    expect(q.get(ocr.id)?.status).toBe('queued'); // background lane limit 1
    expect([d1, d2, d3].map((j) => q.get(j.id)?.status)).toEqual(['running', 'running', 'queued']);
    expect(q.get(proxy.id)?.status).toBe('running'); // neither lane takes a media slot
    expect(q.activeCount).toBe(4); // detect + two downloads + proxy: the network lane counts too
    expect((await q.waitFor(proxy.id)).status).toBe('done');
    releases.splice(0).forEach((r) => r());
    await Promise.all([q.waitFor(detect.id), q.waitFor(d1.id), q.waitFor(d2.id)]);
    await new Promise((r) => setTimeout(r, 0));
    expect(q.get(ocr.id)?.status).toBe('running');
    expect(q.get(d3.id)?.status).toBe('running');
    releases.splice(0).forEach((r) => r());
    await Promise.all([q.waitFor(ocr.id), q.waitFor(d3.id)]);
    expect(q.activeCount).toBe(0);
  });
});

// ------------------------------------------------------------------
describe('subtitles', () => {
  it('extracts mov_text to SRT', async () => {
    const p = await probeMedia(files.subs);
    const srt = await extractSubtitles(files.subs, p.subtitles[0].index);
    expect(srt).toContain('Hello world');
    expect(srt).toContain('Second line');
    expect(srt).toMatch(/00:00:00,500 --> 00:00:02,000/);
  });

  it('rejects non-subtitle streams', async () => {
    await expect(extractSubtitles(files.subs, 0)).rejects.toThrow(/not subtitles/);
  });
});

// ------------------------------------------------------------------
describe('mediaHandlers facade', () => {
  it('returns recut-media URLs for thumbnails and runs jobs on the shared queue', async () => {
    const url = await mediaHandlers.thumbnail({ path: files.aac, time: 1, width: 80 });
    expect(url).toMatch(/^recut-media:\/\/local\//);
    const strip = await mediaHandlers.filmstrip({ path: files.aac, times: [0, 1], width: 80 });
    expect(strip).toHaveLength(2);
    const w = await mediaHandlers.waveform(files.aac);
    expect(w.rate).toBe(50);
    const job = await mediaHandlers.startSceneDetect({ mediaId: 'x', path: files.scene, threshold: 0.3, duration: 6 });
    const list = await mediaHandlers.listJobs();
    expect(list.some((j) => j.id === job.id)).toBe(true);
    const final = await jobQueue.waitFor(job.id);
    expect(final.status).toBe('done');
    await mediaHandlers.clearJobs();
    expect((await mediaHandlers.listJobs()).some((j) => j.id === job.id)).toBe(false);
    const ex = await mediaHandlers.startExport({} as never);
    expect(typeof ex.ok).toBe('boolean');
  }, 60_000);
});

describe('media timing fixes (docs/attack/media.md M-05, M-06, M-10)', () => {
  const vstream = (over: Record<string, unknown> = {}) => ({
    index: 0, codec_type: 'video' as const, codec_name: 'h264', width: 320, height: 240, r_frame_rate: '24/1', avg_frame_rate: '24/1', pix_fmt: 'yuv420p', ...over,
  });

  it('probe reports the display size and rotation of rotated video (display matrix or rotate tag)', () => {
    const dm = probeFromFfprobe({ streams: [vstream({ side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }] })], format: { format_name: 'mov,mp4', duration: '2' } }, '/x/r.mp4');
    expect(dm.video).toMatchObject({ width: 240, height: 320, rotation: 270, codedWidth: 320, codedHeight: 240 });
    const tag = probeFromFfprobe({ streams: [vstream({ tags: { rotate: '90' } })], format: { format_name: 'mov,mp4', duration: '2' } }, '/x/r.mp4');
    expect(tag.video).toMatchObject({ width: 240, height: 320, rotation: 90 });
    const flip = probeFromFfprobe({ streams: [vstream({ side_data_list: [{ rotation: 180 }] })], format: { format_name: 'mov,mp4', duration: '2' } }, '/x/r.mp4');
    expect(flip.video).toMatchObject({ width: 320, height: 240, rotation: 180 });
  });

  it('probe records the video stream start relative to the container start', () => {
    const p = probeFromFfprobe({ streams: [vstream({ start_time: '10.000000' })], format: { format_name: 'mov,mp4', duration: '20', start_time: '9.978000' } }, '/x/a.mp4');
    expect((p.video as { startTime?: number }).startTime).toBeCloseTo(0.022, 6);
    expect(p.startTime).toBeCloseTo(9.978, 6);
  });

  it('proxy carries every audio stream (any requested stream is ignored) and its cache name says so', () => {
    const base = { mediaId: 'm', path: '/x/multi.mkv', height: 240 };
    const opts = { targetHeight: 240, hasVideo: true, hasAudio: true, outPart: '/tmp/x.part' };
    for (const args of [buildProxyArgs({ ...base, audioStream: 2 }, opts), buildProxyArgs(base, opts)]) {
      expect(args.filter((a, i) => args[i - 1] === '-map')).toEqual(['0:v:0', '0:a?']);
      expect(args.slice(args.indexOf('-c:a'), args.indexOf('-c:a') + 6)).toEqual(['-c:a', 'aac', '-b:a', '160k', '-ac', '2']);
    }
    const audioOnly = buildProxyArgs(base, { ...opts, hasVideo: false });
    expect(audioOnly.filter((a, i) => audioOnly[i - 1] === '-map')).toEqual(['0:a?']);
    expect(audioOnly).toContain('-vn');
    // `_all` keeps new proxies apart from the older single-stream ones (`_240p.mp4` = first stream, `_a<N>` = stream N).
    expect(proxyOutputPath('k', 240)).toMatch(/k_240p_all\.mp4$/);
    expect(proxyOutputPath('k', 241)).toMatch(/k_240p_all\.mp4$/);
  });

  it('thumbnail seek lands a quarter frame before the covering frame', () => {
    const grid = { fps: 24, start: 0 };
    for (const k of [1, 2, 10, 47, 48, 100]) {
      const t = (k + 0.5) / 24; // frame centre
      expect(frameSeekTime(t, grid)).toBeCloseTo((k - 0.25) / 24, 9);
      expect(frameSeekTime(k / 24, grid)).toBeCloseTo((k - 0.25) / 24, 9); // frame start stays on frame k
    }
    expect(frameSeekTime(0.02, grid)).toBe(0);
    expect(frameSeekTime(6.0, { fps: 24, start: 0.0213 })).toBeCloseTo(0.0213 + (143 - 0.25) / 24, 9);
    expect(frameSeekTime(3.3, null)).toBe(3.3);
  });
});
