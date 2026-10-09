/**
 * Thumbnail + filmstrip extraction, cached as JPEG files under `thumbs/<key>/<timeMs>_<w>.jpg`.
 * The extracted frame is the one COVERING the time (what <video> shows), see frameSeekTime.
 */
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FilmstripRequest, ThumbnailRequest } from '@shared/ipc';
import { cacheKeysForPath, cacheSubdir, ensureDir, fileExists, findCachedFile, getCacheDir, removeQuietly, type MediaCacheKeys } from './cache';
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

/**
 * Abort the given renderer requests. A batch every requester of which has canceled is dropped while queued, and its
 * ffmpeg process is killed while running (frames it already finished are kept, partial ones deleted).
 */
export function cancelThumbRequests(ids: readonly string[]): void {
  for (const id of ids) { requesters.get(id)?.abort(); requesters.delete(id); }
}

/**
 * Shared extraction batch: several requesters may wait for the same frames (in-flight dedupe). The batch is
 * abandoned when every requester interested in it has canceled: dropped while queued, its ffmpeg killed while running.
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
 * written by an older extraction are never served again: before M-10 they held the frame AFTER a mid-frame time
 * (v2), before v3 an anamorphic source's thumbnail had its stored (squeezed) shape.
 */
const THUMB_VERSION = 'covering-frame-display-shape-v3';
function thumbDirName(key: string): string {
  return createHash('sha1').update(`${key}|${THUMB_VERSION}`).digest('hex');
}

async function thumbDir(key: string): Promise<string> {
  const dir = path.join(cacheSubdir('thumbs'), thumbDirName(key));
  await ensureDir(dir);
  return dir;
}

function thumbFileName(time: number, width: number): string { return `${timeKey(time)}_${width}.jpg`; }

/**
 * The cached frame `name` of a file: under its content key, else under its legacy (pre-0.10) key, adopted under the
 * content key (cache.ts findCachedFile). Null when it is not cached.
 */
function cachedFrame(keys: Pick<MediaCacheKeys, 'key' | 'legacyKey'>, name: string): Promise<string | null> {
  return findCachedFile(keys, (k) => path.join(cacheSubdir('thumbs'), thumbDirName(k), name));
}

export function thumbnailCachePath(key: string, time: number, width?: number): string {
  return path.join(cacheSubdir('thumbs'), thumbDirName(key), thumbFileName(time, normWidth(width)));
}

const THUMB_FILE_RE = /^[0-9a-f]{40}[\\/]\d+_\d+\.jpg$/;

/**
 * True for a finished thumbnail / filmstrip frame in the cache (`thumbs/<dir>/<ms>_<w>.jpg`, never a `.part`). Its
 * name is content-keyed: the directory hashes the source's content key (cacheKeyForPath: size + sampled fingerprint; or, for
 * entries from before 0.10, path + size + mtime) and THUMB_VERSION,
 * the file name the time and width, and the file only appears by a rename of a complete JPEG. So the bytes behind a
 * name never change: a changed source gets a new directory, hence a new URL. The recut-media:// handler lets the
 * renderer cache these (electron/media/protocol.ts).
 */
export function isThumbnailCacheFile(filePath: string): boolean {
  const rel = path.relative(path.join(getCacheDir(), 'thumbs'), path.resolve(filePath));
  return THUMB_FILE_RE.test(rel);
}

/**
 * A complete JPEG of plausible size: at least MIN_JPEG_BYTES and ending with the EOI marker (FF D9), which entropy-coded
 * data cannot contain (FF bytes are stuffed). A file cut short (ffmpeg killed mid-write) fails this.
 */
