/**
 * Scene-cut detection via ffmpeg's `select='gt(scene,T)'` + `showinfo` on a downscaled stream.
 * Results are cached as `scenes/<key>_<threshold>.json`.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { JobInfo } from '@shared/model';
import type { SceneDetectRequest, SceneDetectResult } from '@shared/ipc';
import type { JobQueue, JobRunContext } from '../jobs/jobQueue';
import { inFlightJob, trackInFlight, type InFlight } from '../jobs/inFlight';
import { cacheKeyForPath, cacheSubdir, fileExists, removeQuietly } from './cache';
import { FfmpegError, ffmpegFileArg, runFfmpeg } from './ffmpeg';
import { probeMedia } from './probe';

export const DEFAULT_MIN_SCENE_SECONDS = 1.0;

export function sceneCachePath(key: string, threshold: number): string {
  return path.join(cacheSubdir('scenes'), `${key}_${threshold.toFixed(3)}.json`);
}

/** Parse a showinfo stderr line → pts_time seconds, or null. */
export function parseShowinfoPts(line: string): number | null {
  if (!line.includes('pts_time:')) return null;
  const m = /pts_time:\s*(-?\d+(?:\.\d+)?)/.exec(line);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return Number.isFinite(v) ? v : null;
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
  const key = await cacheKeyForPath(req.path);
  const cachePath = sceneCachePath(key, threshold);

  let duration = req.duration > 0 ? req.duration : 0;
  if (await fileExists(cachePath)) {
    try {
      const cached = JSON.parse(await fsp.readFile(cachePath, 'utf8')) as { boundaries: number[]; duration: number };
      if (Array.isArray(cached.boundaries)) {
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
      '-vf', `scale=320:-2,select='gt(scene,${threshold})',showinfo`,
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
    await fsp.writeFile(part, JSON.stringify(result));
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
