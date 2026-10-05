/**
 * Regression tests for critic findings F5–F8 (shared/time.ts): formatClock millisecond rounding, SMPTE
 * drop-frame timecode at 29.97 / 59.94, negative timecode round trip, sign-symmetric secondsToFrames and
 * parseFps for every x/1001 rate.
 */
import { describe, it, expect } from 'vitest';
import { formatClock, formatTimecode, parseTimecode, secondsToFrames, framesToSeconds, parseFps, FPS_PRESETS } from '../../shared/time';
import type { Rational } from '../../shared/model';

const F24: Rational = { num: 24, den: 1 };
const F2997: Rational = { num: 30000, den: 1001 };
const F5994: Rational = { num: 60000, den: 1001 };
const DF = { dropIndicator: true };

// ---------------------------------------------------------------------------------------------------
// F5: formatClock derives every field from one rounded millisecond count.
// ---------------------------------------------------------------------------------------------------
describe('F5 formatClock rounds to whole milliseconds', () => {
  it('does not truncate float error', () => {
    expect(formatClock(2.3, true)).toBe('00:02.300');
    expect(formatClock(1.001, true)).toBe('00:01.001');
    expect(formatClock(4.35, true)).toBe('00:04.350');
    expect(formatClock(0.007, true)).toBe('00:00.007');
    expect(formatClock(3600.001, true)).toBe('1:00:00.001');
  });

  it('carries a rounded-up millisecond into the seconds / minutes / hours fields', () => {
    expect(formatClock(59.9996, true)).toBe('01:00.000');
    expect(formatClock(3599.9999, true)).toBe('1:00:00.000');
    expect(formatClock(59.999, true)).toBe('00:59.999');
  });

  it('without ms keeps whole seconds (truncated) and the existing shapes', () => {
    expect(formatClock(3661.25)).toBe('1:01:01');
    expect(formatClock(61.9)).toBe('01:01');
    expect(formatClock(-5)).toBe('-00:05');
    expect(formatClock(-2.3, true)).toBe('-00:02.300');
  });

  it('never prints a negative zero', () => {
    expect(formatClock(-0.0001, true)).toBe('00:00.000');
    expect(formatClock(-0, true)).toBe('00:00.000');
  });
});

