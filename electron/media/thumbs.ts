/**
 * Thumbnail + filmstrip extraction, cached as JPEG files under `thumbs/<key>/<timeMs>_<w>.jpg`.
 * The extracted frame is the one COVERING the time (what <video> shows), see frameSeekTime.
 */
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FilmstripRequest, ThumbnailRequest } from '@shared/ipc';
import { cacheKeyForPath, cacheSubdir, ensureDir, fileExists, removeQuietly } from './cache';
import { ffmpegFileArg, fmtSeconds, runFfmpeg } from './ffmpeg';
import { probeMedia, type ProbedVideoStreamInfo } from './probe';

const DEFAULT_WIDTH = 160;
const MAX_CONCURRENT = 3;
const FILMSTRIP_BATCH = 12;
/** A JPEG smaller than this is treated as a failed/garbage frame. */
const MIN_JPEG_BYTES = 200;

// ------------------------------------------------------------------
// LIFO semaphore with cancellable waiters (P-05): the newest request (the current viewport) is served first and
// a queued waiter whose requester went away is dropped before it ever spawns ffmpeg.
// ------------------------------------------------------------------
let active = 0;
interface Waiter { run: () => void; drop: () => void; signal?: AbortSignal }
const waiting: Waiter[] = [];

class ThumbAbortError extends Error { constructor() { super('thumbnail request canceled'); this.name = 'AbortError'; } }

