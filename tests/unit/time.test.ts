import { describe, it, expect } from 'vitest';
import {
  framesToSeconds, secondsToFrames, secondsToFramesFloor, frameCenterSeconds, formatTimecode, formatSecondsTimecode,
  formatClock, parseTimecode, parseFps, fpsLabel, fpsEquals, fpsValue, clamp, FPS_PRESETS, isValidFps,
} from '../../shared/time';
import type { Rational } from '../../shared/model';

const F24: Rational = { num: 24, den: 1 };
const F23976: Rational = { num: 24000, den: 1001 };
const F2997: Rational = { num: 30000, den: 1001 };
const F5994: Rational = { num: 60000, den: 1001 };

describe('frames <-> seconds', () => {
  it('framesToSeconds is exact for integer rates', () => {
    expect(framesToSeconds(24, F24)).toBe(1);
    expect(framesToSeconds(36, F24)).toBe(1.5);
    expect(framesToSeconds(0, F23976)).toBe(0);
  });

  it('secondsToFrames rounds to the nearest frame and tolerates 23.9999-style float noise', () => {
    expect(secondsToFrames(1, F24)).toBe(24);
    expect(secondsToFrames(0.9999999, F24)).toBe(24);
    expect(secondsToFrames(1.02, F24)).toBe(24);   // 24.48 -> 24
    expect(secondsToFrames(1.03, F24)).toBe(25);   // 24.72 -> 25
    expect(secondsToFramesFloor(1.03, F24)).toBe(24);
    expect(secondsToFramesFloor(0.99999999999, F24)).toBe(24); // float noise is absorbed
    expect(secondsToFramesFloor(0.9999, F24)).toBe(23);         // a real fraction of a frame is not
  });

  it('roundtrips every frame of a 2h span at 23.976 without drift (sampled)', () => {
    const total = 2 * 3600 * 24; // 172800 nominal frames
    for (let f = 0; f <= total; f += 997) expect(secondsToFrames(framesToSeconds(f, F23976), F23976)).toBe(f);
    expect(secondsToFrames(framesToSeconds(total, F23976), F23976)).toBe(total);
    // 2h of 23.976 is a hair over 2h of wall-clock seconds
    expect(framesToSeconds(total, F23976)).toBeCloseTo(7207.2, 6);
  });

  it('roundtrips large frame numbers at 29.97 and 59.94', () => {
    const total2997 = 2 * 3600 * 30; // 216000
    for (let f = 0; f <= total2997; f += 1013) expect(secondsToFrames(framesToSeconds(f, F2997), F2997)).toBe(f);
    expect(secondsToFrames(framesToSeconds(total2997, F2997), F2997)).toBe(total2997);
    const total5994 = 2 * 3600 * 60;
    expect(secondsToFrames(framesToSeconds(total5994, F5994), F5994)).toBe(total5994);
    expect(secondsToFrames(framesToSeconds(total5994 - 1, F5994), F5994)).toBe(total5994 - 1);
  });

  it('frameCenterSeconds lands half a frame in', () => {
    expect(frameCenterSeconds(0, F24)).toBeCloseTo(0.5 / 24, 12);
    expect(frameCenterSeconds(24, F24)).toBeCloseTo(1 + 0.5 / 24, 12);
    expect(frameCenterSeconds(1, F23976)).toBeCloseTo(1.5 * 1001 / 24000, 12);
    // the centre of a frame maps back to that same frame when floored
    for (let f = 0; f < 200; f++) expect(secondsToFramesFloor(frameCenterSeconds(f, F23976), F23976)).toBe(f);
  });
});

describe('formatTimecode', () => {
  it('formats zero and whole hours', () => {
    expect(formatTimecode(0, F24)).toBe('00:00:00:00');
    expect(formatTimecode(86400, F24)).toBe('01:00:00:00');
    expect(formatTimecode(86400 + 24 * 61 + 5, F24)).toBe('01:01:01:05');
  });

  it('uses the nominal 24 for 23.976 (frame count based, non-drop)', () => {
    expect(formatTimecode(86400, F23976)).toBe('01:00:00:00');
    expect(formatTimecode(23, F23976)).toBe('00:00:00:23');
    expect(formatTimecode(24, F23976)).toBe('00:00:01:00');
  });

  it('handles negatives and rounding of fractional frames', () => {
    expect(formatTimecode(-25, F24)).toBe('-00:00:01:01');
    expect(formatTimecode(23.6, F24)).toBe('00:00:01:00');
  });

  it('uses ; separator only for 29.97/59.94 when dropIndicator is requested', () => {
    expect(formatTimecode(30, F2997, { dropIndicator: true })).toBe('00:00:01;00');
    expect(formatTimecode(60, F5994, { dropIndicator: true })).toBe('00:00:01;00');
    expect(formatTimecode(24, F23976, { dropIndicator: true })).toBe('00:00:01:00');
    expect(formatTimecode(30, F2997)).toBe('00:00:01:00');
  });

  it('formatSecondsTimecode and formatClock', () => {
    expect(formatSecondsTimecode(1.5, F24)).toBe('00:00:01:12');
    expect(formatClock(3661.25)).toBe('1:01:01');
    expect(formatClock(61.25, true)).toBe('01:01.250');
    expect(formatClock(-5)).toBe('-00:05');
  });
});

