/**
 * Seek / frame math: frame-centered seeking and currentFrame() round-trips at NTSC rates, across an hour of material.
 * Pure math (shared/time.ts) exercised exactly the way SourcePlayer / SequencePlayer use it.
 */
import { describe, it, expect } from 'vitest';
import { frameCenterSeconds, secondsToFrames, secondsToFramesFloor, framesToSeconds, fpsValue, parseFps } from '@shared/time';
import type { Rational } from '@shared/model';
import { FPS_23976, FPS_2997, FPS_24, FPS_25 } from './helpers';

const NTSC: [string, Rational][] = [['23.976', FPS_23976], ['29.97', FPS_2997], ['59.94', { num: 60000, den: 1001 }], ['24', FPS_24], ['25', FPS_25]];

/** Chromium stores currentTime as a double of seconds but the pipeline rounds media time to microseconds (base::TimeDelta). */
function chromiumRoundTrip(t: number): number { return Math.round(t * 1e6) / 1e6; }

describe('frame-centered seek round trip (SourcePlayer.seekFrame -> currentFrame)', () => {
  for (const [label, fps] of NTSC) {
    it(`frame k -> frameCenterSeconds -> secondsToFramesFloor == k for k in {0,1,1000,86399,...} at ${label}`, () => {
      const frames = [0, 1, 2, 3, 999, 1000, 1001, 86399, 86400, 215783, 215784];
      for (const k of frames) {
        const t = frameCenterSeconds(k, fps);
        expect(secondsToFramesFloor(t, fps), `k=${k} t=${t}`).toBe(k);
        expect(secondsToFramesFloor(chromiumRoundTrip(t), fps), `k=${k} (µs-rounded) t=${chromiumRoundTrip(t)}`).toBe(k);
      }
    });
    it(`every frame of an hour round-trips at ${label} (exhaustive)`, () => {
      const n = Math.ceil(3600 * fpsValue(fps));
      let bad = 0; let badUs = 0;
      for (let k = 0; k < n; k++) {
        const t = frameCenterSeconds(k, fps);
        if (secondsToFramesFloor(t, fps) !== k) bad++;
        if (secondsToFramesFloor(chromiumRoundTrip(t), fps) !== k) badUs++;
      }
      console.log(`[seek ${label}] ${n} frames: round-trip failures=${bad}, after µs rounding=${badUs}`);
      expect(bad).toBe(0);
      expect(badUs).toBe(0);
    });
  }

  it('frame START times (markIn = framesToSeconds(currentFrame)) are stable under secondsToFrames at NTSC rates', () => {
    for (const [label, fps] of NTSC) {
      let bad = 0;
      const n = Math.ceil(3600 * fpsValue(fps));
      for (let k = 0; k < n; k++) if (secondsToFrames(framesToSeconds(k, fps), fps) !== k) bad++;
      console.log(`[seek ${label}] frame start round-trip failures=${bad}`);
      expect(bad).toBe(0);
    }
  });

  it('SequencePlayer.seek(): framesToSeconds(f) + 1e-6 floors back to f, and the +1e-6 never crosses into f+1 at 59.94', () => {
    for (const [label, fps] of NTSC) {
      let bad = 0;
      const n = Math.ceil(3600 * fpsValue(fps));
      for (let f = 0; f < n; f++) if (secondsToFramesFloor(framesToSeconds(f, fps) + 1e-6, fps) !== f) bad++;
      console.log(`[seek ${label}] SequencePlayer.seek round-trip failures=${bad}`);
      expect(bad).toBe(0);
    }
  });

  it('secondsToFramesFloor epsilon (1e-6 frames) does not swallow real sub-frame positions at 59.94 for hour-long times', () => {
    // At t = 3600 s the double spacing is ~4.5e-13 s, far below 1e-6 frames: fine. Document the margin instead.
    const fps = { num: 60000, den: 1001 };
    const k = 215783; // last frame of an hour
    const justBefore = framesToSeconds(k, fps) - 1e-7; // 0.1 µs before the frame boundary
    expect(secondsToFramesFloor(justBefore, fps)).toBe(k - 1);
  });

  it('parseFps snaps rounded labels to exact NTSC rationals', () => {
    expect(parseFps(23.976)).toEqual(FPS_23976);
    expect(parseFps(23.98)).toEqual(FPS_23976);
    expect(parseFps(29.97)).toEqual(FPS_2997);
    expect(parseFps(59.94)).toEqual({ num: 60000, den: 1001 });
    expect(parseFps(25)).toEqual(FPS_25);
  });
});
