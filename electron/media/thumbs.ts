/**
 * Thumbnail + filmstrip extraction, cached as JPEG files under `thumbs/<key>/<timeMs>_<w>.jpg`.
 * The extracted frame is the one COVERING the time (what <video> shows), see frameSeekTime.
 */
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FilmstripRequest, ThumbnailRequest } from '@shared/ipc';
import { cacheKeyForPath, cacheSubdir, ensureDir, fileExists, removeQuietly } from './cache';
import { fmtSeconds, runFfmpeg } from './ffmpeg';
import { probeMedia, type ProbedVideoStreamInfo } from './probe';

const DEFAULT_WIDTH = 160;
const MAX_CONCURRENT = 3;
const FILMSTRIP_BATCH = 12;
/** A JPEG smaller than this is treated as a failed/garbage frame. */
const MIN_JPEG_BYTES = 200;

// ------------------------------------------------------------------
// Tiny semaphore
// ------------------------------------------------------------------
let active = 0;
const waiting: (() => void)[] = [];

function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) { active++; return Promise.resolve(); }
  return new Promise((resolve) => waiting.push(() => { active++; resolve(); }));
}
function release(): void {
  active--;
  const next = waiting.shift();
  if (next) next();
}
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  await acquire();
  try { return await fn(); } finally { release(); }
}

// ------------------------------------------------------------------
const inFlight = new Map<string, Promise<string>>();

function normWidth(w: number | undefined): number {
  const v = Math.round(w && w > 0 ? w : DEFAULT_WIDTH);
  return v % 2 ? v + 1 : v;
}

function timeKey(time: number): number {
  return Math.max(0, Math.round((Number.isFinite(time) ? time : 0) * 1000));
}

/**
 * Per-file thumbnail directory name: the file's cache key, re-hashed with the extraction version so entries
 * written before M-10 (which held the frame AFTER a mid-frame time) are never served again.
 */
const THUMB_VERSION = 'covering-frame-v2';
function thumbDirName(key: string): string {
  return createHash('sha1').update(`${key}|${THUMB_VERSION}`).digest('hex');
}

async function thumbDir(key: string): Promise<string> {
  const dir = path.join(cacheSubdir('thumbs'), thumbDirName(key));
  await ensureDir(dir);
  return dir;
}

function thumbFileName(time: number, width: number): string { return `${timeKey(time)}_${width}.jpg`; }

export function thumbnailCachePath(key: string, time: number, width?: number): string {
  return path.join(cacheSubdir('thumbs'), thumbDirName(key), thumbFileName(time, normWidth(width)));
}

