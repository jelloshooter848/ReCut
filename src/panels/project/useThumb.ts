import { useEffect, useState } from 'react';
import { thumbs } from '@/app/media';

/** Small concurrency limiter so a fast scroll through thousands of rows does not flood the main process. */
class Limiter {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(private max: number) {}
  run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.active++;
        task().then(resolve, reject).finally(() => { this.active--; this.next(); });
      };
      if (this.active < this.max) start(); else this.queue.push(start);
    });
  }
  private next() { const n = this.queue.shift(); if (n) n(); }
}

export const thumbLimiter = new Limiter(3);
export const THUMB_WIDTH = 96;

/**
 * Lazily resolves a thumbnail URL for a mounted (= visible, thanks to windowing) row.
 * Returns the cached URL synchronously when available; otherwise requests it after a short settle delay,
 * through the shared limiter, and drops the request when the row unmounts before it starts.
 */
export function useThumb(path: string | undefined, time: number, enabled: boolean, mediaId?: string): string {
  const cached = path && enabled ? thumbs.peek(path, time, THUMB_WIDTH) : undefined;
  const [url, setUrl] = useState<string>(cached ?? '');
  useEffect(() => {
    if (!path || !enabled) { setUrl(''); return; }
    const hit = thumbs.peek(path, time, THUMB_WIDTH);
    if (hit !== undefined) { setUrl(hit); return; }
    let alive = true;
    const timer = window.setTimeout(() => {
      void thumbLimiter.run(() => (alive ? thumbs.get(path, time, THUMB_WIDTH, mediaId) : Promise.resolve('')))
        .then((u) => { if (alive && u) setUrl(u); });
    }, 60);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [path, time, enabled, mediaId]);
  return url;
}