describe('parseTimecode', () => {
  it('relative offsets', () => {
    expect(parseTimecode('+10', F24, 100)).toBe(110);
    expect(parseTimecode('-5', F24, 100)).toBe(95);
    expect(parseTimecode('  +3 ', F24)).toBe(3);
  });

  it('fills fields right to left (FF, SS:FF, MM:SS:FF, HH:MM:SS:FF)', () => {
    expect(parseTimecode('12', F24)).toBe(12);
    expect(parseTimecode('1:00', F24)).toBe(24);
    expect(parseTimecode('1:12', F24)).toBe(36);
    expect(parseTimecode('00:01:00:12', F24)).toBe(1452);
    expect(parseTimecode('01:00:00:00', F24)).toBe(86400);
    expect(parseTimecode('01:00:00:00', F23976)).toBe(86400);
    expect(parseTimecode('1:00:00', F24)).toBe(1440);
  });

  it('accepts ; and . as separators', () => {
    expect(parseTimecode('00:00:01;00', F2997)).toBe(30);
    expect(parseTimecode('1.12', F24)).toBe(36);
  });

  it('rejects bad input', () => {
    expect(parseTimecode('', F24)).toBeNull();
    expect(parseTimecode('   ', F24)).toBeNull();
    expect(parseTimecode('abc', F24)).toBeNull();
    expect(parseTimecode('1:xx', F24)).toBeNull();
    expect(parseTimecode('+', F24)).toBeNull();
  });
});

