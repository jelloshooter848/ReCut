/**
 * Proxy transcodes: small, GOP-12 H.264 + AAC copies used for smooth scrubbing. Every audio stream of the source is
 * carried, in source order (one AAC track each), so the preview can play any clip's stream from one proxy.
 * Output `proxies/<key>_<height>p_all.mp4` (audio-only sources produce an audio-only mp4 at the same path).
 * Older proxies carried one stream: `<key>_<height>p_a<N>.mp4` (stream N) or `<key>_<height>p.mp4` (the first).
 * Still images get a PNG instead (`proxies/<key>_still.png`, see runStillProxy): the preview draws it when Chromium
 * cannot decode the original (TIFF, TGA, EXR, PSD, JPEG XL, HEIC, ...).
 * Written to a `.part` file and renamed on success so interrupted proxies never look complete.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { JobInfo, MediaProbe } from '@shared/model';
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
  /** Absolute ffprobe indexes of the source audio streams the proxy carries, in its track order (all of them). */
  audioStreams: number[];
}

function evenDown(n: number): number {
  n = Math.floor(n);
  return n % 2 ? n - 1 : n;
}

/**
 * Cache path of a proxy. `_all`: it carries every audio stream. The suffix keeps it apart from the older
 * single-stream proxies (`_<h>p.mp4` = first stream, `_<h>p_a<N>.mp4` = stream N), which stay valid for their stream.
 */
export function proxyOutputPath(key: string, height: number): string {
  return path.join(cacheSubdir('proxies'), `${key}_${evenDown(height > 0 ? height : 540)}p_all.mp4`);
}

// ------------------------------------------------------------------ still images

/** Longest side of a still-image proxy (pixels); smaller stills keep their size. */
export const STILL_PROXY_MAX_SIDE = 3840;

/** Cache path of a still image's PNG proxy (one per source file version; the height setting does not apply). */
export function stillProxyOutputPath(key: string): string {
  return path.join(cacheSubdir('proxies'), `${key}_still.png`);
}

/** A probed picture without duration (an image demuxer, or a single AVIF / HEIC / GIF frame): proxied as a PNG. */
export function isStillProbe(probe: MediaProbe): boolean {
  return !!probe.video && (probe.playabilityReason === 'still image' || (!(probe.duration > 0) && probe.audio.length === 0));
}

/** Pixel formats that carry alpha (palette formats may: a GIF / PNG palette can hold transparent entries). */
export function pixFmtHasAlpha(pixFmt: string | undefined): boolean {
  return /^(rgba|bgra|argb|abgr|ya\d|yuva|gbrap|ayuv|pal8)/.test(pixFmt ?? '');
}

/**
 * ffmpeg arguments for a still's PNG proxy: the first picture, un-squeezed to its display shape (a non-square SAR
 * widens or heightens, as the export's fit and the thumbnails do), the long side capped at STILL_PROXY_MAX_SIDE
 * (never enlarged), RGBA when the source has alpha, else RGB. FFmpeg applies the EXIF / display-matrix orientation
 * while decoding (autorotate), as the export does, so the PNG is upright.
 */
export function buildStillProxyArgs(src: string, opts: { alpha: boolean; outPart: string; maxSide?: number }): string[] {
  const max = opts.maxSide && opts.maxSide > 0 ? Math.floor(opts.maxSide) : STILL_PROXY_MAX_SIDE;
  const vf = [
    "scale=w='if(gt(sar,1.000001),max(1,round(iw*sar)),iw)':h='if(lt(sar,0.999999),max(1,round(ih/sar)),ih)':flags=bicubic",
    'setsar=1',
    `scale=w='min(iw,${max})':h='min(ih,${max})':force_original_aspect_ratio=decrease:flags=bicubic`,
    'setsar=1',
  ].join(',');
  return [
    '-i', ffmpegFileArg(src),
    '-map', '0:v:0', '-an', '-sn', '-dn',
    '-frames:v', '1',
    '-vf', vf,
    '-c:v', 'png', '-pix_fmt', opts.alpha ? 'rgba' : 'rgb24',
    '-map_metadata', '-1',
    '-f', 'image2', '-update', '1',
    ffmpegFileArg(opts.outPart),
  ];
}