async function validOutput(p: string): Promise<boolean> {
  let fh: fsp.FileHandle | undefined;
  try {
    fh = await fsp.open(p, 'r');
    const st = await fh.stat();
    if (!st.isFile() || st.size < MIN_JPEG_BYTES) return false;
    const tail = Buffer.alloc(2);
    const { bytesRead } = await fh.read(tail, 0, 2, st.size - 2);
    return bytesRead === 2 && tail[0] === 0xff && tail[1] === 0xd9;
  } catch {
    return false;
  } finally {
    await fh?.close().catch(() => { /* ignore */ });
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

/**
 * Video filter for a `width`-wide thumbnail with the source's DISPLAY shape: non-square pixels (anamorphic DVD /
 * HDV, SAR from the stream) are first resampled to square ones along x, like the export's fitFilters and the
 * <video> element do, then the picture is scaled to `width` (height even, aspect kept). FFmpeg's `sar` is 1 for a
 * stream without one, so square-pixel sources keep their shape. Chromium ignores a JPEG's own aspect field, so the
 * pixels themselves must have the display shape; the final `setsar=1` drops the tiny SAR the even-height rounding
 * would otherwise record.
 */
export function thumbScaleFilter(width: number): string {
  return `scale=w='max(2,trunc(iw*sar/2)*2)':h=ih,setsar=1,scale=${width}:-2,setsar=1`;
}

/**
 * One ffmpeg invocation: seek to `time`, grab one frame, write JPEG to `out` (via .part). `signal` kills it.
 *
 * `-copyts`: FFmpeg drops the frames decoded before the `-ss` point by comparing them with the seek time on the
 * container's timeline. Without `-copyts`, FFmpeg 6.1 rebases an MPEG-TS / MPEG-PS input to the start of the mapped
 * streams instead (the video alone), and when the video does not start with the file (audio first, as usual) that
 * comparison let the frame before the seek point through: the thumbnail was one frame early. (8.1 and 9.0 got it
 * right without `-copyts`; the bundled builds were not affected, so THUMB_VERSION did not change.)
 */
async function extractOne(file: string, time: number, width: number, out: string, signal?: AbortSignal): Promise<boolean> {
  const part = `${out}.part`;
  const seek = frameSeekTime(time, await frameGrid(file));
  const args = [
    '-copyts',
    '-ss', fmtSeconds(seek),
    '-i', ffmpegFileArg(file),
    '-an', '-sn', '-dn',
    '-map', '0:v:0',
    '-frames:v', '1',
    '-vf', thumbScaleFilter(width),
    '-q:v', '4',
    '-f', 'mjpeg',
    ffmpegFileArg(part),
  ];
  try {
    await runFfmpeg(args, { stdout: 'ignore', signal }).promise;
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

/** Try the requested time, then T-0.5, then 0. `signal` kills the running attempt and skips the rest (AbortError). */
async function extractWithFallback(file: string, time: number, width: number, out: string, signal?: AbortSignal): Promise<void> {
  const attempts = [time];
  if (time - 0.5 > 0) attempts.push(time - 0.5);
  if (time !== 0) attempts.push(0);
  for (const t of attempts) {
    if (signal?.aborted) throw new ThumbAbortError();
    if (await extractOne(file, t, width, out, signal)) return;
  }
  if (signal?.aborted) throw new ThumbAbortError();
  throw new Error(`could not extract a frame from ${path.basename(file)} at ${time.toFixed(3)}s`);
}

/**
 * Returns the path of a cached JPEG thumbnail for `req.path` at `req.time` seconds.
 * Concurrent identical requests share one extraction; at most 3 ffmpeg processes run at once.
 */
export async function getThumbnail(req: ThumbnailRequest): Promise<string> {
  const width = normWidth(req.width);
  const keys = await cacheKeysForPath(req.path);
  const dir = await thumbDir(keys.key);
  const name = thumbFileName(req.time, width);
  const out = path.join(dir, name);
  const hit = await cachedFrame(keys, name);
  if (hit) return hit;

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
 * abandons this request's batches unless another live request is waiting for the same frames: a queued batch is
 * dropped before it spawns ffmpeg, a running one has its ffmpeg killed (so it does not keep the CPU busy after the
 * view moved on).
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
  const keys = await cacheKeysForPath(req.path);
  const dir = await thumbDir(keys.key);
  const outs = req.times.map((t) => path.join(dir, thumbFileName(t, width)));
  /** Frames already cached: the content-key file, or an older entry under the legacy key (cachedFrame). */
  const found = new Map<string, string>();
  const joined = new Set<SharedBatch>();

  // unique uncached times (not currently in flight elsewhere)
  const pending = new Map<string, number>();
  for (let i = 0; i < req.times.length; i++) {
    const out = outs[i];
    if (pending.has(out)) continue;
    // A batch abandoned by all its requesters (killed or dropped) settles at once: wait for it, then take the frame
    // over (cached by then if the batch had finished it) instead of joining a batch that will not produce it.
    let fl = inFlight.get(out);
    while (fl && frameBatch.get(out)?.controller.signal.aborted) { await fl.catch(() => null); fl = inFlight.get(out); }
    if (fl) { const b = frameBatch.get(out); if (b) joinBatch(b, signal, joined); continue; }
    const hit = await cachedFrame(keys, path.basename(out));
    if (hit) { found.set(out, hit); continue; }
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
    const p = withSlot(() => extractBatch(req.path, width, batch, bsig), bsig).then(() => true, () => false);
    // Each frame gets its own in-flight promise: batch result, then per-frame fallback if missing.
    for (const [out, t] of batch) {
      frameBatch.set(out, shared);
      const single: Promise<string | null> = p.then(async (ran) => {
        if (await fileExists(out)) return out;
        if (!ran || bsig.aborted) return null; // dropped while queued: nobody wants it any more
        try {
          await withSlot(() => extractWithFallback(req.path, t, width, out, bsig), bsig);
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
      const hit = found.get(out);
      if (hit) return hit;
      if (await fileExists(out)) return out;
      if (signal?.aborted) return '';
      return getThumbnail({ path: req.path, time: t, width, mediaId: req.mediaId });
    }));
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (!signal?.aborted) for (const b of joined) { if (Number.isFinite(b.refs)) b.refs--; }
  }
}

/**
 * One ffmpeg process for the batch's frames, each written to `<out>.part` and renamed to `<out>` once it is a complete
 * JPEG. `signal` (every requester of the batch canceled) kills the process: frames it had finished are still kept,
 * cut-short `.part` files are deleted, so the cache never holds a partial file under a final name.
 */
async function extractBatch(file: string, width: number, batch: [string, number][], signal?: AbortSignal): Promise<void> {
  if (batch.length === 0 || signal?.aborted) return;
  if (batch.length === 1) {
    const [out, t] = batch[0];
    try { await extractWithFallback(file, t, width, out, signal); } catch { /* resolved later by getThumbnail */ }
    return;
  }
  const args: string[] = ['-copyts']; // as in extractOne
  const grid = await frameGrid(file);
  for (const [, t] of batch) args.push('-ss', fmtSeconds(frameSeekTime(t, grid)), '-i', ffmpegFileArg(file));
  batch.forEach(([out], idx) => {
    args.push(
      '-map', `${idx}:v:0`,
      '-an', '-sn', '-dn',
      '-frames:v', '1',
      '-vf', thumbScaleFilter(width),
      '-q:v', '4',
      '-f', 'mjpeg',
      ffmpegFileArg(`${out}.part`),
    );
  });
  if (signal?.aborted) return; // abandoned while probing the frame grid
  try {
    await runFfmpeg(args, { stdout: 'ignore', signal }).promise;
  } catch {
    // A failing input (e.g. time past EOF) fails the whole batch, and a kill ends it: keep the complete frames.
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
