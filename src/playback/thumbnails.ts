/**
 * Renderer-side caches for thumbnails and waveforms produced by the main process.
 * Safe to import outside Electron: when `window.recut` is missing, thumbnails resolve to '' and
 * waveforms to null.
 */
import type { FilmstripRequest, WaveformData } from '../../shared/ipc';

function api(): Window['recut'] | null {
  if (typeof window === 'undefined') return null;
  const w = window as Partial<Window>;
  return w.recut ?? null;
}

class LRU<V> {
  private map = new Map<string, V>();
  constructor(private capacity: number) {}
  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) { this.map.delete(key); this.map.set(key, v); }
    return v;
  }
  set(key: string, v: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, v);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
  has(key: string): boolean { return this.map.has(key); }
  delete(key: string): void { this.map.delete(key); }
  clear(): void { this.map.clear(); }
  get size(): number { return this.map.size; }
  keys(): IterableIterator<string> { return this.map.keys(); }
}

interface StripEntry {
  promise: Promise<string[]>;
  /** Live requesters waiting on this IPC call. */
  sharers: number;
  /** Some requester cannot be canceled: never cancel the IPC. */
  pinned: boolean;
  canceled: boolean;
  requestId?: string;
}

/** The main process answers '' for a frame it did not produce; pathToMediaUrl('') yields a bare scheme URL. */
function cleanUrl(u: string | undefined): string {
  return u && !u.endsWith('://local/') ? u : '';
}

let stripSeq = 0;
let cancelQueue: string[] = [];
/**
 * Tell the main process to drop queued work of canceled requests (batched per task).
 * Uses the dedicated media:thumbCancel channel (RecutApi.cancelThumbnails).
 */
function cancelStripRequest(id: string): void {
  cancelQueue.push(id);
  if (cancelQueue.length > 1) return;
  queueMicrotask(() => {
    const ids = cancelQueue; cancelQueue = [];
    const recut = api();
    if (!recut || !ids.length) return;
    if (typeof recut.cancelThumbnails !== 'function') return;
    recut.cancelThumbnails(ids).catch(() => { /* ignore */ });
  });
}

export class ThumbnailCache {
  private cache: LRU<string>;
  private inflight = new Map<string, Promise<string>>();
  private inflightStrips = new Map<string, StripEntry>();

  constructor(capacity = 2000) { this.cache = new LRU<string>(capacity); }

  private key(mediaPath: string, timeSec: number, width: number): string {
    return `${mediaPath}|${Math.round(timeSec * 1000)}|${width}`;
  }

  /** Cached thumbnail URL (synchronous) or undefined when not yet fetched. */
  peek(mediaPath: string, timeSec: number, width: number): string | undefined {
    return this.cache.get(this.key(mediaPath, timeSec, width));
  }

  /** Resolves to a recut-media:// URL of a cached JPEG, or '' when unavailable. */
  get(mediaPath: string, timeSec: number, width: number, mediaId?: string): Promise<string> {
    const key = this.key(mediaPath, timeSec, width);
    const hit = this.cache.get(key);
    if (hit !== undefined) return Promise.resolve(hit);
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const recut = api();
    if (!recut) return Promise.resolve('');
    const p = recut.thumbnail({ path: mediaPath, time: timeSec, width, mediaId })
      .then((url) => { const u = cleanUrl(url); if (u) this.cache.set(key, u); return u; })
      .catch(() => '')
      .finally(() => { this.inflight.delete(key); });
    this.inflight.set(key, p);
    return p;
  }