describe('fps helpers', () => {
  it('parseFps snaps to presets and falls back to rationals', () => {
    expect(parseFps(23.976)).toEqual({ num: 24000, den: 1001 });
    expect(parseFps(23.98)).toEqual({ num: 24000, den: 1001 });
    expect(parseFps(23.976023976)).toEqual({ num: 24000, den: 1001 });
    expect(parseFps(23.9)).toEqual({ num: 23900, den: 1000 });
    expect(parseFps(29.97)).toEqual({ num: 30000, den: 1001 });
    expect(parseFps(59.94)).toEqual({ num: 60000, den: 1001 });
    expect(parseFps(24)).toEqual({ num: 24, den: 1 });
    expect(parseFps(25)).toEqual({ num: 25, den: 1 });
    expect(parseFps(48)).toEqual({ num: 48, den: 1 });
    expect(parseFps(12.5)).toEqual({ num: 12500, den: 1000 });
  });

  it('fpsLabel', () => {
    expect(fpsLabel(F23976)).toBe('23.976');
    expect(fpsLabel(F2997)).toBe('29.97');
    expect(fpsLabel(F5994)).toBe('59.94');
    expect(fpsLabel(F24)).toBe('24');
    expect(fpsLabel({ num: 50, den: 1 })).toBe('50');
    for (const p of FPS_PRESETS) expect(fpsLabel(p.fps)).toBe(p.label);
  });

  it('fpsEquals / fpsValue / clamp', () => {
    expect(fpsEquals({ num: 24000, den: 1001 }, { num: 48000, den: 2002 })).toBe(true);
    expect(fpsEquals(F24, F23976)).toBe(false);
    expect(fpsValue(F24)).toBe(24);
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
    expect(clamp(2, 0, 3)).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------------
// BUG 5: parseTimecode must reject partial-digit components and over-long timecodes instead of guessing.
// ---------------------------------------------------------------------------------------------------
describe('parseTimecode strictness (BUG 5)', () => {
  it('rejects components that are not entirely ASCII digits', () => {
    for (const bad of ['12abc', 'abc12', '10foo:20', '1:2x', '1e3', '0x10', '1_000', '1,5', '１２', '٣', '1:٣', '²', '12 34', '1: 2', '+1:00', '++5', '+-5', '- 5', '+ 5', '5-', '-', '1.5e2', 'Infinity', 'NaN']) {
      expect(parseTimecode(bad, F24), JSON.stringify(bad)).toBeNull();
    }
  });

  it('rejects empty components and more than four components', () => {
    for (const bad of ['1::2', ':12', '12:', ':', '1:2:3:4:5', '1.5.5.5.5', '00:00:00:00:00', '1;2;3;4;5', '1:2:3:4:5:6']) {
      expect(parseTimecode(bad, F24), JSON.stringify(bad)).toBeNull();
    }
  });

  it('rejects values that are not representable as a safe integer frame count', () => {
    expect(parseTimecode('99999999999999999999', F24)).toBeNull();
    expect(parseTimecode('+99999999999999999999', F24)).toBeNull();
    expect(parseTimecode('99999999999999:00:00:00', F24)).toBeNull();
  });

  it('keeps the supported shorthand: FF, SS:FF, MM:SS:FF, HH:MM:SS:FF with : ; . separators', () => {
    expect(parseTimecode('0', F24)).toBe(0);
    expect(parseTimecode('12', F24)).toBe(12);
    expect(parseTimecode('1.5', F24)).toBe(29);          // SS.FF
    expect(parseTimecode('1;05', F24)).toBe(29);
    expect(parseTimecode('2:01:05', F24)).toBe(2 * 60 * 24 + 24 + 5);
    expect(parseTimecode('01.00.00.00', F24)).toBe(86400);
    expect(parseTimecode('1:2.3;4', F24)).toBe((3600 + 120 + 3) * 24 + 4);
    expect(parseTimecode('00:00:01:30', F24)).toBe(54);   // frame overflow carries, as before
    expect(parseTimecode('007', F24)).toBe(7);           // leading zeros are fine
  });

  it('trims surrounding whitespace (spaces, tabs, newlines)', () => {
    expect(parseTimecode('  1:00  ', F24)).toBe(24);
    expect(parseTimecode('\t12\n', F24)).toBe(12);
    expect(parseTimecode(' -5 ', F24, 10)).toBe(5);
  });

  it('relative frames: +N / -N only (sign directly followed by ASCII digits)', () => {
    expect(parseTimecode('-5', F24, 100)).toBe(95);
    expect(parseTimecode('+5', F24, 100)).toBe(105);
    expect(parseTimecode('+0', F24, 7)).toBe(7);
    expect(parseTimecode('-200', F24, 100)).toBe(-100);  // callers clamp
    expect(parseTimecode('- 5', F24, 100)).toBeNull();
    expect(parseTimecode('+５', F24, 100)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------
// BUG 4: one central frame-rate validator.
// ---------------------------------------------------------------------------------------------------
describe('isValidFps (BUG 4)', () => {
  it('accepts the presets and unusual but real rates', () => {
    for (const p of FPS_PRESETS) expect(isValidFps(p.fps), p.label).toBe(true);
    const ok: Rational[] = [
      { num: 1, den: 1 }, { num: 12, den: 1 }, { num: 15, den: 1 }, { num: 48, den: 1 }, { num: 120, den: 1 }, { num: 240, den: 1 },
      { num: 1000, den: 1 }, { num: 24000, den: 1001 }, { num: 30000, den: 1001 }, { num: 48000, den: 1001 }, { num: 60000, den: 1001 },
      { num: 120000, den: 1001 }, { num: 12500, den: 1000 }, { num: 2997, den: 100 }, { num: 48000, den: 2002 }, { num: 240000, den: 1000 },
    ];
    for (const r of ok) expect(isValidFps(r), `${r.num}/${r.den}`).toBe(true);
  });

  it('rejects zero / negative / non-integer / non-finite / absurd / wrongly typed values', () => {
    const bad: unknown[] = [
      null, undefined, 24, '24', [], [24, 1], {}, { num: 24 }, { den: 1 },
      { num: 0, den: 1 }, { num: 24, den: 0 }, { num: -24, den: 1 }, { num: 24, den: -1 }, { num: -24, den: -1 },
      { num: '24', den: 1 }, { num: 24, den: '1' }, { num: null, den: 1 }, { num: true, den: 1 },
      { num: NaN, den: 1 }, { num: 24, den: NaN }, { num: Infinity, den: 1 }, { num: 24, den: Infinity }, { num: -Infinity, den: 1 },
      { num: 23.976, den: 1 }, { num: 24, den: 1.5 },
      { num: 1, den: 2 }, { num: 1000, den: 1001 },          // below 1 fps
      { num: 1001, den: 1 }, { num: 1e6, den: 1 },           // above 1000 fps
      { num: 2e6, den: 2e6 / 24 }, { num: 24e6, den: 1e6 },  // terms too large
      { num: 2 ** 53, den: 2 ** 53 / 24 },
    ];
    for (const r of bad) expect(isValidFps(r), JSON.stringify(r) ?? String(r)).toBe(false);
  });

  it('parseFps never returns an invalid rate', () => {
    for (const v of [0, -24, NaN, Infinity, -Infinity, 0.5, 0.999, 1001, 1e9]) expect(parseFps(v), String(v)).toBeNull();
    expect(parseFps(1)).toEqual({ num: 1, den: 1 });
    expect(parseFps(1000)).toEqual({ num: 1000, den: 1 });
    expect(parseFps(119.88)).toEqual({ num: 120000, den: 1001 }); // F8: every x/1001 rate snaps
  });
});
