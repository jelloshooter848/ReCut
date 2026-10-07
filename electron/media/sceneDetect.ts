/**
 * Scene-cut detection via ffmpeg's `select='gt(scene,T)'` + `showinfo` on a downscaled stream.
 * Results are cached as `scenes/<key>_<threshold>.json`, stamped with SCENE_VERSION.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { JobInfo } from '@shared/model';
import type { SceneDetectRequest, SceneDetectResult } from '@shared/ipc';
import type { JobQueue, JobRunContext } from '../jobs/jobQueue';
import { inFlightJob, trackInFlight, type InFlight } from '../jobs/inFlight';
import { cacheKeysForPath, cacheSubdir, findCachedFile, removeQuietly } from './cache';
import { FfmpegError, ffmpegFileArg, runFfmpeg } from './ffmpeg';
import { probeMedia } from './probe';

export const DEFAULT_MIN_SCENE_SECONDS = 1.0;

/**
 * Bump when the detected boundaries for the same file and threshold change, so cached results are recomputed.
 * v2: boundaries come from showinfo's integer `pts` in AV_TIME_BASE units instead of the rounded `pts_time` text.
 */
export const SCENE_VERSION = 2;

/** FFmpeg's AV_TIME_BASE: `settb=AVTB` puts the frames into 1/1000000 s ticks before showinfo prints them. */
export const AV_TIME_BASE = 1_000_000;

/** The scene-detect filter chain. `settb=AVTB` makes showinfo's integer `pts` field microseconds. */
export function sceneFilter(threshold: number): string {
  return `scale=320:-2,select='gt(scene,${threshold})',settb=AVTB,showinfo`;
}

export function sceneCachePath(key: string, threshold: number): string {
  return path.join(cacheSubdir('scenes'), `${key}_${threshold.toFixed(3)}.json`);
}

/**
 * Parse a showinfo frame line → its time in seconds, or null (other lines, `pts:NOPTS`).
 * Reads the integer `pts:` field and scales it by `timeBase` (default AV_TIME_BASE, as set by `settb=AVTB` in
 * sceneFilter). `pts_time` is not used: FFmpeg 6.1 prints it with 6 significant digits (`12345.1` for
 * 12345.133 s, `4.32e+06` for 4320000.5 s), which is off by frames on media longer than 10,000 s.
 */
export function parseShowinfoPts(line: string, timeBase: { num: number; den: number } = { num: 1, den: AV_TIME_BASE }): number | null {
  const m = /(?:^|\s)pts:\s*(-?\d+)\s+pts_time:/.exec(line);
  if (!m) return null;
  const pts = Number(m[1]);
  if (!Number.isSafeInteger(pts) || !(timeBase.den > 0)) return null;
  return (pts * timeBase.num) / timeBase.den;
}

/** Drop boundaries closer than `minGap` to the previous kept one (and to 0). Input need not be sorted. */
export function enforceMinSceneGap(boundaries: number[], minGap: number): number[] {
  const sorted = [...boundaries].filter((b) => Number.isFinite(b) && b > 0).sort((a, b) => a - b);
  const out: number[] = [];
  let last = 0;
  for (const b of sorted) {
    if (b - last >= minGap) {
      out.push(b);
      last = b;
    }
  }
  return out;
}

export async function runSceneDetect(req: SceneDetectRequest, ctx: JobRunContext): Promise<SceneDetectResult> {
  const threshold = Math.min(1, Math.max(0, Number.isFinite(req.threshold) ? req.threshold : 0.4));
  const minGap = req.minSceneSeconds !== undefined && req.minSceneSeconds >= 0 ? req.minSceneSeconds : DEFAULT_MIN_SCENE_SECONDS;
  const keys = await cacheKeysForPath(req.path);
  const cachePath = sceneCachePath(keys.key, threshold);

  let duration = req.duration > 0 ? req.duration : 0;
  // Under the content key, else a result an older version cached under the legacy key (cache.ts findCachedFile).
  const hit = await findCachedFile(keys, (k) => sceneCachePath(k, threshold));
  if (hit) {
    try {
      const cached = JSON.parse(await fsp.readFile(hit, 'utf8')) as { boundaries: number[]; duration: number; version?: number };
      if (cached.version === SCENE_VERSION && Array.isArray(cached.boundaries)) {
        ctx.setProgress(1, 'Cached');
        return { boundaries: enforceMinSceneGap(cached.boundaries, minGap), duration: cached.duration || duration };
      }
    } catch { /* fall through and recompute */ }
  }

  if (!(duration > 0)) {
    const probe = await probeMedia(req.path);
    duration = probe.duration;
    if (!probe.video) throw new Error('source has no video stream');
  }

  const rawBoundaries: number[] = [];
  const run = runFfmpeg(
    [
      '-i', ffmpegFileArg(req.path),
      '-map', '0:v:0',
      '-an', '-sn', '-dn',
      '-vf', sceneFilter(threshold),
      '-fps_mode', 'passthrough',
      '-f', 'null', '-',
    ],
    {
      duration: duration > 0 ? duration : undefined,
      loglevel: 'info',
      signal: ctx.signal,
      onProgress: (p) => ctx.setProgress(p, `${Math.round(p * 100)}% · ${rawBoundaries.length} cuts`),
      onStderrLine: (line) => {
        const t = parseShowinfoPts(line);
        if (t !== null) rawBoundaries.push(t);
      },
    },
  );
  ctx.onCancel(() => run.cancel());
  await run.promise;
  if (ctx.signal.aborted) throw new FfmpegError('scene detection canceled', { canceled: true });

  const result: SceneDetectResult = { boundaries: enforceMinSceneGap(rawBoundaries, 0), duration };
  // cache the un-filtered list so a different minSceneSeconds can reuse it
  const part = `${cachePath}.part`;
  try {
    await fsp.writeFile(part, JSON.stringify({ ...result, version: SCENE_VERSION }));
    await fsp.rename(part, cachePath);
  } catch {
    await removeQuietly(part);
  }
  ctx.setProgress(1, `${result.boundaries.length} cuts`);
  return { boundaries: enforceMinSceneGap(result.boundaries, minGap), duration };
}

const inFlightSceneDetects: InFlight = new WeakMap();

export function startSceneDetectJob(
  queue: JobQueue,
  req: SceneDetectRequest,
  onDone?: (job: JobInfo, result: SceneDetectResult | null, error: string | null) => void,
): JobInfo {
  // De-dupe: the same detection (media + threshold) already queued/running -> return that job.
  const key = `${req.mediaId}|${req.threshold}`;
  const existing = inFlightJob(queue, inFlightSceneDetects, key);
  if (existing) return existing;
  const job = queue.add<SceneDetectResult>({
    kind: 'sceneDetect',
    title: `Scene detection · ${path.basename(req.path)}`,
    mediaId: req.mediaId,
    run: (ctx) => runSceneDetect(req, ctx),
  });
  trackInFlight(queue, inFlightSceneDetects, key, job.id);
  if (onDone) {
    queue.waitFor(job.id).then((final) => {
      onDone(
        final,
        final.status === 'done' ? (final.result as SceneDetectResult) : null,
        final.status === 'failed' ? final.error ?? 'failed' : final.status === 'canceled' ? 'canceled' : null,
      );
    }).catch(() => { /* unknown id only */ });
  }
  return job;
}