  /**
   * Batch request; results align with `times`. Cached entries are served synchronously.
   *
   * `signal` makes the request cancellable (P-05): when it aborts, the promise resolves right away with what is
   * cached, and the main process drops the request's still-queued extraction (its queue is LIFO, so the newest
   * viewport is served first). Identical concurrent requests share one IPC call, which is only canceled once
   * every sharer has aborted.
   */
  filmstrip(mediaPath: string, times: number[], width: number, mediaId?: string, signal?: AbortSignal): Promise<string[]> {
    const out: string[] = new Array(times.length).fill('');
    const missing: number[] = [];
    times.forEach((t, i) => {
      const hit = this.cache.get(this.key(mediaPath, t, width));
      if (hit !== undefined) out[i] = hit; else missing.push(i);
    });
    if (!missing.length || signal?.aborted) return Promise.resolve(out);
    const recut = api();
    if (!recut) return Promise.resolve(out);
    const batchKey = `${mediaPath}|${width}|${missing.map((i) => Math.round(times[i] * 1000)).join(',')}`;
    let entry = this.inflightStrips.get(batchKey);
    if (!entry) {
      const requestId = signal ? `fs${++stripSeq}` : undefined;
      const e: StripEntry = { promise: Promise.resolve([]), sharers: 0, pinned: !signal, canceled: false, requestId };
      const req: FilmstripRequest = { path: mediaPath, times: missing.map((i) => times[i]), width, mediaId };
      if (requestId) req.requestId = requestId;
      e.promise = recut.filmstrip(req)
        .then((urls) => {
          const clean = urls.map(cleanUrl);
          if (!e.canceled) clean.forEach((u, j) => { if (u) this.cache.set(this.key(mediaPath, times[missing[j]], width), u); });
          return clean;
        })
        .catch(() => [] as string[])
        .finally(() => { if (this.inflightStrips.get(batchKey) === e) this.inflightStrips.delete(batchKey); });
      this.inflightStrips.set(batchKey, e);
      entry = e;
    }
    const e = entry;
    if (!signal) e.pinned = true;
    e.sharers++;
    const fill = (urls: string[]) => { missing.forEach((i, j) => { out[i] = urls[j] ?? ''; }); return out; };
    if (!signal) return e.promise.then(fill);
    return new Promise<string[]>((resolve) => {
      let done = false;
      const onAbort = () => {
        if (done) return;
        done = true;
        resolve(out);
        if (--e.sharers <= 0 && !e.pinned && !e.canceled) {
          e.canceled = true;
          if (this.inflightStrips.get(batchKey) === e) this.inflightStrips.delete(batchKey);
          if (e.requestId) cancelStripRequest(e.requestId);
        }
      };
      signal.addEventListener('abort', onAbort, { once: true });
      void e.promise.then((urls) => {
        if (done) return;
        done = true;
        signal.removeEventListener('abort', onAbort);
        e.sharers--;
        resolve(fill(urls));
      });
    });
  }

  invalidate(mediaPath: string): void {
    for (const k of [...this.cache.keys()]) if (k.startsWith(mediaPath + '|')) this.cache.delete(k);
  }
  clear(): void { this.cache.clear(); }
  get size(): number { return this.cache.size; }
}

export class WaveformCache {
  private cache = new Map<string, WaveformData | null>();
  private inflight = new Map<string, Promise<WaveformData | null>>();

  peek(mediaPath: string): WaveformData | null | undefined { return this.cache.get(mediaPath); }

  get(mediaPath: string, mediaId?: string): Promise<WaveformData | null> {
    if (this.cache.has(mediaPath)) return Promise.resolve(this.cache.get(mediaPath) ?? null);
    const pending = this.inflight.get(mediaPath);
    if (pending) return pending;
    const recut = api();
    if (!recut) return Promise.resolve(null);
    const p = recut.waveform(mediaPath, mediaId)
      .then((data) => {
        const norm = normalizeWaveform(data);
        if (norm) this.cache.set(mediaPath, norm);
        return norm;
      })
      .catch(() => null)
      .finally(() => { this.inflight.delete(mediaPath); });
    this.inflight.set(mediaPath, p);
    return p;
  }

  invalidate(mediaPath: string): void { this.cache.delete(mediaPath); }
  clear(): void { this.cache.clear(); }
}

/** IPC may deliver peaks as a plain array or ArrayBuffer-backed object; coerce to Uint8Array. */
export function normalizeWaveform(data: WaveformData | null | undefined): WaveformData | null {
  if (!data || !data.peaks || !(data.rate > 0)) return null;
  const peaks = data.peaks instanceof Uint8Array ? data.peaks : Uint8Array.from(data.peaks as ArrayLike<number>);
  return { rate: data.rate, peaks, duration: data.duration };
}

/**
 * Downsample a time range of a waveform into `buckets` values (max of each bucket, 0..255).
 * Ranges outside the data yield 0; `buckets` <= 0 yields an empty array.
 */
export function peaksForRange(data: WaveformData, startSec: number, endSec: number, buckets: number): Uint8Array {
  const n = Math.max(0, Math.floor(buckets));
  const out = new Uint8Array(n);
  if (n === 0 || !(data.rate > 0) || endSec <= startSec) return out;
  const peaks = data.peaks;
  const total = peaks.length;
  const span = (endSec - startSec) / n;
  for (let b = 0; b < n; b++) {
    const t0 = startSec + b * span;
    const t1 = t0 + span;
    let i0 = Math.floor(t0 * data.rate);
    let i1 = Math.ceil(t1 * data.rate);
    if (i1 <= i0) i1 = i0 + 1;
    if (i0 < 0) i0 = 0;
    if (i1 > total) i1 = total;
    let m = 0;
    for (let i = i0; i < i1; i++) { const v = peaks[i]; if (v > m) m = v; }
    out[b] = m;
  }
  return out;
}
