/**
 * Main-process media layer benchmarks, driven directly (no Electron) against the real ffmpeg:
 * thumbnail cache miss vs hit, filmstrip batch of 48 frames, waveform generation for a 2 h file (time +
 * peak RSS of the decoding child), job-queue fairness (export lane vs media lane; two long scene detects
 * starving proxies), and whether an export running on all cores slows thumbnails / proxy progress.
 *
 * Run: npx vitest run -c tests/perf/vitest.config.ts tests/perf/main.perf.test.ts
 * Needs RECUT_PERF_LONG_FILE (a long mp4; generated with testsrc if missing, 20 min by default).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExportSettings, MediaItem, MediaProbe, Sequence } from '../../shared/model';
import { createSequence } from '../../shared/project';
import { makeClip } from '../../shared/timeline';
import { getThumbnail, getFilmstrip } from '../../electron/media/thumbs';
import { computeWaveform, getWaveform } from '../../electron/media/waveform';
import { cacheKeyForPath } from '../../electron/media/cache';
import { JobQueue } from '../../electron/jobs/jobQueue';
import { startProxyJob } from '../../electron/media/proxy';
import { startSceneDetectJob } from '../../electron/media/sceneDetect';
import { startExportJob } from '../../electron/export/exporter';
import { benchAsync, flush, GUARDRAIL, ms, now, record, round, rssMB, stats } from './_report';

const SCRATCH = process.env.RECUT_PERF_SCRATCH || path.join(os.tmpdir(), 'recut-perf');
const FFMPEG = process.env.RECUT_FFMPEG || 'ffmpeg';
const LONG = process.env.RECUT_PERF_LONG_FILE || path.join(SCRATCH, 'long20m.mp4');
const SRC = path.join(SCRATCH, 'src60.mp4');

function probeFile(file: string): MediaProbe {
  const j = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]).toString());
  const v = j.streams.find((s: { codec_type: string }) => s.codec_type === 'video');
  const rat = (r: string) => { const [n, d] = r.split('/').map(Number); return { num: n, den: d || 1 }; };
  return {
    container: j.format.format_name, duration: Number(j.format.duration), size: Number(j.format.size), startTime: Number(j.format.start_time ?? 0), browserPlayable: true,
    video: v ? { index: v.index, codec: v.codec_name, width: v.width, height: v.height, fps: rat(v.r_frame_rate), avgFps: rat(v.avg_frame_rate), isVfr: false } : undefined,
    audio: j.streams.filter((s: { codec_type: string }) => s.codec_type === 'audio').map((s: { index: number; codec_name: string; channels: number; channel_layout?: string; sample_rate: string }) => ({ index: s.index, codec: s.codec_name, channels: s.channels, layout: s.channel_layout ?? '', sampleRate: Number(s.sample_rate) })),
    subtitles: [],
  };
}

/** Peak RSS (MB) of all ffmpeg children sampled every 200 ms while `fn` runs. */
async function withPeakFfmpegRss<T>(fn: () => Promise<T>): Promise<{ result: T; peakMB: number; ms: number }> {
  let peak = 0;
  const poll = setInterval(() => {
    try {
      const out = execFileSync('bash', ['-c', "for p in $(pgrep -x ffmpeg); do awk '/VmRSS/{print $2}' /proc/$p/status 2>/dev/null; done"]).toString().trim();
      for (const l of out.split('\n')) { const kb = Number(l); if (kb > 0) peak = Math.max(peak, kb / 1024); }
    } catch { /* ignore */ }
  }, 200);
  const t = now();
  try { const result = await fn(); return { result, peakMB: round(peak), ms: round(now() - t) }; }
  finally { clearInterval(poll); }
}

const sleep = (msec: number) => new Promise((r) => setTimeout(r, msec));

