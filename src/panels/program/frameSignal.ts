/**
 * Tiny external store for the frame-driven parts of the Program Monitor UI.
 *
 * The SequencePlayer emits a frame on every tick (up to display refresh rate). Pushing that through
 * React state would re-render the whole panel per frame, so the panel keeps the frame here and only
 * the small readouts (timecode fields, scrub playhead) subscribe via useSyncExternalStore.
 * While playing, emissions are throttled to `intervalMs`; seeks publish immediately.
 */
import { useSyncExternalStore } from 'react';

export interface FrameSignal {
  get(): number;
  /** Publish a frame. `immediate` bypasses the throttle (seeks/scrubs); otherwise at most one emit per interval. */
  set(frame: number, immediate?: boolean): void;
  subscribe(cb: () => void): () => void;
  dispose(): void;
}

export function createFrameSignal(intervalMs = 70): FrameSignal {
  let frame = 0;
  let published = 0;
  let lastEmit = 0;
  let timer: number | null = null;
  const listeners = new Set<() => void>();
  const emit = () => {
    if (timer !== null) { window.clearTimeout(timer); timer = null; }
    if (published === frame) return;
    published = frame;
    lastEmit = performance.now();
    listeners.forEach((l) => l());
  };
  return {
    get: () => published,
    set(f, immediate = false) {
      frame = f;
      if (immediate) { emit(); return; }
      const wait = intervalMs - (performance.now() - lastEmit);
      if (wait <= 0) emit();
      else if (timer === null) timer = window.setTimeout(emit, wait);
    },
    subscribe(cb) { listeners.add(cb); return () => { listeners.delete(cb); }; },
    dispose() { if (timer !== null) window.clearTimeout(timer); timer = null; listeners.clear(); },
  };
}

export function useFrame(signal: FrameSignal): number {
  return useSyncExternalStore(signal.subscribe, signal.get, signal.get);
}