/** True when `file` is a decodable picture (a usable cached still proxy). */
async function validStill(file: string): Promise<{ width?: number; height?: number } | null> {
  const info = await probeMedia(file).catch(() => undefined);
  return info?.video && info.video.width > 0 && info.video.height > 0 ? { width: info.video.width, height: info.video.height } : null;
}

/** The still-image branch of runProxy: one PNG per source file version, same `.part` + rename discipline. */
async function runStillProxy(req: ProxyRequest, probe: MediaProbe, ctx: JobRunContext): Promise<ProxyResult> {
  const key = await cacheKeyForPath(req.path);
  const out = stillProxyOutputPath(key);
  if (await fileExists(out)) {
    const info = await validStill(out);
    if (info) {
      ctx.setProgress(1, 'Cached');
      return { path: out, ...info, cached: true, audioStreams: [] };
    }
    await removeQuietly(out); // corrupt leftover
  }
  const outPart = `${out}.part-${ctx.jobId}`;
  await removeStaleParts(out);
  const args = buildStillProxyArgs(req.path, { alpha: pixFmtHasAlpha(probe.video?.pixFmt), outPart });
  ctx.setProgress(0, 'Decoding still image');
  const run = runFfmpeg(args, { stdout: 'ignore', signal: ctx.signal });
  ctx.onCancel(() => run.cancel());
  try {
    await run.promise;
  } catch (e) {
    await removeQuietly(outPart);
    throw e;
  }
  if (ctx.signal.aborted) {
    await removeQuietly(outPart);
    throw new FfmpegError('proxy canceled', { canceled: true });
  }
  const info = await validStill(outPart);
  if (!info) {
    await removeQuietly(outPart);
    throw new Error('ffmpeg produced no picture for this image');
  }
  await fsp.rename(outPart, out);
  ctx.setProgress(1, 'Done');
  return { path: out, ...info, cached: false, audioStreams: [] };
}

/** Output path a proxy request writes: the PNG for a still, else the mp4 (probe failures fall through to the mp4). */
async function stillProxyTarget(req: ProxyRequest, key: string): Promise<string | null> {
  const probe = await probeMedia(req.path).catch(() => undefined);
  return probe && isStillProbe(probe) ? stillProxyOutputPath(key) : null;
}

// ------------------------------------------------------------------ video / audio

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
    // Every audio stream in source order (track k of the proxy = the k-th audio stream of the probe), so the preview
    // plays each clip's selected stream, as the export does (M-05). `-c:a`, `-b:a` and `-ac` apply to each of them.
    args.push('-map', '0:a?', '-c:a', 'aac', '-b:a', '160k', '-ac', String(ch));
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
export async function runProxy(req: ProxyRequest, ctx: JobRunContext): Promise<ProxyResult> {
  const probe = await probeMedia(req.path);
  if (isStillProbe(probe)) return runStillProxy(req, probe, ctx);
  const audioStreams = probe.audio.map((a) => a.index);
  const hasVideo = !!probe.video && probe.duration > 0;
  const hasAudio = probe.audio.length > 0;
  if (!hasVideo && !hasAudio) throw new Error('source has neither video nor audio');

  const key = await cacheKeyForPath(req.path);
  const reqHeight = evenDown(req.height > 0 ? req.height : 540);
  const srcHeight = probe.video?.height ?? 0;
  const targetHeight = Math.max(2, hasVideo && srcHeight > 0 ? Math.min(reqHeight, evenDown(srcHeight)) : reqHeight);
  const out = proxyOutputPath(key, reqHeight);

  if (await fileExists(out)) {
    const info = await probeMedia(out).catch(() => undefined);
    if (info && info.duration > 0) {
      ctx.setProgress(1, 'Cached');
      return { path: out, width: info.video?.width, height: info.video?.height, cached: true, audioStreams };
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
  return { path: out, width: info?.video?.width, height: info?.video?.height, cached: false, audioStreams };
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
  const outputPath = (await stillProxyTarget(req, key)) ?? proxyOutputPath(key, evenDown(req.height > 0 ? req.height : 540));
  // De-dupe: a proxy for this output is already queued/running -> hand back that job.
  const existing = inFlightJob(queue, inFlightProxies, outputPath);
  if (existing) return { job: existing, outputPath };
  const title = outputPath.endsWith('_still.png') ? `Preview image · ${path.basename(req.path)}` : `Proxy ${req.height}p · ${path.basename(req.path)}`;
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
