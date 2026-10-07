/**
 * Proxy transcodes: small, GOP-12 H.264 + AAC copies used for smooth scrubbing. Every audio stream of the source is
 * carried, in source order (one AAC track each), so the preview can play any clip's stream from one proxy.
 * Output `proxies/<key>_<height>p_all.mp4` (audio-only sources produce an audio-only mp4 at the same path).
 * When that run fails (an audio stream FFmpeg cannot decode or encode), the proxy falls back to the streams FFmpeg can
 * decode, then to the wanted stream alone (`<key>_<height>p_a<N>[_a<M>...].mp4`, see runProxy); ProxyResult.audioStreams
 * records what it carries. Older proxies carried one stream: `<key>_<height>p_a<N>.mp4` (stream N) or
 * `<key>_<height>p.mp4` (the first).
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
import { cacheKeyForPath, cacheKeysForPath, cacheSubdir, fileExists, findCachedFile, removeQuietly, type MediaCacheKeys } from './cache';
import { FfmpegError, ffmpegAudioDecoders, ffmpegFileArg, runFfmpeg } from './ffmpeg';
import { probeMedia } from './probe';

export interface ProxyResult {
  path: string;
  width?: number;
  height?: number;
  /** True when a finished proxy was already in the cache. */
  cached: boolean;
  /**
   * Absolute ffprobe indexes of the source audio streams the proxy carries, in its track order: every audio stream,
   * or the fallback's subset when the all-streams run failed (runProxy). Empty for stills and silent sources.
   */
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

/**
 * Cache path of a fallback proxy carrying only `streams` (absolute indexes, in track order):
 * `<key>_<h>p_a<N>_a<M>....mp4`. One stream gives the older single-stream name `_a<N>`, whose content is the same.
 */
export function streamsProxyOutputPath(key: string, height: number, streams: readonly number[]): string {
  return path.join(cacheSubdir('proxies'), `${key}_${evenDown(height > 0 ? height : 540)}p${streams.map((s) => `_a${s}`).join('')}.mp4`);
}

/**
 * The audio streams a proxy run tries, best first (absolute indexes, in source order):
 * 1. every audio stream;
 * 2. the streams FFmpeg can decode (`decodable`: codec names from `ffmpeg -codecs`; skipped when unknown, empty, or
 *    when it is every stream);
 * 3. the wanted stream alone, resolved as the export does (renderGraph.ts audioStreamIndex: `want` when it is an audio
 *    stream of the file, else the first). When it is known to be undecodable, the first decodable stream instead.
 * Plans that repeat an earlier one are dropped. A source without audio has the one plan `[]`.
 */