function acquire(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new ThumbAbortError());
  if (active < MAX_CONCURRENT) { active++; return Promise.resolve(); }
  return new Promise((resolve, reject) => {
    const onAbort = () => { const i = waiting.indexOf(w); if (i >= 0) { waiting.splice(i, 1); reject(new ThumbAbortError()); } };
    const w: Waiter = {
      run: () => { signal?.removeEventListener('abort', onAbort); active++; resolve(); },
      drop: onAbort,
      signal,
    };
    waiting.push(w);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
function release(): void {
  active--;
  const next = waiting.pop(); // LIFO
  if (next) next.run();
}
async function withSlot<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  await acquire(signal);
  try { return await fn(); } finally { release(); }
}

/** Number of queued (not yet running) thumbnail jobs. For tests / diagnostics. */
export function thumbQueueDepth(): { active: number; waiting: number } { return { active, waiting: waiting.length }; }

// ------------------------------------------------------------------
// Request cancellation. A renderer request may carry a `requestId`; `cancelThumbRequests([ids])` (IPC channel
// media:thumbCancel, RecutApi.cancelThumbnails) aborts those requesters.
// ------------------------------------------------------------------
const requesters = new Map<string, AbortController>();

/** Abort the given renderer requests: their queued batches are dropped (running ffmpeg jobs finish and are cached). */
export function cancelThumbRequests(ids: readonly string[]): void {
  for (const id of ids) { requesters.get(id)?.abort(); requesters.delete(id); }
}

/**
 * Shared extraction batch: several requesters may wait for the same frames (in-flight dedupe). The batch is
 * only abandoned (while still queued) when every requester interested in it has canceled.
 */
interface SharedBatch { controller: AbortController; refs: number }
const frameBatch = new Map<string, SharedBatch>();

function joinBatch(b: SharedBatch, signal: AbortSignal | undefined, joined: Set<SharedBatch>): void {
  if (joined.has(b)) return;
  joined.add(b);
  if (!signal) { b.refs = Number.POSITIVE_INFINITY; return; } // an uncancellable requester pins the batch
  b.refs++;
}
function leaveBatches(joined: Set<SharedBatch>): void {
  for (const b of joined) { b.refs--; if (b.refs <= 0) b.controller.abort(); }
}

// ------------------------------------------------------------------
/** Output path -> pending extraction. Resolves to null when its (queued) batch was dropped because every requester canceled. */
const inFlight = new Map<string, Promise<string | null>>();

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
    '-i', ffmpegFileArg(file),
    '-an', '-sn', '-dn',
    '-map', '0:v:0',
    '-frames:v', '1',
    '-vf', `scale=${width}:-2`,
    '-q:v', '4',
    '-f', 'mjpeg',
    ffmpegFileArg(part),
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
  if (existing) { const v = await existing; if (v !== null) return v; }
  const again = inFlight.get(out); // another caller may have restarted it while we awaited
  if (again) { const v = await again; if (v !== null) return v; }

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
 * Returns file paths aligned with `req.times` ('' for frames dropped because the request was canceled).
 *
 * Queueing is LIFO (newest viewport first). `signal` (or a `requestId` later passed to `cancelThumbRequests`)
 * drops this request's still-queued batches unless another live request is waiting for the same frames.
 */
export async function getFilmstrip(req: FilmstripRequest, signal?: AbortSignal): Promise<string[]> {
  // Register synchronously (before any await) so a cancel arriving right behind this request finds it.
  if (req.requestId && !signal) {
    const ac = new AbortController();
    requesters.set(req.requestId, ac);
    signal = ac.signal;
  }
  try {
    return await filmstripInner(req, signal);
  } finally {
    if (req.requestId) requesters.delete(req.requestId);
  }
}

async function filmstripInner(req: FilmstripRequest, signal: AbortSignal | undefined): Promise<string[]> {
  const width = normWidth(req.width);
  const key = await cacheKeyForPath(req.path);
  const dir = await thumbDir(key);
  const outs = req.times.map((t) => path.join(dir, thumbFileName(t, width)));
  const joined = new Set<SharedBatch>();

  // unique uncached times (not currently in flight elsewhere)
  const pending = new Map<string, number>();
  for (let i = 0; i < req.times.length; i++) {
    const out = outs[i];
    if (pending.has(out)) continue;
    if (inFlight.has(out)) { const b = frameBatch.get(out); if (b) joinBatch(b, signal, joined); continue; }
    if (await fileExists(out)) continue;
    pending.set(out, Math.max(0, req.times[i]));
  }
  if (signal?.aborted) { leaveBatches(joined); return outs.map(() => ''); }

  const entries = [...pending.entries()].sort((a, b) => a[1] - b[1]);
  const batches: [string, number][][] = [];
  for (let i = 0; i < entries.length; i += FILMSTRIP_BATCH) batches.push(entries.slice(i, i + FILMSTRIP_BATCH));

  const batchPromises = batches.map((batch) => {
    const shared: SharedBatch = { controller: new AbortController(), refs: 0 };
    joinBatch(shared, signal, joined);
    const bsig = shared.controller.signal;
    const p = withSlot(() => extractBatch(req.path, width, batch), bsig).then(() => true, () => false);
    // Each frame gets its own in-flight promise: batch result, then per-frame fallback if missing.
    for (const [out, t] of batch) {
      frameBatch.set(out, shared);
      const single: Promise<string | null> = p.then(async (ran) => {
        if (await fileExists(out)) return out;
        if (!ran || bsig.aborted) return null; // dropped while queued: nobody wants it any more
        try {
          await withSlot(() => extractWithFallback(req.path, t, width, out), bsig);
        } catch (err) {
          if (bsig.aborted) return null;
          throw err;
        }
        return out;
      }).finally(() => {
        if (inFlight.get(out) === single) inFlight.delete(out);
        if (frameBatch.get(out) === shared) frameBatch.delete(out);
      });
      inFlight.set(out, single);
    }
    return p;
  });
  // Abort → drop our interest in every batch we created or joined.
  const onAbort = () => leaveBatches(joined);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await Promise.all(batchPromises);
    // Resolve every requested time (cached, in flight from this or another call, or extract now).
    return await Promise.all(req.times.map(async (t, i) => {
      const out = outs[i];
      const inflight = inFlight.get(out);
      if (inflight) { const v = await inflight; if (v !== null) return v; }
      if (await fileExists(out)) return out;
      if (signal?.aborted) return '';
      return getThumbnail({ path: req.path, time: t, width, mediaId: req.mediaId });
    }));
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (!signal?.aborted) for (const b of joined) { if (Number.isFinite(b.refs)) b.refs--; }
  }
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
  for (const [, t] of batch) args.push('-ss', fmtSeconds(frameSeekTime(t, grid)), '-i', ffmpegFileArg(file));
  batch.forEach(([out], idx) => {
    args.push(
      '-map', `${idx}:v:0`,
      '-an', '-sn', '-dn',
      '-frames:v', '1',
      '-vf', `scale=${width}:-2`,
      '-q:v', '4',
      '-f', 'mjpeg',
      ffmpegFileArg(`${out}.part`),
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
