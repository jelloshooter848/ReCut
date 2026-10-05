/**
 * Proxy transcodes: small, GOP-12 H.264 + stereo AAC copies used for smooth scrubbing.
 * Output `proxies/<key>_<height>p.mp4` (audio-only sources produce an audio-only mp4 at the same path).
 * Written to a `.part` file and renamed on success so interrupted proxies never look complete.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { JobInfo } from '@shared/model';
import type { ProxyRequest } from '@shared/ipc';
import type { JobQueue, JobRunContext } from '../jobs/jobQueue';
import { inFlightJob, trackInFlight, type InFlight } from '../jobs/inFlight';
import { cacheKeyForPath, cacheSubdir, fileExists, removeQuietly } from './cache';
import { FfmpegError, ffmpegFileArg, runFfmpeg } from './ffmpeg';
import { probeMedia } from './probe';

export interface ProxyResult {
  path: string;
  width?: number;
  height?: number;
  /** True when a finished proxy was already in the cache. */
  cached: boolean;
  /** Absolute audio stream index baked into the proxy (undefined: the source's first audio stream). */
  audioStream?: number;
}

function evenDown(n: number): number {
  n = Math.floor(n);
  return n % 2 ? n - 1 : n;
}

function validStream(n: number | undefined): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0;
}

/** Cache path of a proxy; the selected audio stream is part of the key (a proxy carries one audio stream). */
export function proxyOutputPath(key: string, height: number, audioStream?: number): string {
  const a = validStream(audioStream) ? `_a${audioStream}` : '';
  return path.join(cacheSubdir('proxies'), `${key}_${evenDown(height > 0 ? height : 540)}p${a}.mp4`);
}

/** Build the ffmpeg argument list for a proxy transcode (exported for inspection/tests). */
export function buildProxyArgs(req: ProxyRequest, opts: { targetHeight: number; hasVideo: boolean; hasAudio: boolean; outPart: string }): string[] {
  const args: string[] = ['-i', ffmpegFileArg(req.path)];
  if (opts.hasVideo) {
    args.push(
      '-map', '0:v:0',
      '-vf', `scale=-2:${opts.targetHeight}`,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '23',
      '-g', '12',
      '-keyint_min', '12',
      '-sc_threshold', '0',
      '-pix_fmt', 'yuv420p',
    );
  } else {
    args.push('-vn');
  }
  if (opts.hasAudio) {
    const ch = req.audioChannels && req.audioChannels > 0 ? Math.min(req.audioChannels, 2) : 2;
    // The media's selected stream (absolute index) so the preview plays what the export renders (M-05).
    args.push('-map', validStream(req.audioStream) ? `0:${req.audioStream}` : '0:a:0?', '-c:a', 'aac', '-b:a', '160k', '-ac', String(ch));
  } else {
    args.push('-an');
  }
  args.push('-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1', '-movflags', '+faststart', '-f', 'mp4', ffmpegFileArg(opts.outPart));
  return args;
}

/**
 * Remove leftovers of earlier interrupted runs for `out` (`<out>.part`, `<out>.part-<jobId>`). Safe:
 * startProxyJob de-dupes in-flight jobs by output path, so no live job is writing one of these.
 */
async function removeStaleParts(out: string): Promise<void> {
  const dir = path.dirname(out);
  const prefix = `${path.basename(out)}.part`;
  let names: string[] = [];
  try { names = await fsp.readdir(dir); } catch { return; }
  await Promise.all(names.filter((n) => n === prefix || n.startsWith(`${prefix}-`)).map((n) => removeQuietly(path.join(dir, n))));
}

