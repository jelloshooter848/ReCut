/**
 * Renderer-side caches for thumbnails and waveforms produced by the main process.
 * Safe to import outside Electron: when `window.recut` is missing, thumbnails resolve to '' and
 * waveforms to null.
 */
import type { WaveformData } from '../../shared/ipc';

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

export class ThumbnailCache {
  private cache: LRU<string>;
  private inflight = new Map<string, Promise<string>>();
  private inflightStrips = new Map<string, Promise<string[]>>();

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
      .then((url) => { const u = url || ''; if (u) this.cache.set(key, u); return u; })
      .catch(() => '')
      .finally(() => { this.inflight.delete(key); });
    this.inflight.set(key, p);
    return p;
  }

  /** Batch request; results align with `times`. Falls back to per-thumbnail requests for cached entries. */
  async filmstrip(mediaPath: string, times: number[], width: number, mediaId?: string): Promise<string[]> {
    const out: string[] = new Array(times.length).fill('');
    const missing: number[] = [];
    times.forEach((t, i) => {
      const hit = this.cache.get(this.key(mediaPath, t, width));
      if (hit !== undefined) out[i] = hit; else missing.push(i);
    });
    if (!missing.length) return out;
    const recut = api();
    if (!recut) return out;
    const batchKey = `${mediaPath}|${width}|${missing.map((i) => Math.round(times[i] * 1000)).join(',')}`;
    let pending = this.inflightStrips.get(batchKey);
    if (!pending) {
      pending = recut.filmstrip({ path: mediaPath, times: missing.map((i) => times[i]), width, mediaId })
        .then((urls) => {
          urls.forEach((u, j) => { if (u) this.cache.set(this.key(mediaPath, times[missing[j]], width), u); });
          return urls;
        })
        .catch(() => [] as string[])
        .finally(() => { this.inflightStrips.delete(batchKey); });
      this.inflightStrips.set(batchKey, pending);
    }
    const urls = await pending;
    missing.forEach((i, j) => { out[i] = urls[j] ?? ''; });
    return out;
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
