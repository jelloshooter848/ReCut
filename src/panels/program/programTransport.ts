/**
 * Transport implementation for the Program Monitor (src/app/transport.ts contract).
 *
 * Every seek goes through the player (clock) AND the store (sequence.view.playhead) so the two stay
 * in lock-step; the panel's store subscription treats the store playhead as the source of truth while
 * paused and the player's onFrame as the source while playing.
 */
import type { ID, Sequence } from '@shared/model';
import { sequenceDuration } from '@shared/timeline';
import { clamp } from '@shared/time';
import type { SequencePlayer } from '@/playback';
import { useStore } from '@/state/store';
import { activeSequence } from '@/state/selectors';
import type { Transport } from '@/app/transport';
import { resumeAudio } from '@/app/media';

export interface ProgramTransportDeps {
  player(): SequencePlayer | null;
  /** Turn the in→out loop on/off in the panel (used by playInToOut). */
  setLoop(on: boolean): void;
}

export function createProgramTransport(deps: ProgramTransportDeps): Transport {
  const seq = (): Sequence | null => activeSequence(useStore.getState());
  const seqId = (): ID | null => useStore.getState().project.activeSequenceId;

  const durationFrames = (): number => {
    const p = deps.player();
    if (p) return p.sequenceDurationFrames;
    const s = seq();
    return s ? sequenceDuration(s) : 0;
  };
  const currentFrame = (): number => {
    const p = deps.player();
    if (p) return p.currentFrame();
    return seq()?.view.playhead ?? 0;
  };
  const seekFrame = (frame: number): void => {
    const id = seqId();
    const f = clamp(Math.round(frame), 0, Math.max(0, durationFrames()));
    deps.player()?.seek(f);
    if (id) useStore.getState().setView(id, { playhead: f });
  };
  const play = (): void => {
    void resumeAudio();
    deps.player()?.play();
  };
  const pause = (): void => { deps.player()?.pause(); };
  const isPlaying = (): boolean => deps.player()?.isPlaying ?? false;

  return {
    id: 'program',
    toggle() { if (isPlaying()) pause(); else play(); },
    play,
    pause,
    stop() {
      const p = deps.player();
      if (p) { p.stop(); const id = seqId(); if (id) useStore.getState().setView(id, { playhead: p.currentFrame() }); }
      else seekFrame(0);
    },
    setRate(rate) {
      const p = deps.player();
      if (!p) return;
      if (rate === 0) { p.setRate(0); return; }
      void resumeAudio();
      p.setRate(rate);
    },
    getRate() { const p = deps.player(); return p ? (p.isPlaying ? p.playbackRate : 0) : 0; },
    stepFrames(n) { if (isPlaying()) pause(); seekFrame(currentFrame() + n); },
    seekFrame,
    currentFrame,
    durationFrames,
    goToStart() { seekFrame(0); },
    goToEnd() { seekFrame(durationFrames()); },
    markIn() { const id = seqId(); if (id) useStore.getState().setView(id, { inPoint: currentFrame() }); },
    markOut() { const id = seqId(); if (id) useStore.getState().setView(id, { outPoint: currentFrame() }); },
    clearInOut() { const id = seqId(); if (id) useStore.getState().setView(id, { inPoint: null, outPoint: null }); },
    goToIn() { const s = seq(); if (s && s.view.inPoint !== null) seekFrame(s.view.inPoint); },
    goToOut() { const s = seq(); if (s && s.view.outPoint !== null) seekFrame(s.view.outPoint); },
    playInToOut() {
      const s = seq();
      if (!s || s.view.inPoint === null || s.view.outPoint === null || s.view.outPoint <= s.view.inPoint) { play(); return; }
      deps.setLoop(true);
      deps.player()?.setLoopRange(s.view.inPoint, s.view.outPoint);
      seekFrame(s.view.inPoint);
      play();
    },
    isPlaying,
  };
}