/** The actual transcode. Exposed so other job kinds can reuse it; prefer `startProxyJob`. */
export async function runProxy(req0: ProxyRequest, ctx: JobRunContext): Promise<ProxyResult> {
  const probe = await probeMedia(req0.path);
  // A stream index that is not an audio stream of this file falls back to the first audio stream.
  const req: ProxyRequest = validStream(req0.audioStream) && !probe.audio.some((a) => a.index === req0.audioStream)
    ? { ...req0, audioStream: undefined } : req0;
  const hasVideo = !!probe.video && probe.duration > 0;
  const hasAudio = probe.audio.length > 0;
  if (!hasVideo && !hasAudio) throw new Error('source has neither video nor audio');

  const key = await cacheKeyForPath(req.path);
  const reqHeight = evenDown(req.height > 0 ? req.height : 540);
  const srcHeight = probe.video?.height ?? 0;
  const targetHeight = Math.max(2, hasVideo && srcHeight > 0 ? Math.min(reqHeight, evenDown(srcHeight)) : reqHeight);
  const out = proxyOutputPath(key, reqHeight, req0.audioStream);

  if (await fileExists(out)) {
    const info = await probeMedia(out).catch(() => undefined);
    if (info && info.duration > 0) {
      ctx.setProgress(1, 'Cached');
      return { path: out, width: info.video?.width, height: info.video?.height, cached: true, audioStream: validStream(req.audioStream) ? req.audioStream : undefined };
    }
    await removeQuietly(out); // corrupt leftover
  }

  // Per-job temp name: even if two jobs ever target the same proxy they never share a `.part`.
  const outPart = `${out}.part-${ctx.jobId}`;
  await removeStaleParts(out);
  const args = buildProxyArgs(req, { targetHeight, hasVideo, hasAudio, outPart });

  ctx.setProgress(0, hasVideo ? `Encoding ${targetHeight}p proxy` : 'Encoding audio proxy');
  const run = runFfmpeg(args, {
    duration: probe.duration,
    signal: ctx.signal,
    onProgress: (p, info) => {
      const speed = info.speed ? ` (${info.speed.toFixed(1)}x)` : '';
      ctx.setProgress(p, `${Math.round(p * 100)}%${speed}`);
    },
  });
  ctx.onCancel(() => run.cancel());
  try {
    await run.promise;
  } catch (e) {
    await removeQuietly(outPart);
    if (e instanceof FfmpegError && e.canceled) throw e;
    throw e;
  }
  if (ctx.signal.aborted) {
    await removeQuietly(outPart);
    throw new FfmpegError('proxy canceled', { canceled: true });
  }
  await fsp.rename(outPart, out);
  const info = await probeMedia(out).catch(() => undefined);
  ctx.setProgress(1, 'Done');
  return { path: out, width: info?.video?.width, height: info?.video?.height, cached: false, audioStream: validStream(req.audioStream) ? req.audioStream : undefined };
}

/**
 * Queue a proxy job. Returns the queued JobInfo and the deterministic final output path (only
 * valid once the job is 'done'). `onDone` fires when the job settles (done / failed / canceled).
 */
export async function startProxyJob(
  queue: JobQueue,
  req: ProxyRequest,
  onDone?: (job: JobInfo, result: ProxyResult | null, error: string | null) => void,
): Promise<{ job: JobInfo; outputPath: string }> {
  const key = await cacheKeyForPath(req.path);
  const outputPath = proxyOutputPath(key, evenDown(req.height > 0 ? req.height : 540), req.audioStream);
  // De-dupe: a proxy for this output is already queued/running -> hand back that job.
  const existing = inFlightJob(queue, inFlightProxies, outputPath);
  if (existing) return { job: existing, outputPath };
  const title = `Proxy ${req.height}p · ${path.basename(req.path)}`;
  const job = queue.add<ProxyResult>({
    kind: 'proxy',
    title,
    mediaId: req.mediaId,
    run: (ctx) => runProxy(req, ctx),
  });
  trackInFlight(queue, inFlightProxies, outputPath, job.id);
  if (onDone) {
    queue.waitFor(job.id).then((final) => {
      const result = final.status === 'done' ? (final.result as ProxyResult) : null;
      onDone(final, result, final.status === 'failed' ? final.error ?? 'failed' : final.status === 'canceled' ? 'canceled' : null);
    }).catch(() => { /* unreachable: waitFor only rejects for unknown ids */ });
  }
  return { job, outputPath };
}

const inFlightProxies: InFlight = new WeakMap();
