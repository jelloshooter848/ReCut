/**
 * One timecode display rule app-wide: SMPTE drop-frame (HH:MM:SS;FF) at exactly 30000/1001 and 60000/1001,
 * non-drop (HH:MM:SS:FF) at every other rate. Covers the shared helpers in shared/time.ts, TimecodeField entry
 * (what you type matches what you see), the timeline ruler, and the readouts built on the helpers.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Clip, MediaItem, Rational } from '../../shared/model';
import {
  formatTimecode, formatSequenceTimecode, formatSequenceSecondsTimecode, parseSequenceTimecode, usesDropFrameDisplay,
  framesToSeconds,
} from '../../shared/time';
import { TimecodeField, expandTimecodeDigits, parseTimecodeEntry } from '../../src/components/ui/TimecodeField';
import { rulerTicks, formatDelta } from '../../src/panels/timeline/viewMath';
import { originalTimecode } from '../../src/state/selectors';
import { tc } from '../../src/panels/inspector/primitives';
import { rangeLabel } from '../../src/panels/scenes/sceneUtils';

const F23976: Rational = { num: 24000, den: 1001 };
const F2997: Rational = { num: 30000, den: 1001 };
const F5994: Rational = { num: 60000, den: 1001 };
const F25: Rational = { num: 25, den: 1 };
const F30: Rational = { num: 30, den: 1 };
const RATES: [string, Rational][] = [['23.976', F23976], ['25', F25], ['29.97', F2997], ['30', F30], ['59.94', F5994]];

/** Frames that exercise minute / ten-minute / hour boundaries and the drop-frame skips at every rate. */
function sampleFrames(fps: Rational): number[] {
  const n = Math.round(fps.num / fps.den);
  const out = new Set<number>([0, 1, n - 1, n, n * 59, n * 60 - 1, n * 60, n * 60 + 1, n * 60 + 4, n * 600, n * 600 - 1, 17982, 17983, 35964, 107892, 107891, 215784, 215783, 1234567]);
  for (let f = 0; f < 4 * 3600 * n; f += 7919) out.add(f);
  return [...out].filter((f) => f >= 0).sort((a, b) => a - b);
}

describe('usesDropFrameDisplay / formatSequenceTimecode', () => {
  it('drop-frame only at exactly 29.97 and 59.94', () => {
    expect(usesDropFrameDisplay(F2997)).toBe(true);
    expect(usesDropFrameDisplay(F5994)).toBe(true);
    expect(usesDropFrameDisplay(F23976)).toBe(false);
    expect(usesDropFrameDisplay(F25)).toBe(false);
    expect(usesDropFrameDisplay(F30)).toBe(false);
    expect(usesDropFrameDisplay({ num: 2997, den: 100 })).toBe(false);
  });

  it('29.97: drop-frame labels with ;', () => {
    expect(formatSequenceTimecode(0, F2997)).toBe('00:00:00;00');
    expect(formatSequenceTimecode(1799, F2997)).toBe('00:00:59;29');
    expect(formatSequenceTimecode(1800, F2997)).toBe('00:01:00;02');
    expect(formatSequenceTimecode(17982, F2997)).toBe('00:10:00;00');
    expect(formatSequenceTimecode(107892, F2997)).toBe('01:00:00;00');
    expect(formatSequenceTimecode(-1800, F2997)).toBe('-00:01:00;02');
  });

  it('59.94: drop-frame labels with ;', () => {
    expect(formatSequenceTimecode(3600, F5994)).toBe('00:01:00;04');
    expect(formatSequenceTimecode(215784, F5994)).toBe('01:00:00;00');
  });

  it('23.976 / 25 / 30: non-drop labels with :', () => {
    expect(formatSequenceTimecode(24, F23976)).toBe('00:00:01:00');
    expect(formatSequenceTimecode(86400, F23976)).toBe('01:00:00:00');
    expect(formatSequenceTimecode(90000, F25)).toBe('01:00:00:00');
    expect(formatSequenceTimecode(1800, F30)).toBe('00:01:00:00');
  });

  it('seconds variant converts at the given rate first', () => {
    expect(formatSequenceSecondsTimecode(framesToSeconds(1800, F2997), F2997)).toBe('00:01:00;02');
    expect(formatSequenceSecondsTimecode(3600, F2997)).toBe('01:00:00;00'); // an hour of real time
    expect(formatSequenceSecondsTimecode(60, F25)).toBe('00:01:00:00');
  });
});

