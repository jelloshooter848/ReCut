/**
 * Shot-cut detection (#149): FFmpeg decodes every frame small (SHOT_ANALYSIS_WIDTH x HEIGHT, RGB24) to stdout and
 * prints each frame's timestamp with `showinfo`; shared/shotDetect.ts (a port of PySceneDetect's AdaptiveDetector)
 * scores the frames and picks the cuts. Results are cached as `scenes/<key>_<threshold>.json`, stamped with
 * SCENE_VERSION.
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
import { AdaptiveCutter, adaptiveThresholdFor, ContentScorer, SHOT_ANALYSIS_HEIGHT, SHOT_ANALYSIS_WIDTH } from '@shared/shotDetect';

export const DEFAULT_MIN_SCENE_SECONDS = 1.0;

/**
 * Bump when the detected boundaries for the same file and threshold change, so cached results are recomputed.
 * v2: boundaries come from showinfo's integer `pts` in AV_TIME_BASE units instead of the rounded `pts_time` text.
 * v3: boundaries are relative to the container start, not to the video stream's start, on MPEG-TS / MPEG-PS too
 *     (bugs/closed/2026-10-09-ts-late-video-export-early.md).
 * v4: the adaptive detector (shared/shotDetect.ts) instead of FFmpeg's fixed `scene` threshold (#149).
 */
export const SCENE_VERSION = 4;

/** FFmpeg's AV_TIME_BASE: `settb=AVTB` puts the frames into 1/1000000 s ticks before showinfo prints them. */
export const AV_TIME_BASE = 1_000_000;

/**
 * The shot-detect filter chain: every frame scaled to the analysis size as packed RGB, and `settb=AVTB` so showinfo's
 * integer `pts` field is microseconds.
 */
export function shotFilter(): string {
  return `scale=${SHOT_ANALYSIS_WIDTH}:${SHOT_ANALYSIS_HEIGHT}:flags=area,format=rgb24,settb=AVTB,showinfo`;
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

  // Boundaries are container-relative source seconds (the preview's and the export's zero). `-copyts` keeps the file's
  // own timestamps and the probed container start is subtracted here: without it FFmpeg rebases MPEG-TS / MPEG-PS to
  // the start of the streams the command maps (the video stream alone), so cuts in a file whose video starts after
  // its audio came out early by that offset.
  let startTime = 0;
  if (!(duration > 0)) {
    const probe = await probeMedia(req.path);
    duration = probe.duration;
    if (!probe.video) throw new Error('source has no video stream');
    startTime = probe.startTime;
  } else {
    const probe = await probeMedia(req.path).catch(() => undefined);
    startTime = probe?.startTime ?? 0;
  }
  const startUs = Number.isFinite(startTime) && startTime > 0 ? Math.round(startTime * AV_TIME_BASE) : 0;

  // Frames arrive on stdout in decode order, their timestamps on stderr (showinfo), each in order: frame i pairs with
  // the i-th timestamp. The cut rule needs only frame indices, so the two streams are matched at the end.
  const frameBytes = SHOT_ANALYSIS_WIDTH * SHOT_ANALYSIS_HEIGHT * 3;
  const frame = new Uint8Array(frameBytes);
  let filled = 0;
  let index = 0;
  const scorer = new ContentScorer(SHOT_ANALYSIS_WIDTH * SHOT_ANALYSIS_HEIGHT);
  const cutter = new AdaptiveCutter({ adaptiveThreshold: adaptiveThresholdFor(threshold) });
  const cutFrames: number[] = [];
  const ptsUs: number[] = [];
  const onStdout = (chunk: Buffer) => {
    let off = 0;
    while (off < chunk.length) {
      const n = Math.min(frameBytes - filled, chunk.length - off);
      frame.set(chunk.subarray(off, off + n), filled);
      filled += n; off += n;
      if (filled === frameBytes) {
        const cut = cutter.push(index, scorer.score(frame));
        if (cut !== null) cutFrames.push(cut);
        index++;
        filled = 0;
      }
    }
  };
  const run = runFfmpeg(
    [
      '-copyts',
      '-i', ffmpegFileArg(req.path),
      '-map', '0:v:0',
      '-an', '-sn', '-dn',
      '-vf', shotFilter(),
      '-fps_mode', 'passthrough',
      '-f', 'rawvideo', 'pipe:1',
    ],
    {
      duration: duration > 0 ? duration : undefined,
      stdout: 'data',
      onStdout,
      loglevel: 'info',
      signal: ctx.signal,
      onProgress: (p) => ctx.setProgress(p, `${Math.round(p * 100)}% · ${cutFrames.length} cuts`),
      onStderrLine: (line) => {
        const t = parseShowinfoPts(line);
        if (t !== null) ptsUs.push(Math.round(t * AV_TIME_BASE) - startUs);
      },
    },
  );
  ctx.onCancel(() => run.cancel());
  await run.promise;
  if (ctx.signal.aborted) throw new FfmpegError('shot detection canceled', { canceled: true });
  const rawBoundaries = cutFrames.filter((i) => i < ptsUs.length).map((i) => ptsUs[i] / AV_TIME_BASE);

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
    title: `Shot detection · ${path.basename(req.path)}`,
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