async function validOutput(p: string): Promise<boolean> {
  try {
    const st = await fsp.stat(p);
    return st.isFile() && st.size >= MIN_JPEG_BYTES;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------
// Frame-exact seek (M-10)
// ------------------------------------------------------------------

/** CFR frame grid of a file's video stream: fps and the first frame's container-relative time. */
export interface FrameGrid { fps: number; start: number }

const gridCache = new Map<string, Promise<FrameGrid | null>>();

/** Frame grid of `file` (null for VFR, stills or unknown: then thumbnails seek to the raw time). */
function frameGrid(file: string): Promise<FrameGrid | null> {
  let p = gridCache.get(file);
  if (!p) {
    p = probeMedia(file).then((pr) => {
      const v = pr.video as ProbedVideoStreamInfo | undefined;
      if (!v || v.isVfr || !(pr.duration > 0) || !(v.fps.num > 0 && v.fps.den > 0)) return null;
      return { fps: v.fps.num / v.fps.den, start: typeof v.startTime === 'number' && v.startTime > 0 ? v.startTime : 0 };
    }).catch(() => null);
    gridCache.set(file, p);
    if (gridCache.size > 256) gridCache.delete(gridCache.keys().next().value as string);
  }
  return p;
}

/**
 * Input-seek time that makes ffmpeg return the frame COVERING `time` (what <video> shows), not the first
 * frame at or after it: a quarter frame before the covering frame's start, so stream time-base rounding of
 * frame pts (1/1000 in MKV) cannot skip it.
 */
export function frameSeekTime(time: number, grid: FrameGrid | null): number {
  if (!grid || !Number.isFinite(time)) return time;
  const j = Math.floor((time - grid.start) * grid.fps + 1e-6);
  if (j <= 0) return 0;
  return Math.max(0, grid.start + (j - 0.25) / grid.fps);
}

/** One ffmpeg invocation: seek to `time`, grab one frame, write JPEG to `out` (via .part). */
async function extractOne(file: string, time: number, width: number, out: string): Promise<boolean> {
  const part = `${out}.part`;
  const seek = frameSeekTime(time, await frameGrid(file));
  const args = [
    '-ss', fmtSeconds(seek),
    '-i', file,
    '-an', '-sn', '-dn',
    '-map', '0:v:0',
    '-frames:v', '1',
    '-vf', `scale=${width}:-2`,
    '-q:v', '4',
    '-f', 'mjpeg',
    part,
  ];
  try {
    await runFfmpeg(args, { stdout: 'ignore' }).promise;
  } catch {
    await removeQuietly(part);
    return false;
  }
  if (!(await validOutput(part))) {
    await removeQuietly(part);
    return false;
  }
  await fsp.rename(part, out);
  return true;
}

/** Try the requested time, then T-0.5, then 0. */
async function extractWithFallback(file: string, time: number, width: number, out: string): Promise<void> {
  const attempts = [time];
  if (time - 0.5 > 0) attempts.push(time - 0.5);
  if (time !== 0) attempts.push(0);
  for (const t of attempts) {
    if (await extractOne(file, t, width, out)) return;
  }
  throw new Error(`could not extract a frame from ${path.basename(file)} at ${time.toFixed(3)}s`);
}

/**
 * Returns the path of a cached JPEG thumbnail for `req.path` at `req.time` seconds.
 * Concurrent identical requests share one extraction; at most 3 ffmpeg processes run at once.
 */
export async function getThumbnail(req: ThumbnailRequest): Promise<string> {
  const width = normWidth(req.width);
  const key = await cacheKeyForPath(req.path);
  const dir = await thumbDir(key);
  const out = path.join(dir, thumbFileName(req.time, width));
  if (await fileExists(out)) return out;

  const existing = inFlight.get(out);
  if (existing) return existing;

  const task = withSlot(async () => {
    if (await fileExists(out)) return out; // produced by a filmstrip batch meanwhile
    await extractWithFallback(req.path, Math.max(0, req.time), width, out);
    return out;
  }).finally(() => { inFlight.delete(out); });
  inFlight.set(out, task);
  return task;
}

/**
 * Extract several thumbnails from one file. Uncached times are batched into a single ffmpeg
 * process (one `-ss T -i file` input per frame, each mapped to its own output) which is far
 * faster than one process per frame; frames the batch cannot produce fall back to getThumbnail.
 * Returns file paths aligned with `req.times`.
 */
export async function getFilmstrip(req: FilmstripRequest): Promise<string[]> {
  const width = normWidth(req.width);
  const key = await cacheKeyForPath(req.path);
  const dir = await thumbDir(key);
  const outs = req.times.map((t) => path.join(dir, thumbFileName(t, width)));

  // unique uncached times (not currently in flight elsewhere)
  const pending = new Map<string, number>();
  for (let i = 0; i < req.times.length; i++) {
    const out = outs[i];
    if (pending.has(out) || inFlight.has(out)) continue;
    if (await fileExists(out)) continue;
    pending.set(out, Math.max(0, req.times[i]));
  }

  const entries = [...pending.entries()].sort((a, b) => a[1] - b[1]);
  const batches: [string, number][][] = [];
  for (let i = 0; i < entries.length; i += FILMSTRIP_BATCH) batches.push(entries.slice(i, i + FILMSTRIP_BATCH));

  const batchPromises = batches.map((batch) => {
    const p = withSlot(() => extractBatch(req.path, width, batch));
    // Each frame gets its own in-flight promise: batch result, then per-frame fallback if missing.
    for (const [out, t] of batch) {
      const single = p.then(async () => {
        if (await fileExists(out)) return out;
        await withSlot(() => extractWithFallback(req.path, t, width, out));
        return out;
      }).finally(() => { if (inFlight.get(out) === single) inFlight.delete(out); });
      inFlight.set(out, single);
    }
    return p;
  });
  await Promise.all(batchPromises);

  // Resolve every requested time (cached, in flight from this or another call, or extract now).
  return Promise.all(req.times.map(async (t, i) => {
    const out = outs[i];
    const pending = inFlight.get(out);
    if (pending) return pending;
    if (await fileExists(out)) return out;
    return getThumbnail({ path: req.path, time: t, width, mediaId: req.mediaId });
  }));
}

async function extractBatch(file: string, width: number, batch: [string, number][]): Promise<void> {
  if (batch.length === 0) return;
  if (batch.length === 1) {
    const [out, t] = batch[0];
    try { await extractWithFallback(file, t, width, out); } catch { /* resolved later by getThumbnail */ }
    return;
  }
  const args: string[] = [];
  const grid = await frameGrid(file);
  for (const [, t] of batch) args.push('-ss', fmtSeconds(frameSeekTime(t, grid)), '-i', file);
  batch.forEach(([out], idx) => {
    args.push(
      '-map', `${idx}:v:0`,
      '-an', '-sn', '-dn',
      '-frames:v', '1',
      '-vf', `scale=${width}:-2`,
      '-q:v', '4',
      '-f', 'mjpeg',
      `${out}.part`,
    );
  });
  try {
    await runFfmpeg(args, { stdout: 'ignore' }).promise;
  } catch {
    // A failing input (e.g. time past EOF) fails the whole batch; keep whatever was written.
  }
  await Promise.all(batch.map(async ([out]) => {
    const part = `${out}.part`;
    if (await validOutput(part)) {
      await fsp.rename(part, out).catch(() => removeQuietly(part));
    } else {
      await removeQuietly(part);
    }
  }));
}