export function proxyAudioPlans(probe: Pick<MediaProbe, 'audio'>, decodable: ReadonlySet<string> | null, want?: number): number[][] {
  const all = probe.audio.map((a) => a.index);
  if (all.length === 0) return [[]];
  const plans: number[][] = [all];
  const ok = decodable ? probe.audio.filter((a) => decodable.has(a.codec)).map((a) => a.index) : null;
  if (ok && ok.length > 0) plans.push(ok);
  let one = typeof want === 'number' && all.includes(want) ? want : all[0];
  if (ok && ok.length > 0 && !ok.includes(one)) one = ok[0];
  plans.push([one]);
  return plans.filter((p, i) => plans.findIndex((q) => q.length === p.length && q.every((x, k) => x === p[k])) === i);
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
  const keys = await cacheKeysForPath(req.path);
  const out = stillProxyOutputPath(keys.key);
  let cachedInfo: { width?: number; height?: number } | null = null;
  // The content-key PNG, else one an older version cached under the legacy key (adopted under the content key).
  const hit = await findCachedFile(keys, stillProxyOutputPath, async (f) => {
    if (!(await fileExists(f))) return false;
    cachedInfo = await validStill(f);
    if (!cachedInfo && f === out) await removeQuietly(out); // corrupt leftover
    return !!cachedInfo;
  });
  if (hit && cachedInfo) {
    ctx.setProgress(1, 'Cached');
    return { path: hit, ...(cachedInfo as { width?: number; height?: number }), cached: true, audioStreams: [] };
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
export function buildProxyArgs(req: ProxyRequest, opts: {
  targetHeight: number; hasVideo: boolean; hasAudio: boolean; outPart: string;
  /** Only these audio streams (absolute indexes, in this order); default every audio stream (`-map 0:a?`). */
  audioStreams?: readonly number[];
}): string[] {
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
    // A fallback run (runProxy) maps only the streams it carries.
    if (opts.audioStreams) for (const i of opts.audioStreams) args.push('-map', `0:${i}`);
    else args.push('-map', '0:a?');
    args.push('-c:a', 'aac', '-b:a', '160k', '-ac', String(ch));
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

/** The finished proxy at `file` (width / height), or null when it is missing or not a usable media file. */
async function validProxy(file: string): Promise<{ width?: number; height?: number } | null> {
  if (!(await fileExists(file))) return null;
  const info = await probeMedia(file).catch(() => undefined);
  if (info && info.duration > 0) return { width: info.video?.width, height: info.video?.height };
  await removeQuietly(file); // corrupt leftover
  return null;
}

/**
 * A finished proxy for `pathFor(key)`: under the content key, else under the legacy (pre-0.10) key, adopted under the
 * content key (cache.ts findCachedFile). Null when neither is a usable proxy.
 */
async function findProxy(keys: Pick<MediaCacheKeys, 'key' | 'legacyKey'>, pathFor: (key: string) => string): Promise<({ path: string; width?: number; height?: number }) | null> {
  let info: { width?: number; height?: number } | null = null;
  const hit = await findCachedFile(keys, pathFor, async (f) => { info = await validProxy(f); return !!info; });
  return hit && info ? { path: hit, ...(info as { width?: number; height?: number }) } : null;
}

function streamList(streams: readonly number[]): string {
  return streams.map((s) => `#${s}`).join(', ');
}

/**
 * The actual transcode. Exposed so other job kinds can reuse it; prefer `startProxyJob`.
 *
 * Tries the plans of proxyAudioPlans in turn: every audio stream (`_all`), then the streams FFmpeg can decode, then the
 * wanted stream (`req.audioStream`) alone, so one stream FFmpeg cannot decode or encode does not cost the whole proxy.
 * Only the all-streams proxy is looked up in the cache up front; a fallback proxy (or an older single-stream proxy of
 * the same streams) is reused once the runs before it have failed. The result records the streams it carries.
 */
export async function runProxy(req: ProxyRequest, ctx: JobRunContext): Promise<ProxyResult> {
  const probe = await probeMedia(req.path);
  if (isStillProbe(probe)) return runStillProxy(req, probe, ctx);
  const hasVideo = !!probe.video && probe.duration > 0;
  const hasAudio = probe.audio.length > 0;
  if (!hasVideo && !hasAudio) throw new Error('source has neither video nor audio');

  const keys = await cacheKeysForPath(req.path);
  const key = keys.key;
  const reqHeight = evenDown(req.height > 0 ? req.height : 540);
  const srcHeight = probe.video?.height ?? 0;
  const targetHeight = Math.max(2, hasVideo && srcHeight > 0 ? Math.min(reqHeight, evenDown(srcHeight)) : reqHeight);
  const outAll = proxyOutputPath(key, reqHeight);
  const all = probe.audio.map((a) => a.index);

  const cachedAll = await findProxy(keys, (k) => proxyOutputPath(k, reqHeight));
  if (cachedAll) {
    ctx.setProgress(1, 'Cached');
    return { ...cachedAll, cached: true, audioStreams: all };
  }

  // The fallback plans need the decoder list only after the all-streams run failed.
  let plans: number[][] = [all];
  let firstError: unknown = null;
  for (let k = 0; k < plans.length; k++) {
    const streams = plans[k];
    const fallback = k > 0;
    const out = fallback ? streamsProxyOutputPath(key, reqHeight, streams) : outAll;
    if (fallback) {
      const cached = await findProxy(keys, (k) => streamsProxyOutputPath(k, reqHeight, streams));
      if (cached) {
        ctx.setProgress(1, 'Cached');
        return { ...cached, cached: true, audioStreams: streams };
      }
    }
    try {
      await encodeProxy(req, ctx, out, {
        targetHeight, hasVideo, hasAudio, duration: probe.duration, audioStreams: fallback ? streams : undefined,
        label: fallback ? ` (audio ${streamList(streams)})` : '',
      });
    } catch (e) {
      if ((e instanceof FfmpegError && e.canceled) || ctx.signal.aborted) throw e;
      firstError ??= e;
      if (!fallback && hasAudio) plans = proxyAudioPlans(probe, await ffmpegAudioDecoders(), req.audioStream);
      const next = plans[k + 1];
      if (!next) throw firstError;
      console.warn(`[proxy] ${path.basename(req.path)}: proxy with audio ${streamList(streams)} failed (${e instanceof Error ? e.message.split('\n')[0] : String(e)}); retrying with ${streamList(next)}`);
      continue;
    }
    const info = await probeMedia(out).catch(() => undefined);
    ctx.setProgress(1, fallback ? `Done (audio ${streamList(streams)} of ${all.length})` : 'Done');
    return { path: out, width: info?.video?.width, height: info?.video?.height, cached: false, audioStreams: streams };
  }
  throw firstError ?? new Error('proxy failed');
}

/** One proxy encode to `out` through a per-job `.part` file, renamed on success. */
async function encodeProxy(req: ProxyRequest, ctx: JobRunContext, out: string, o: {
  targetHeight: number; hasVideo: boolean; hasAudio: boolean; duration: number; audioStreams?: readonly number[]; label: string;
}): Promise<void> {
  // Per-job temp name: even if two jobs ever target the same proxy they never share a `.part`.
  const outPart = `${out}.part-${ctx.jobId}`;
  await removeStaleParts(out);
  const args = buildProxyArgs(req, { targetHeight: o.targetHeight, hasVideo: o.hasVideo, hasAudio: o.hasAudio, outPart, audioStreams: o.audioStreams });
  ctx.setProgress(0, `${o.hasVideo ? `Encoding ${o.targetHeight}p proxy` : 'Encoding audio proxy'}${o.label}`);
  const run = runFfmpeg(args, {
    duration: o.duration,
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
    throw e;
  }
  if (ctx.signal.aborted) {
    await removeQuietly(outPart);
    throw new FfmpegError('proxy canceled', { canceled: true });
  }
  await fsp.rename(outPart, out);
}

/**
 * Queue a proxy job. Returns the queued JobInfo and the deterministic output path of the proxy it builds (only valid
 * once the job is 'done'): the PNG for a still, else the all-streams mp4. A fallback proxy (runProxy) has another
 * path, so read the job result's `path`. `onDone` fires when the job settles (done / failed / canceled).
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
