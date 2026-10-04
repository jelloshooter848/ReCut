/**
 * Master playback clock driven by performance.now().
 *
 * Position is expressed in seconds of timeline time. The rate may be any number in -8..8
 * (JKL: 1, 2, 4, 8, -1, -2, -4, -8) or 0 (paused but "running"). Changing the rate or seeking
 * while running preserves continuity: the position at the moment of the change is captured and
 * extrapolation resumes from there.
 */
export const MAX_RATE = 8;

function monotonicNow(): number {
  return performance.now() / 1000;
}

export class PlaybackClock {
  private running = false;
  private rate_ = 1;
  /** Position (seconds) at `anchorWall`. */
  private anchorPos = 0;
  private anchorWall = 0;

  get rate(): number { return this.rate_; }
  get isRunning(): boolean { return this.running; }

  /** Start advancing from `atSeconds` (defaults to the current position). */
  start(atSeconds?: number): void {
    const pos = atSeconds ?? this.now();
    this.anchorPos = pos;
    this.anchorWall = monotonicNow();
    this.running = true;
  }

  /** Stop advancing; the position is frozen where it was. */
  stop(): void {
    if (!this.running) return;
    this.anchorPos = this.now();
    this.anchorWall = monotonicNow();
    this.running = false;
  }

  /** Current position in seconds. */
  now(): number {
    if (!this.running) return this.anchorPos;
    return this.anchorPos + (monotonicNow() - this.anchorWall) * this.rate_;
  }

  /** Change the playback rate without discontinuity. Values are clamped to -MAX_RATE..MAX_RATE. */
  setRate(rate: number): void {
    const r = Number.isFinite(rate) ? Math.max(-MAX_RATE, Math.min(MAX_RATE, rate)) : 1;
    this.anchorPos = this.now();
    this.anchorWall = monotonicNow();
    this.rate_ = r;
  }

  /** Jump to an absolute position (seconds), keeping the running state. */
  seek(seconds: number): void {
    this.anchorPos = seconds;
    this.anchorWall = monotonicNow();
  }
}
