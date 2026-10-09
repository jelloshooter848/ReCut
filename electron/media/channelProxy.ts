/**
 * Channel proxies (Roadmap §9): preview audio for a clip's channel selection (ClipAudio.channelSelection).
 *
 * Media proxies are stereo, so a single source channel (the centre of a 5.1 mix) or a controlled downmix cannot be
 * derived from them, and Chromium cannot decode most surround codecs (AC-3, E-AC-3, DTS, TrueHD) at all. So each
 * (file, audio stream, selection) gets its own small audio-only file, made from the ORIGINAL with exactly the `pan`
 * filter the export uses for a stereo mix (shared/audioChannels.ts channelPanFilter): what the preview plays is what a
 * stereo export renders. Stereo AAC in an audio-only mp4: `proxies/<key>_ch<stream>.<selection>_v<N>.m4a`.
 *
 * The file is 0-based on the container start like the media proxies: a stream that starts late is padded with silence
 * (`aresample=async=1:first_pts=0` on container-relative timestamps), so source time t plays at element time t. The
 * input is read with `-copyts` and the probed container start is subtracted in the filter: FFmpeg's own zero for
 * MPEG-TS / MPEG-PS is the start of the mapped streams (this one stream), which dropped a late stream's lead.
 * Written to a per-job `.part` file and renamed on success; one job per output at a time (in-flight de-duplication).
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AudioChannelSelection, JobInfo } from '@shared/model';
import type { ChannelProxyRequest } from '@shared/ipc';
import { audioStreamInfo, channelPanFilter, channelProxyKey, channelSelectionLabel, channelSelectionProblem, CHANNEL_PROXY_VERSION } from '@shared/audioChannels';
import type { JobQueue, JobRunContext } from '../jobs/jobQueue';
import { inFlightJob, trackInFlight, type InFlight } from '../jobs/inFlight';
import { cacheKeyForPath, cacheSubdir, fileExists, removeQuietly } from './cache';
import { FfmpegError, ffmpegFileArg, runFfmpeg } from './ffmpeg';
import { probeMedia } from './probe';

export interface ChannelProxyResult {
  path: string;
  /** shared/audioChannels.ts channelProxyKey of the request (MediaItem.channelProxies key). */
  key: string;
  /** True when a finished file was already in the cache. */
  cached: boolean;
}

/** Bit rate of the channel proxy's stereo AAC (the media proxies use 160k; this is all the file carries). */
export const CHANNEL_PROXY_BITRATE = '192k';

/** Cache path of the channel proxy for `selKey` (channelProxyKey) of the file whose cache key is `fileKey`. */
export function channelProxyOutputPath(fileKey: string, selKey: string): string {
  return path.join(cacheSubdir('proxies'), `${fileKey}_ch${selKey}_v${CHANNEL_PROXY_VERSION}.m4a`);
}

/**
 * ffmpeg arguments of a channel proxy: stream `stream` of `src` through `pan`, stereo AAC, padded to the container
 * start `startTime` (the probed format start_time, MediaProbe.startTime).
 */
export function buildChannelProxyArgs(src: string, stream: number, pan: string, outPart: string, startTime = 0): string[] {
  const rebase = Number.isFinite(startTime) && startTime > 0 ? `asetpts=PTS-${Math.round(startTime * 1e6) / 1e6}/TB,` : '';
  return [
    '-copyts',
    '-i', ffmpegFileArg(src),
    '-map', `0:${stream}`,
    '-vn', '-sn', '-dn',
    '-af', `${rebase}${pan},aresample=async=1:first_pts=0`,
    '-c:a', 'aac', '-b:a', CHANNEL_PROXY_BITRATE, '-ac', '2',
    '-map_metadata', '-1', '-map_chapters', '-1',
    '-movflags', '+faststart',
    '-f', 'mp4', ffmpegFileArg(outPart),
  ];
}

