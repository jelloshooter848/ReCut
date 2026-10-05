/**
 * Drives two SequencePlayers (Compare mode) from a single PlaybackClock.
 *
 * Both players read time from the shared clock, so play/pause/seek/rate on the group keep them in
 * lock-step; `setOffset(frames)` shifts the second player relative to the first.
 */
import { PlaybackClock } from './clock';
import type { SequencePlayer } from './sequencePlayer';

export class SyncGroup {
  readonly clock: PlaybackClock;
  private offset = 0;

  constructor(public readonly primary: SequencePlayer, public readonly secondary: SequencePlayer, clock?: PlaybackClock) {
    this.clock = clock ?? new PlaybackClock();
    const pos = primary.currentFrame();
    primary.useClock(this.clock);
    secondary.useClock(this.clock);
    secondary.setFrameOffset(this.offset);
    primary.seek(pos);
  }

  get isPlaying(): boolean { return this.primary.isPlaying || this.secondary.isPlaying; }

  /** Frame offset applied to the secondary player (secondary frame = primary frame + offset). */
  setOffset(frames: number): void {
    this.offset = Math.round(frames);
    this.secondary.setFrameOffset(this.offset);
  }
  getOffset(): number { return this.offset; }

  play(): void {
    this.primary.play();
    this.secondary.play();
  }

  pause(): void {
    this.primary.pause();
    this.secondary.pause();
  }

  toggle(): void { this.isPlaying ? this.pause() : this.play(); }

  stop(): void {
    this.pause();
    this.seek(0);
  }

  /** Seek in primary frames; the secondary follows through the shared clock + offset. */
  seek(frame: number): void {
    this.primary.seek(frame);
    this.secondary.seek(frame + this.offset);
  }

  setRate(rate: number): void {
    this.primary.setRate(rate);
    this.secondary.setRate(rate);
  }

  currentFrame(): number { return this.primary.currentFrame(); }

  /** Detach the players from the shared clock (each gets its own clock at the current position). */
  release(): void {
    const pos = this.clock.now();
    this.pause();
    for (const p of [this.primary, this.secondary]) {
      const c = new PlaybackClock();
      c.seek(pos);
      p.useClock(c);
    }
    this.secondary.setFrameOffset(0);
  }
}