describe('main-process media layer', () => {
  beforeAll(() => {
    fs.mkdirSync(SCRATCH, { recursive: true });
    process.env.RECUT_CACHE_DIR = path.join(SCRATCH, 'cache-main');
    fs.rmSync(process.env.RECUT_CACHE_DIR, { recursive: true, force: true });
    if (!fs.existsSync(SRC)) execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=24:d=60', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=60:sample_rate=48000', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-shortest', SRC]);
    if (!fs.existsSync(LONG)) {
      const t = now();
      execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=24', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '1200', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k', '-shortest', LONG]);
      ms('setup', 'generate 20 min long file', now() - t);
    }
    record({ section: 'setup', metric: 'long file', value: `${path.basename(LONG)} ${round(fs.statSync(LONG).size / 1048576)} MB, ${round(probeFile(LONG).duration / 60)} min`, unit: '' });
  });
  afterAll(() => flush('main'));

  it('thumbnail: miss vs hit latency; filmstrip of 48 frames', async () => {
    const miss = await benchAsync(8, async (i) => { await getThumbnail({ path: SRC, time: 1 + i * 3.1, width: 96 }); });
    ms('thumbs', 'thumbnail cache MISS (median of 8, 720p source)', miss.median, 300, undefined, GUARDRAIL);
    ms('thumbs', 'thumbnail cache MISS (max)', miss.max, 600, undefined, GUARDRAIL);
    const hit = await benchAsync(50, async (i) => { await getThumbnail({ path: SRC, time: 1 + (i % 8) * 3.1, width: 96 }); });
    ms('thumbs', 'thumbnail cache HIT (median of 50; stat+key hash+exists)', hit.median, 5, undefined, GUARDRAIL);
    ms('thumbs', 'thumbnail cache HIT (p95)', hit.p95, 10, undefined, GUARDRAIL);
    const times48 = Array.from({ length: 48 }, (_, i) => 5 + i * 1.1);
    const t = now(); const urls = await getFilmstrip({ path: SRC, times: times48, width: 128 }); const dt = now() - t;
    ms('thumbs', 'filmstrip 48 frames cold (4 ffmpeg batches of 12, 3 concurrent)', dt, 3000, undefined, GUARDRAIL);
    record({ section: 'thumbs', metric: 'filmstrip 48 frames produced', value: urls.filter(Boolean).length, unit: '/48', pass: urls.filter(Boolean).length === 48 }, GUARDRAIL);
    const t2 = now(); await getFilmstrip({ path: SRC, times: times48, width: 128 }); const dt2 = now() - t2;
    ms('thumbs', 'filmstrip 48 frames warm (all cached)', dt2, 50, undefined, GUARDRAIL);
    // Cold miss on the long file: ffmpeg -ss seeks within a 2 h stream.
    const longMiss = await benchAsync(5, async (i) => { await getThumbnail({ path: LONG, time: 3600 + i * 97, width: 96 }); });
    ms('thumbs', 'thumbnail MISS deep inside long file (median)', longMiss.median, 500, undefined, GUARDRAIL);
    expect(urls.filter(Boolean).length).toBeGreaterThan(40);
  });

  it('waveform: generation time and peak RSS for the long file', async () => {
    const key = await cacheKeyForPath(LONG);
    const r0 = rssMB();
    const w = await withPeakFfmpegRss(() => getWaveform(LONG, key));
    ms('waveform', `waveform generate ${round(w.result.duration / 60)} min file (cold)`, w.ms, 60_000, undefined, GUARDRAIL);
    record({ section: 'waveform', metric: 'peak RSS of ffmpeg decoder child (MB)', value: w.peakMB, unit: 'MB' });
    record({ section: 'waveform', metric: 'node RSS growth during waveform (MB)', value: round(rssMB() - r0), unit: 'MB' });
    record({ section: 'waveform', metric: 'peaks array bytes', value: w.result.peaks.length, unit: 'bytes', note: `${w.result.rate} buckets/s` });
    const t = now(); await getWaveform(LONG, key); ms('waveform', 'waveform cached read', now() - t, 50, undefined, GUARDRAIL);
    const cw = await withPeakFfmpegRss(() => computeWaveform(SRC));
    ms('waveform', 'waveform compute 60 s 720p source', cw.ms, 3000, undefined, GUARDRAIL);
    expect(w.result.peaks.length).toBeGreaterThan(1000);
  });

  it('job queue fairness: export lane vs media lane, long scene detects starving proxies', async () => {
    const queue = new JobQueue();
    const srcProbe = probeFile(SRC);
    const media: Record<string, MediaItem> = { m1: { id: 'm1', name: 'src60.mp4', path: SRC, kind: 'video', category: 'Other', identity: {}, binId: null, probe: srcProbe, offline: false, proxy: { status: 'none' }, detectedScenes: [], subtitleTrackIds: [], notes: '', tags: [], addedAt: 0 } };
    const seq: Sequence = createSequence('perf export', { num: 24, den: 1 });
    for (let i = 0; i < 6; i++) {
      seq.videoTracks[0].clips.push(makeClip({ mediaId: 'm1', name: `c${i}`, sourceIn: i * 9, duration: 240, kind: 'video' }, i * 240));
      seq.audioTracks[0].clips.push(makeClip({ mediaId: 'm1', name: `c${i}`, sourceIn: i * 9, duration: 240, kind: 'audio', audioStream: srcProbe.audio[0]?.index }, i * 240));
    }
    const settings: ExportSettings = { outputDir: path.join(SCRATCH, 'export-out'), fileName: 'fair.mp4', width: 1920, height: 1080, fps: { num: 24, den: 1 }, videoCodec: 'libx264', qualityMode: 'crf', crf: 20, videoBitrateKbps: 8000, preset: 'medium', audioCodec: 'aac', audioBitrateKbps: 192, audioChannels: 2, sampleRate: 48000, rangeMode: 'entire', burnSubtitles: false, exportSubtitleSidecar: false, useProxies: false };

    // Baseline: thumbnail misses and a proxy with an idle machine.
    const idleThumb = await benchAsync(6, async (i) => { await getThumbnail({ path: SRC, time: 20 + i * 2.7, width: 96 }); });
    ms('fairness', 'thumbnail MISS, idle (median)', idleThumb.median, 300, undefined, GUARDRAIL);
    const proxyTime = async (tag: string) => {
      const t = now(); const { job } = await startProxyJob(queue, { mediaId: 'm1', path: SRC, height: 540 });
      const final = await queue.waitFor(job.id);
      fs.rmSync(path.join(process.env.RECUT_CACHE_DIR!, 'proxies'), { recursive: true, force: true });
      return { ms: round(now() - t), status: final.status, tag };
    };
    const p0 = await proxyTime('idle');
    ms('fairness', 'proxy 540p of 60 s 720p, idle', p0.ms, 60_000, p0.status, GUARDRAIL);

    // Export running (x264 medium 1080p uses every core) -> proxies still start (separate lane) but how fast?
    const exp = await startExportJob(queue, { sequence: seq, media, settings, overwrite: true }); // scratch persists between runs
    expect(exp.ok).toBe(true);
    await sleep(1500);
    const busyThumb = await benchAsync(6, async (i) => { await getThumbnail({ path: SRC, time: 30 + i * 2.7, width: 96 }); });
    ms('fairness', 'thumbnail MISS while export encodes (median)', busyThumb.median, 600, `x${round(busyThumb.median / Math.max(1, idleThumb.median), 1)} slower`, GUARDRAIL);
    const p1 = await proxyTime('during export');
    ms('fairness', 'proxy 540p while export encodes', p1.ms, 120_000, `${p1.status}; x${round(p1.ms / Math.max(1, p0.ms), 1)} slower`, GUARDRAIL);
    record({ section: 'fairness', metric: 'export still running after proxy finished', value: String(queue.list().some((j) => j.kind === 'export' && j.status === 'running')), unit: '' });
    if (exp.ok) queue.cancel(exp.jobId);
    await sleep(500);

    // Two long scene detections fill the media lane (concurrency 2): a proxy queued behind them waits.
    const sd1 = startSceneDetectJob(queue, { mediaId: 'L', path: LONG, threshold: 0.35, duration: 0 });
    const sd2 = startSceneDetectJob(queue, { mediaId: 'L2', path: LONG, threshold: 0.36, duration: 0 });
    await sleep(1000);
    const tq = now();
    const { job: pj } = await startProxyJob(queue, { mediaId: 'm1', path: SRC, height: 540 });
    await sleep(8000);
    const pjNow = queue.get(pj.id)!;
    record({ section: 'fairness', metric: 'proxy status 8 s after queueing behind 2 long scene detects', value: pjNow.status, unit: '', threshold: 'running', pass: pjNow.status === 'running', note: 'media lane concurrency = 2; scene detect of a 2 h file holds a slot for minutes' }, GUARDRAIL);
    const sdThumb = await benchAsync(6, async (i) => { await getThumbnail({ path: SRC, time: 40 + i * 2.7, width: 96 }); });
    ms('fairness', 'thumbnail MISS while 2 scene detects run (median)', sdThumb.median, 600, `x${round(sdThumb.median / Math.max(1, idleThumb.median), 1)} slower`, GUARDRAIL);
    const sdProgress = queue.get(sd1.id)!.progress;
    record({ section: 'fairness', metric: 'scene detect progress of 2 h file after ~10 s', value: round(sdProgress * 100, 2), unit: '%', note: `ETA ~${round((now() - tq) / 1000 / Math.max(0.0001, sdProgress) / 60, 1)} min each` });
    queue.cancel(sd1.id); queue.cancel(sd2.id);
    const final = await queue.waitFor(pj.id);
    ms('fairness', 'proxy queued behind scene detects: wait+run until done', now() - tq, 120_000, final.status, GUARDRAIL);
    queue.cancelAll();
    await sleep(300);
    // In-flight thumbnail semaphore: 20 simultaneous misses -> 3 at a time.
    const t = now();
    await Promise.all(Array.from({ length: 20 }, (_, i) => getThumbnail({ path: SRC, time: 50 + i * 0.37, width: 96 })));
    ms('fairness', '20 concurrent thumbnail misses (MAX_CONCURRENT=3)', now() - t, 3000, undefined, GUARDRAIL);
    const s = stats([idleThumb.median, busyThumb.median, sdThumb.median]);
    record({ section: 'fairness', metric: 'thumbnail miss median idle / export / scenedetect', value: `${idleThumb.median} / ${busyThumb.median} / ${sdThumb.median}`, unit: 'ms', note: `max ${s.max}` });
  });
});
