/**
 * Pool of HTMLVideoElements keyed by (path, role).
 *
 * Decoding is expensive, so the sequence player reuses elements across frames and the pool
 * evicts the least recently used element when more than `capacity` exist. A per-path error
 * registry lets the UI offer "generate proxy" when Chromium cannot decode a file.
 */
import { pathToMediaUrl } from '../../shared/ipc';

export interface PooledElement {
  key: string;
  path: string;
  role: string;
  el: HTMLVideoElement;
  lastUsed: number;
  /** Incremented by `retain`, decremented by `release`; retained entries are never evicted. */
  pins: number;
}

export interface MediaLoadError {
  path: string;
  code: number | null;
  message: string;
  at: number;
}

export function poolKey(path: string, role: string): string { return `${role}\u0000${path}`; }

export class MediaElementPool {
  private entries = new Map<string, PooledElement>();
  private errors = new Map<string, MediaLoadError>();
  private counter = 0;
  private destroyed = false;
  private listeners = new Set<(err: MediaLoadError) => void>();

  constructor(public capacity = 12) {}

  get size(): number { return this.entries.size; }

  /**
   * Get (or create) the element for `path` in `role` and mark it as most recently used.
   * Roles are free-form strings (e.g. `video:<clipId>`, `audio:<clipId>`, `warm`).
   */
  acquire(path: string, role: string): HTMLVideoElement {
    if (this.destroyed) throw new Error('MediaElementPool destroyed');
    const key = poolKey(path, role);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { key, path, role, el: this.createElement(path, role), lastUsed: 0, pins: 0 };
      this.entries.set(key, entry);
      this.evict();
    }
    entry.lastUsed = ++this.counter;
    return entry.el;
  }

  /** Whether an element already exists for this (path, role). */
  has(path: string, role: string): boolean { return this.entries.has(poolKey(path, role)); }

  /** Mark as recently used without creating. */
  touch(path: string, role: string): void {
    const e = this.entries.get(poolKey(path, role));
    if (e) e.lastUsed = ++this.counter;
  }

  /** Pin an element so LRU eviction skips it (balance with `unpin`). */
  pin(path: string, role: string): void {
    const e = this.entries.get(poolKey(path, role));
    if (e) e.pins++;
  }
  unpin(path: string, role: string): void {
    const e = this.entries.get(poolKey(path, role));
    if (e && e.pins > 0) e.pins--;
  }

  /** Drop the element for (path, role), pausing it and releasing its decoder. */
  release(path: string, role: string): void {
    const key = poolKey(path, role);
    const e = this.entries.get(key);
    if (!e) return;
    this.entries.delete(key);
    this.dispose(e.el);
  }

  /** Drop every element for a path (any role), e.g. when media is relinked or a proxy finishes. */
  releasePath(path: string): void {
    for (const e of [...this.entries.values()]) if (e.path === path) this.release(e.path, e.role);
    this.errors.delete(path);
  }

  /** Start buffering a file so the first seek is fast. Uses a dedicated 'warm' role. */
  warm(path: string): HTMLVideoElement {
    const el = this.acquire(path, 'warm');
    try { el.load(); } catch { /* ignore */ }
    return el;
  }

  /** HTMLMediaElement.readyState (0..4) for an element, or -1 when not pooled. */
  readyState(path: string, role: string): number {
    return this.entries.get(poolKey(path, role))?.el.readyState ?? -1;
  }

  /** Most recent load/decode error for a path, if any. */
  getError(path: string): MediaLoadError | undefined { return this.errors.get(path); }
  clearError(path: string): void { this.errors.delete(path); }
  /** Subscribe to new load errors (for toasts / "generate proxy" prompts). */
  onError(cb: (err: MediaLoadError) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  /** Snapshot for debugging / dev overlays. */
  entriesSnapshot(): PooledElement[] { return [...this.entries.values()]; }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const e of this.entries.values()) this.dispose(e.el);
    this.entries.clear();
    this.errors.clear();
    this.listeners.clear();
  }

  // ---------------------------------------------------------------

  private createElement(path: string, role: string): HTMLVideoElement {
    const el = document.createElement('video');
    el.preload = 'auto';
    el.playsInline = true;
    el.setAttribute('playsinline', '');
    el.removeAttribute('crossorigin');
    el.muted = role.startsWith('video') || role === 'warm';
    el.defaultMuted = el.muted;
    el.loop = false;
    el.controls = false;
    el.disableRemotePlayback = true;
    el.addEventListener('error', () => {
      const me = el.error;
      const err: MediaLoadError = {
        path,
        code: me ? me.code : null,
        message: me?.message || describeMediaError(me?.code ?? null),
        at: Date.now(),
      };
      this.errors.set(path, err);
      for (const cb of this.listeners) {
        try { cb(err); } catch { /* ignore listener failures */ }
      }
    });
    el.src = pathToMediaUrl(path);
    return el;
  }

  private dispose(el: HTMLVideoElement): void {
    try { el.pause(); } catch { /* ignore */ }
    try {
      el.removeAttribute('src');
      el.load();
    } catch { /* ignore */ }
    if (el.parentNode) el.parentNode.removeChild(el);
  }

  private evict(): void {
    while (this.entries.size > this.capacity) {
      let victim: PooledElement | null = null;
      for (const e of this.entries.values()) {
        if (e.pins > 0) continue;
        if (!victim || e.lastUsed < victim.lastUsed) victim = e;
      }
      if (!victim) return;
      this.entries.delete(victim.key);
      this.dispose(victim.el);
    }
  }
}

export function describeMediaError(code: number | null): string {
  switch (code) {
    case 1: return 'loading aborted';
    case 2: return 'network error while loading media';
    case 3: return 'decode error (codec not supported by the browser)';
    case 4: return 'media source not supported';
    default: return 'unknown media error';
  }
}

/** Resolve when an element can render the frame at its current time (readyState >= HAVE_CURRENT_DATA). */
export function whenReady(el: HTMLMediaElement, timeoutMs = 5000): Promise<boolean> {
  if (el.readyState >= 2) return Promise.resolve(true);
  if (el.error) return Promise.resolve(false);
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      el.removeEventListener('loadeddata', onData);
      el.removeEventListener('canplay', onData);
      el.removeEventListener('error', onErr);
      clearTimeout(timer);
      resolve(ok);
    };
    const onData = () => finish(true);
    const onErr = () => finish(false);
    el.addEventListener('loadeddata', onData);
    el.addEventListener('canplay', onData);
    el.addEventListener('error', onErr);
    const timer = setTimeout(() => finish(el.readyState >= 2), timeoutMs);
  });
}