describe('parseSequenceTimecode: typed text means what the display shows', () => {
  for (const [label, fps] of RATES) {
    it(`${label}: display -> parse round-trips (as shown, digits only, ':' typed)`, () => {
      for (const f of sampleFrames(fps)) {
        const shown = formatSequenceTimecode(f, fps);
        expect(parseSequenceTimecode(shown, fps)).toBe(f);
        expect(parseSequenceTimecode(shown.replace(/[:;]/g, ''), fps)).toBe(f);  // "00010002" shorthand
        expect(parseSequenceTimecode(shown.replace(';', ':'), fps)).toBe(f);     // all-colon typing
      }
    });
  }

  it('29.97: colon and digit shorthand are drop-frame labels', () => {
    expect(parseSequenceTimecode('1:00:00:00', F2997)).toBe(107892);
    expect(parseSequenceTimecode('1000000', F2997)).toBe(107892);
    expect(parseSequenceTimecode('10002', F2997)).toBe(1800);
    expect(parseSequenceTimecode('1.00.02', F2997)).toBe(1800);
    expect(parseSequenceTimecode('00:01:00;02', F2997)).toBe(1800);
    expect(parseSequenceTimecode('59:32', F2997)).toBe(1800); // overflow carries, as with ';'
    expect(parseSequenceTimecode('-01:00:00:00', F2997)).toBe(-107892);
  });

  it('29.97: labels drop-frame skips are rejected however they are typed', () => {
    expect(parseSequenceTimecode('00:01:00:00', F2997)).toBeNull();
    expect(parseSequenceTimecode('00:01:00;01', F2997)).toBeNull();
    expect(parseSequenceTimecode('10000', F2997)).toBeNull();
    expect(parseSequenceTimecode('00:10:00:00', F2997)).toBe(17982); // every 10th minute keeps 00 and 01
  });

  it('relative entry and short forms are unchanged', () => {
    expect(parseSequenceTimecode('+24', F2997, 100)).toBe(124);
    expect(parseSequenceTimecode('-24', F2997, 100)).toBe(76);
    expect(parseSequenceTimecode('12', F2997)).toBe(12);
    expect(parseSequenceTimecode('', F2997)).toBeNull();
    expect(parseSequenceTimecode('1:2:3:4:5', F2997)).toBeNull();
  });

  it('non-drop rates: ; is only a separator', () => {
    expect(parseSequenceTimecode('1:00:00:00', F25)).toBe(90000);
    expect(parseSequenceTimecode('1:00:00;00', F25)).toBe(90000);
    expect(parseSequenceTimecode('1000000', F23976)).toBe(86400);
  });
});

describe('TimecodeField entry', () => {
  const shown = (value: number, fps: Rational, dropIndicator?: boolean) => {
    const html = renderToStaticMarkup(createElement(TimecodeField, { value, fps, onChange: () => {}, ...(dropIndicator === undefined ? {} : { dropIndicator }) }));
    return /<span>([^<]*)<\/span>/.exec(html)![1];
  };

  it('displays the app-wide rule by default', () => {
    expect(shown(1800, F2997)).toBe('00:01:00;02');
    expect(shown(3600, F5994)).toBe('00:01:00;04');
    expect(shown(24, F23976)).toBe('00:00:01:00');
    expect(shown(1800, F2997, false)).toBe('00:01:00:00');
  });

  for (const [label, fps] of RATES) {
    for (const df of [true, false]) {
      it(`${label} dropIndicator=${df}: displayed text typed back gives the same frame`, () => {
        for (const f of sampleFrames(fps)) {
          const text = shown(f, fps, df);
          expect(parseTimecodeEntry(text, fps, 0, df)).toBe(f);
          expect(parseTimecodeEntry(text.replace(/[:;]/g, ''), fps, 0, df)).toBe(f);
          expect(parseTimecodeEntry(text.replace(';', ':'), fps, 0, df)).toBe(f);
        }
      });
    }
  }

  it('29.97 drop-frame field: 1000000 and 1:00:00:00 mean 01:00:00;00', () => {
    expect(parseTimecodeEntry('1000000', F2997)).toBe(107892);
    expect(parseTimecodeEntry('1:00:00:00', F2997)).toBe(107892);
    expect(parseTimecodeEntry('1000000', F2997, 0, false)).toBe(108000);
    expect(parseTimecodeEntry('1:00:00:00', F2997, 0, false)).toBe(108000);
  });

  it('expandTimecodeDigits uses ; as the last separator for drop-frame entry', () => {
    expect(expandTimecodeDigits('1000000')).toBe('1:00:00:00');
    expect(expandTimecodeDigits('1000000', true)).toBe('1:00:00;00');
    expect(expandTimecodeDigits('12', true)).toBe('12');
    expect(expandTimecodeDigits('+24', true)).toBe('+24');
  });
});

