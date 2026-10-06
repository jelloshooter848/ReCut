/**
 * Pool of media elements keyed by (path, role): <audio> for roles starting with 'audio' (sound only: no video decoder),
 * <video> otherwise.
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
  el: HTMLMediaElement;
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

/** Roles starting with 'audio' get an <audio> element: it plays the file's sound without decoding its pictures. */
export function isAudioRole(role: string): boolean { return role.startsWith('audio'); }

export class MediaElementPool {
  private entries = new Map<string, PooledElement>();
  private errors = new Map<string, MediaLoadError>();
  private counter = 0;
  private destroyed = false;
  private listeners = new Set<(err: MediaLoadError) => void>();
  private releaseListeners = new Set<(path: string) => void>();
  private disposeListeners = new Set<(el: HTMLMediaElement, path: string, role: string) => void>();
  private createdCount = 0;
  private disposedCount = 0;

  constructor(public capacity = 12) {}

  get size(): number { return this.entries.size; }

  /** Elements created / disposed over the pool's lifetime (dev overlays, leak tests). */
  get stats(): { created: number; disposed: number; live: number } {
    return { created: this.createdCount, disposed: this.disposedCount, live: this.entries.size };
  }

  /**
   * Get (or create) the element for `path` in `role` and mark it as most recently used.
   * Roles are free-form strings (e.g. `video:<clipId>`, `audio:<clipId>`, `warm`).
   */
  acquire(path: string, role: string): HTMLMediaElement {
    if (this.destroyed) throw new Error('MediaElementPool destroyed');
    const key = poolKey(path, role);
    let entry = this.entries.get(key);
    if (entry) {
      entry.lastUsed = ++this.counter;
      return entry.el;
    }
    // Most recently used from the start, and never its own eviction victim: with lastUsed 0 the new element was the
    // LRU entry of a full pool, so it was disposed before it was returned and recreated on every later acquire.
    entry = { key, path, role, el: this.createElement(path, role), lastUsed: ++this.counter, pins: 0 };
    this.entries.set(key, entry);
    this.evict(key);
    return entry.el;
  }

  /** `acquire` for a picture role (not 'audio…'): always an HTMLVideoElement. */
  acquireVideo(path: string, role: string): HTMLVideoElement {
    if (isAudioRole(role)) throw new Error(`acquireVideo: '${role}' is an audio role`);
    return this.acquire(path, role) as HTMLVideoElement;
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
    this.dispose(e);
  }

  /** Drop every element for a path (any role), e.g. when media is relinked or a proxy finishes. */
  releasePath(path: string): void {
    for (const e of [...this.entries.values()]) if (e.path === path) this.release(e.path, e.role);
    this.errors.delete(path);
    for (const cb of this.releaseListeners) { try { cb(path); } catch { /* ignore */ } }
  }

  /** Called after `releasePath` (relink / proxy ready), so paused players re-acquire and redraw. */
  onPathReleased(cb: (path: string) => void): () => void {
    this.releaseListeners.add(cb);
    return () => { this.releaseListeners.delete(cb); };
  }

  /**
   * Called just before the pool disposes an element (eviction, release, releasePath, destroy), so owners can drop
   * what they attached to it (a MediaElementAudioSourceNode can be created only once per element and lives as long
   * as the element: disconnect it here so neither stays reachable from the audio graph).
   */
  onDispose(cb: (el: HTMLMediaElement, path: string, role: string) => void): () => void {
    this.disposeListeners.add(cb);
    return () => { this.disposeListeners.delete(cb); };
  }

  /** Start buffering a file so the first seek is fast. Uses a dedicated 'warm' role. */
  warm(path: string): HTMLVideoElement {
    const el = this.acquireVideo(path, 'warm');
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
    for (const e of this.entries.values()) this.dispose(e);
    this.entries.clear();
    this.errors.clear();
    this.listeners.clear();
    this.releaseListeners.clear();
    this.disposeListeners.clear();
  }

  // ---------------------------------------------------------------

  private createElement(path: string, role: string): HTMLMediaElement {
    const audio = isAudioRole(role);
    const el: HTMLMediaElement = document.createElement(audio ? 'audio' : 'video');
    this.createdCount++;
    el.preload = 'auto';
    if (!audio) {
      (el as HTMLVideoElement).playsInline = true;
      el.setAttribute('playsinline', '');
      (el as HTMLVideoElement).disableRemotePlayback = true;
    }
    el.removeAttribute('crossorigin');
    el.muted = role.startsWith('video') || role === 'warm';
    el.defaultMuted = el.muted;
    el.loop = false;
    el.controls = false;
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

  private dispose(e: PooledElement): void {
    const el = e.el;
    this.disposedCount++;
    for (const cb of this.disposeListeners) { try { cb(el, e.path, e.role); } catch { /* ignore listener failures */ } }
    try { el.pause(); } catch { /* ignore */ }
    try {
      el.removeAttribute('src');
      el.load();
    } catch { /* ignore */ }
    if (el.parentNode) el.parentNode.removeChild(el);
  }

  /** Dispose least recently used, unpinned entries until the pool fits its capacity; `keep` is never evicted. */
  private evict(keep: string): void {
    while (this.entries.size > this.capacity) {
      let victim: PooledElement | null = null;
      for (const e of this.entries.values()) {
        if (e.pins > 0 || e.key === keep) continue;
        if (!victim || e.lastUsed < victim.lastUsed) victim = e;
      }
      if (!victim) return;
      this.entries.delete(victim.key);
      this.dispose(victim);
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
