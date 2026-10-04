import { useSyncExternalStore } from 'react';

/**
 * Transport registry: whichever monitor (Source or Program) was used last becomes the target of the
 * global playback shortcuts (Space, J/K/L, arrows, Home/End, I/O ...).
 */
export interface Transport {
  id: 'source' | 'program' | string;
  toggle(): void;
  play(): void;
  pause(): void;
  stop(): void;
  /** JKL shuttle rate; 0 = pause. */
  setRate(rate: number): void;
  getRate(): number;
  stepFrames(n: number): void;
  seekFrame(frame: number): void;
  currentFrame(): number;
  durationFrames(): number;
  goToStart(): void;
  goToEnd(): void;
  markIn(): void;
  markOut(): void;
  clearInOut(): void;
  goToIn(): void;
  goToOut(): void;
  /** Loop playback between in/out when set. */
  playInToOut?(): void;
  isPlaying(): boolean;
}

let active: Transport | null = null;
const transports = new Map<string, Transport>();
const listeners = new Set<(t: Transport | null) => void>();
/** Id of a monitor that just unregistered while active (see registerTransport). */
let pendingRestore: string | null = null;

export function registerTransport(t: Transport): () => void {
  transports.set(t.id, t);
  if (!active) setActiveTransport(t.id);
  else if (active.id === t.id && active !== t) { active = t; listeners.forEach((l) => l(active)); }
  else if (pendingRestore === t.id) setActiveTransport(t.id);
  return () => {
    if (transports.get(t.id) !== t) return; // already replaced by a newer registration of the same id
    transports.delete(t.id);
    if (active?.id === t.id) {
      setActiveTransport(transports.keys().next().value ?? null);
      // React re-runs effects as cleanup → setup: if the same monitor re-registers in this tick, it keeps the keys.
      pendingRestore = t.id;
      queueMicrotask(() => { if (pendingRestore === t.id) pendingRestore = null; });
    }
  };
}

export function setActiveTransport(id: string | null): void {
  pendingRestore = null;
  const next = id ? transports.get(id) ?? null : null;
  if (next === active) return;
  active = next;
  listeners.forEach((l) => l(active));
}

export function getActiveTransport(): Transport | null { return active; }
export function getTransport(id: string): Transport | undefined { return transports.get(id); }
export function onActiveTransportChange(cb: (t: Transport | null) => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function getActiveTransportId(): string | null { return active?.id ?? null; }

/** React hook: id of the monitor that currently owns the transport keys ('source' | 'program' | …). */
export function useActiveTransportId(): string | null {
  return useSyncExternalStore(onActiveTransportChange, getActiveTransportId, getActiveTransportId);
}

/** Standard JKL behaviour: repeated presses double the shuttle speed up to 8x. */
export function shuttle(t: Transport, direction: -1 | 1): void {
  const r = t.getRate();
  const sameDir = Math.sign(r) === direction && r !== 0;
  const next = sameDir ? Math.min(8, Math.abs(r) * 2) * direction : direction;
  t.setRate(next);
}