describe('timeline ruler', () => {
  it('29.97 labels are drop-frame', () => {
    const ticks = rulerTicks(F2997, 0.05, 0, 1000); // 1-minute majors (1800 frames = 90 px)
    const majors = ticks.filter((t) => t.major);
    expect(majors.slice(0, 3).map((t) => [t.frame, t.label])).toEqual([[0, '00:00:00;00'], [1800, '00:01:00;02'], [3600, '00:02:00;04']]);
    expect(majors.find((t) => t.frame === 18000)?.label).toBe('00:10:00;18');
    for (const t of majors) expect(t.label).toBe(formatSequenceTimecode(t.frame, F2997));
  });

  it('25 / 23.976 labels stay non-drop', () => {
    expect(rulerTicks(F25, 4, 0, 800).filter((t) => t.major)[1].label).toBe('00:00:01:00');
    expect(rulerTicks(F23976, 4, 0, 800).filter((t) => t.major)[1].label).toBe('00:00:01:00');
  });

  it('delta labels follow the rule', () => {
    expect(formatDelta(1800, F2997)).toBe('+1800 (+00:01:00;02)');
    expect(formatDelta(-24, F25)).toBe('-24 (-00:00:00:24)');
  });
});

describe('readouts agree with the Program monitor', () => {
  it('inspector tc and scenes range at 29.97', () => {
    expect(tc(1800, F2997)).toBe('00:01:00;02');
    expect(tc(48, F23976)).toBe('00:00:02:00');
    expect(rangeLabel({ in: framesToSeconds(1800, F2997), out: 3600 } as never, F2997)).toBe('00:01:00;02 → 01:00:00;00');
  });

  it('source timecode of a 29.97 clip is drop-frame', () => {
    const clip = { id: 'c', mediaId: 'm', start: 0, duration: 200000, sourceIn: 0, speed: 1, reverse: false } as unknown as Clip;
    const media = { id: 'm', path: '/x/movie.mkv', name: 'movie', identity: {}, probe: { video: { fps: F2997 } } } as unknown as MediaItem;
    expect(originalTimecode(clip, 107892, F2997, media).sourceTimecode).toBe('01:00:00;00');
  });

  // Every frame-timecode readout in these panels must go through the shared display helpers, never a bare
  // formatTimecode / formatSecondsTimecode (which are non-drop unless asked).
  it('owned panels use the shared display helpers', () => {
    const root = join(__dirname, '..', '..');
    const files: string[] = [join(root, 'src/state/selectors.ts')];
    const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (/\.tsx?$/.test(n)) files.push(p); } };
    for (const d of ['timeline', 'program', 'source', 'markers', 'inspector', 'transcript', 'scenes', 'compare']) walk(join(root, 'src/panels', d));
    const offenders = files.flatMap((p) => readFileSync(p, 'utf8').split('\n').map((l, i) => [p, i + 1, l] as const))
      .filter(([, , l]) => /\bformat(Seconds)?Timecode\(/.test(l))
      .map(([p, n]) => `${relative(root, p)}:${n}`);
    expect(offenders).toEqual([]);
  });
});

// Keep the non-drop primitive honest: formatTimecode without the indicator is still a plain count.
it('formatTimecode without dropIndicator is unchanged (non-drop)', () => {
  expect(formatTimecode(1800, F2997)).toBe('00:01:00:00');
});
