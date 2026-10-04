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

export function registerTransport(t: Transport): () => void {
  transports.set(t.id, t);
  if (!active) setActiveTransport(t.id);
  return () => {
    transports.delete(t.id);
    if (active?.id === t.id) setActiveTransport(transports.keys().next().value ?? null);
  };
}

export function setActiveTransport(id: string | null): void {
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

/** Standard JKL behaviour: repeated presses double the shuttle speed up to 8x. */
export function shuttle(t: Transport, direction: -1 | 1): void {
  const r = t.getRate();
  const sameDir = Math.sign(r) === direction && r !== 0;
  const next = sameDir ? Math.min(8, Math.abs(r) * 2) * direction : direction;
  t.setRate(next);
}