// ---------------------------------------------------------------------------------------------------
// F6: ';' means SMPTE drop-frame at 29.97 / 59.94.
// ---------------------------------------------------------------------------------------------------
describe('F6 drop-frame timecode (29.97 / 59.94 with the ; indicator)', () => {
  it('formats SMPTE reference values at 29.97 DF', () => {
    expect(formatTimecode(0, F2997, DF)).toBe('00:00:00;00');
    expect(formatTimecode(1799, F2997, DF)).toBe('00:00:59;29');
    expect(formatTimecode(1800, F2997, DF)).toBe('00:01:00;02');
    expect(formatTimecode(3597, F2997, DF)).toBe('00:01:59;29');
    expect(formatTimecode(3598, F2997, DF)).toBe('00:02:00;02');
    expect(formatTimecode(17981, F2997, DF)).toBe('00:09:59;29');
    expect(formatTimecode(17982, F2997, DF)).toBe('00:10:00;00');
    expect(formatTimecode(17983, F2997, DF)).toBe('00:10:00;01');
    expect(formatTimecode(19782, F2997, DF)).toBe('00:11:00;02');
    expect(formatTimecode(107892, F2997, DF)).toBe('01:00:00;00');
    expect(formatTimecode(secondsToFrames(3600, F2997), F2997, DF)).toBe('01:00:00;00'); // 1 h real time
    expect(formatTimecode(24 * 107892, F2997, DF)).toBe('24:00:00;00');
  });

  it('formats SMPTE reference values at 59.94 DF (drops 4 frame numbers)', () => {
    expect(formatTimecode(3599, F5994, DF)).toBe('00:00:59;59');
    expect(formatTimecode(3600, F5994, DF)).toBe('00:01:00;04');
    expect(formatTimecode(35964, F5994, DF)).toBe('00:10:00;00');
    expect(formatTimecode(215784, F5994, DF)).toBe('01:00:00;00');
    expect(formatTimecode(secondsToFrames(3600, F5994), F5994, DF)).toBe('01:00:00;00');
  });

  it('without the indicator (or at other rates) stays non-drop with ":"', () => {
    expect(formatTimecode(1800, F2997)).toBe('00:01:00:00');
    expect(formatTimecode(107892, F2997)).toBe('00:59:56:12');
    expect(formatTimecode(1800, F24, DF)).toBe('00:01:15:00');
    expect(formatTimecode(1800, { num: 24000, den: 1001 }, DF)).toBe('00:01:15:00');
  });

  it('parses ";" input at 29.97 / 59.94 as drop-frame', () => {
    expect(parseTimecode('00:01:00;02', F2997)).toBe(1800);
    expect(parseTimecode('00:10:00;00', F2997)).toBe(17982);
    expect(parseTimecode('01:00:00;00', F2997)).toBe(107892);
    expect(parseTimecode('01;00;00;00', F2997)).toBe(107892);
    expect(parseTimecode('00:01:00;04', F5994)).toBe(3600);
    expect(parseTimecode('01:00:00;00', F5994)).toBe(215784);
    // first minute is identical in DF and NDF
    expect(parseTimecode('00:00:01;00', F2997)).toBe(30);
    expect(parseTimecode('1;00', F2997)).toBe(30);
  });

  it('":"-only input stays non-drop at 29.97 / 59.94; ";" at other rates is just a separator', () => {
    expect(parseTimecode('01:00:00:00', F2997)).toBe(108000);
    expect(parseTimecode('00:01:00:02', F2997)).toBe(1802);
    expect(parseTimecode('00:01:00;00', F24)).toBe(1440);
  });

  it('rejects labels that do not exist in drop-frame (dropped frame numbers)', () => {
    for (const bad of ['00:01:00;00', '00:01:00;01', '00:02:00;00', '01:01:00;01', '00:00:59;30']) expect(parseTimecode(bad, F2997), bad).toBeNull();
    for (const bad of ['00:01:00;00', '00:01:00;03', '00:09:00;02']) expect(parseTimecode(bad, F5994), bad).toBeNull();
    // every 10th minute keeps its 00 / 01
    expect(parseTimecode('00:10:00;00', F2997)).toBe(17982);
    expect(parseTimecode('00:10:00;01', F2997)).toBe(17983);
    expect(parseTimecode('00:00:00;00', F2997)).toBe(0);
  });

  it('round-trips every frame 0..30 h at 29.97 and 59.94, DF and NDF', () => {
    for (const fps of [F2997, F5994]) {
      const end = Math.ceil(30 * 3600 * (fps.num / fps.den));
      for (const opts of [DF, {}]) {
        let bad: unknown = null;
        let prev = '';
        for (let f = 0; f <= end; f++) {
          const s = formatTimecode(f, fps, opts);
          if (parseTimecode(s, fps) !== f || s <= prev) { bad = { fps, opts, f, s, prev }; break; }
          prev = s; // labels are strictly increasing (no duplicate / skipped-back label)
        }
        expect(bad).toBeNull();
      }
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------------
// F7: negative timecodes round trip; secondsToFrames is sign-symmetric and never returns -0.
// ---------------------------------------------------------------------------------------------------
describe('F7 negative timecode / secondsToFrames symmetry', () => {
  it('a negative full timecode from formatTimecode parses back', () => {
    expect(formatTimecode(-30, F24)).toBe('-00:00:01:06');
    expect(parseTimecode(formatTimecode(-30, F24), F24)).toBe(-30);
    expect(parseTimecode('-01:00:00:00', F24, 500)).toBe(-86400); // absolute, not relative to `current`
    expect(parseTimecode(formatTimecode(-1800, F2997, DF), F2997)).toBe(-1800);
    for (let f = -5000; f <= 5000; f += 7) {
      for (const fps of [F24, F2997, F5994]) for (const opts of [DF, {}]) expect(parseTimecode(formatTimecode(f, fps, opts), fps)).toBe(f);
    }
  });

  it('"-0" is plain zero; shorter signed forms stay rejected (ambiguous with relative entry)', () => {
    expect(Object.is(parseTimecode('-00:00:00:00', F24), 0)).toBe(true);
    for (const bad of ['-1:00', '-1:00:00', '-00:01;00', '+1:00', '+00:00:01:00', '--00:00:01:00', '- 00:00:01:00']) expect(parseTimecode(bad, F24), bad).toBeNull();
    expect(parseTimecode('-5', F24, 100)).toBe(95); // relative entry unchanged
  });

  it('secondsToFrames rounds half away from zero symmetrically and normalizes -0', () => {
    expect(secondsToFrames(2.5 / 24, F24)).toBe(3);
    expect(secondsToFrames(-2.5 / 24, F24)).toBe(-3);
    expect(Object.is(secondsToFrames(-0.4 / 24, F24), 0)).toBe(true);
    expect(Object.is(secondsToFrames(-0, F24), 0)).toBe(true);
    for (let i = -2000; i <= 2000; i++) {
      const s = i / 97;
      expect(secondsToFrames(-s, F2997)).toBe(-secondsToFrames(s, F2997) || 0);
    }
  });

  it('positive behaviour is unchanged and negatives round trip', () => {
    expect(secondsToFrames(0.9999999, F24)).toBe(24);
    expect(secondsToFrames(1.02, F24)).toBe(24);
    expect(secondsToFrames(1.03, F24)).toBe(25);
    for (const fps of [F24, F2997, F5994, { num: 24000, den: 1001 }]) {
      for (let f = -100000; f <= 100000; f += 37) expect(secondsToFrames(framesToSeconds(f, fps), fps)).toBe(f);
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// F8: parseFps recognises every x/1001 NTSC rate.
// ---------------------------------------------------------------------------------------------------
describe('F8 parseFps x/1001 rates', () => {
  it('snaps decimal NTSC rates (and their rounded labels) to n*1000/1001', () => {
    const cases: [number, Rational][] = [
      [23.976, { num: 24000, den: 1001 }], [29.97, { num: 30000, den: 1001 }], [47.952, { num: 48000, den: 1001 }],
      [47.95, { num: 48000, den: 1001 }], [59.94, { num: 60000, den: 1001 }], [119.88, { num: 120000, den: 1001 }],
      [119.880119880, { num: 120000, den: 1001 }], [14.985, { num: 15000, den: 1001 }], [239.76, { num: 240000, den: 1001 }],
    ];
    for (const [v, r] of cases) expect(parseFps(v), String(v)).toEqual(r);
  });

  it('leaves integers and other decimals alone', () => {
    expect(parseFps(120)).toEqual({ num: 120, den: 1 });
    expect(parseFps(23.9)).toEqual({ num: 23900, den: 1000 });
    expect(parseFps(12.5)).toEqual({ num: 12500, den: 1000 });
    expect(parseFps(119.5)).toEqual({ num: 119500, den: 1000 });
    expect(parseFps(0.999)).toBeNull(); // 1000/1001 would be below MIN_FPS
    for (const p of FPS_PRESETS) expect(parseFps(p.fps.num / p.fps.den)).toEqual(p.fps);
  });
});