/** Valid request fields (the IPC boundary): an absolute stream index and a selection shape. */
export function validChannelProxyRequest(req: ChannelProxyRequest): string | null {
  if (!req || typeof req.path !== 'string' || !req.path) return 'no media path';
  if (!Number.isSafeInteger(req.stream) || req.stream < 0) return 'invalid audio stream';
  const s = req.selection as AudioChannelSelection | undefined;
  if (!s || (s.mode !== 'channel' && s.mode !== 'downmix')) return 'invalid channel selection';
  if (s.mode === 'channel' && typeof s.channel !== 'string') return 'invalid channel';
  if (s.mode === 'downmix' && !(Number.isFinite(s.centreDb) && Number.isFinite(s.surroundDb))) return 'invalid downmix levels';
  return null;
}

async function validOutput(file: string): Promise<boolean> {
  if (!(await fileExists(file))) return false;
  const info = await probeMedia(file).catch(() => undefined);
  if (info && info.duration > 0 && info.audio.length > 0) return true;
  await removeQuietly(file); // corrupt leftover
  return false;
}

async function removeStaleParts(out: string): Promise<void> {
  const dir = path.dirname(out);
  const prefix = `${path.basename(out)}.part`;
  let names: string[] = [];
  try { names = await fsp.readdir(dir); } catch { return; }
  await Promise.all(names.filter((n) => n === prefix || n.startsWith(`${prefix}-`)).map((n) => removeQuietly(path.join(dir, n))));
}

/** The job: probe the original (the stream's real layout), then encode the selection, or reuse the cached file. */
export async function runChannelProxy(req: ChannelProxyRequest, ctx: JobRunContext): Promise<ChannelProxyResult> {
  const bad = validChannelProxyRequest(req);
  if (bad) throw new Error(bad);
  const key = channelProxyKey(req.stream, req.selection);
  const probe = await probeMedia(req.path);
  const stream = audioStreamInfo(probe.audio, req.stream);
  if (!stream) throw new Error(`stream #${req.stream} is not an audio stream of ${path.basename(req.path)}`);
  const pan = channelPanFilter(req.selection, stream, 'stereo');
  if (!pan) throw new Error(`${channelSelectionLabel(req.selection)}: ${channelSelectionProblem(req.selection, stream) ?? 'not available'}`);

  const out = channelProxyOutputPath(await cacheKeyForPath(req.path), key);
  if (await validOutput(out)) {
    ctx.setProgress(1, 'Cached');
    return { path: out, key, cached: true };
  }
  const outPart = `${out}.part-${ctx.jobId}`;
  await removeStaleParts(out);
  ctx.setProgress(0, `Encoding ${channelSelectionLabel(req.selection)}`);
  const run = runFfmpeg(buildChannelProxyArgs(req.path, req.stream, pan, outPart, probe.startTime), {
    duration: probe.duration > 0 ? probe.duration : undefined,
    signal: ctx.signal,
    onProgress: (p, info) => ctx.setProgress(p, `${Math.round(p * 100)}%${info.speed ? ` (${info.speed.toFixed(1)}x)` : ''}`),
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
    throw new FfmpegError('channel proxy canceled', { canceled: true });
  }
  await fsp.rename(outPart, out);
  ctx.setProgress(1, 'Done');
  return { path: out, key, cached: false };
}

/** Queue a channel proxy job (or hand back the one already building the same file). */
export async function startChannelProxyJob(queue: JobQueue, req: ChannelProxyRequest): Promise<JobInfo> {
  const bad = validChannelProxyRequest(req);
  if (bad) throw new Error(bad);
  const key = channelProxyKey(req.stream, req.selection);
  const outputPath = channelProxyOutputPath(await cacheKeyForPath(req.path), key);
  const existing = inFlightJob(queue, inFlightChannelProxies, outputPath);
  if (existing) return existing;
  const job = queue.add<ChannelProxyResult>({
    kind: 'channelProxy',
    title: `Preview audio · ${channelSelectionLabel(req.selection)} · ${path.basename(req.path)} #${req.stream}`,
    mediaId: req.mediaId,
    run: (ctx) => runChannelProxy(req, ctx),
  });
  trackInFlight(queue, inFlightChannelProxies, outputPath, job.id);
  return job;
}

const inFlightChannelProxies: InFlight = new WeakMap();
