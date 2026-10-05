/**
 * Regression tests for critic finding F4 (formatter part): SRT / WebVTT serialization of cues that start
 * (or end) before 0, e.g. a cue nudged left of the sequence start.
 */
import { describe, it, expect } from 'vitest';
import { parseSubtitles, serializeSrt, serializeVtt } from '../../shared/subtitles';

describe('F4 serializers never write negative timestamps', () => {
  it('SRT clips a cue that starts before 0 to 0', () => {
    const srt = serializeSrt([{ start: -0.5, end: 1.5, text: 'hi' }]);
    expect(srt).toBe('1\n00:00:00,000 --> 00:00:01,500\nhi\n');
    expect(parseSubtitles(srt).warnings).toEqual([]);
  });

  it('VTT clips a cue that starts before 0 to 0', () => {
    expect(serializeVtt([{ start: -3661.5, end: 0.25, text: 'hi' }])).toBe('WEBVTT\n\n00:00:00.000 --> 00:00:00.250\nhi\n');
  });

  it('drops cues that end at or before 0 and renumbers SRT blocks', () => {
    const cues = [
      { start: -2, end: -1, text: 'gone' },
      { start: -1, end: 0, text: 'gone too' },
      { start: -1, end: 0.0004, text: 'rounds to 0 ms' },
      { start: 1, end: 2, text: 'kept' },
    ];
    expect(serializeSrt(cues)).toBe('1\n00:00:01,000 --> 00:00:02,000\nkept\n');
    expect(serializeVtt(cues)).toBe('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nkept\n');
  });

  it('drops cues with non-finite times instead of writing NaN', () => {
    const cues = [{ start: NaN, end: 1, text: 'a' }, { start: 0, end: NaN, text: 'b' }, { start: 0, end: Infinity, text: 'c' }, { start: 0, end: 1, text: 'ok' }];
    expect(serializeSrt(cues)).toBe('1\n00:00:00,000 --> 00:00:01,000\nok\n');
  });

  it('every written timestamp is well formed', () => {
    const cues = Array.from({ length: 200 }, (_, i) => ({ start: (i - 100) * 0.37, end: (i - 100) * 0.37 + 0.5, text: `c${i}` }));
    for (const out of [serializeSrt(cues), serializeVtt(cues)]) {
      for (const line of out.split('\n').filter((l) => l.includes('-->'))) {
        expect(line, line).toMatch(/^\d\d:\d\d:\d\d[,.]\d\d\d --> \d\d:\d\d:\d\d[,.]\d\d\d$/);
      }
    }
  });
});
