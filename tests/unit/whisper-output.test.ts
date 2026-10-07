/**
 * Reading whisper-cli's output (electron/whisper/output.ts): the JSON result with the defects whisper-cli really writes
 * (raw control characters, a multi-byte character cut in half), odd and reversed timestamps, empty and non-speech
 * segments, non-ASCII text, the stdout segment lines and the progress lines.
 */
import { describe, expect, it } from 'vitest';
import {
  escapeControlCharsInStrings, isNonSpeech, parseProgressLine, parseSegmentLine, parseWhisperJson, parseWhisperTimestamp,
  segmentsToCues,
} from '../../electron/whisper/output';

const doc = (segments: string, language = 'en') => `{
\t"systeminfo": "AVX = 1 | ",
\t"result": {
\t\t"language": "${language}"
\t},
\t"transcription": [
${segments}
\t]
}
`;
const seg = (from: number, to: number, text: string) =>
  `\t\t{\n\t\t\t"timestamps": { "from": "x", "to": "y" },\n\t\t\t"offsets": { "from": ${from}, "to": ${to} },\n\t\t\t"text": "${text}"\n\t\t}`;

describe('parseWhisperJson', () => {
  it('reads segments in seconds and the detected language', () => {
    const r = parseWhisperJson(doc([seg(0, 1500, ' Hello.'), seg(1500, 4020, ' How are you?')].join(',\n'), 'en'));
    expect(r.language).toBe('en');
    expect(r.segments).toEqual([{ start: 0, end: 1.5, text: ' Hello.' }, { start: 1.5, end: 4.02, text: ' How are you?' }]);
  });

  it('repairs raw control characters inside strings (whisper-cli escapes only quotes and backslashes)', () => {
    const raw = doc(seg(0, 1000, ' line one\nline two\ttabbed \\"quoted\\" back\\\\slash'));
    expect(() => JSON.parse(raw)).toThrow();
    const r = parseWhisperJson(raw);
    expect(r.segments[0].text).toBe(' line one\nline two\ttabbed "quoted" back\\slash');
  });

  it('keeps non-ASCII text and drops a multi-byte character cut at the end of a segment', () => {
    const good = Buffer.from(doc([seg(0, 1000, ' こんにちは'), seg(1000, 2000, ' Ça va très bien, Zoë')].join(',\n'), 'ja'), 'utf8');
    const r = parseWhisperJson(good);
    expect(r.segments.map((s) => s.text)).toEqual([' こんにちは', ' Ça va très bien, Zoë']);
    // "日本" with the last byte of 本 missing.
    const cut = Buffer.concat([Buffer.from(doc(seg(0, 1000, ' 日XX')).split('XX')[0], 'utf8'), Buffer.from('本', 'utf8').subarray(0, 2),
      Buffer.from(doc(seg(0, 1000, ' 日XX')).split('XX')[1], 'utf8')]);
    expect(parseWhisperJson(cut).segments[0].text).toBe(' 日');
  });

  it('falls back to the timestamp strings and skips segments without usable times', () => {
    const raw = `{"result":{"language":"de"},"transcription":[
      {"timestamps":{"from":"00:01:02,345","to":"00:01:04,000"},"text":" a"},
      {"timestamps":{"from":"bad","to":"00:00:01,000"},"text":" b"},
      {"offsets":{"from":null,"to":5},"text":" c"},
      "junk",
      {"offsets":{"from":10,"to":20}}
    ]}`;
    const r = parseWhisperJson(raw);
    expect(r.segments).toEqual([{ start: 62.345, end: 64, text: ' a' }, { start: 0.01, end: 0.02, text: '' }]);
  });

  it('accepts an empty transcription and a missing language, and refuses what is not a result', () => {
    expect(parseWhisperJson('{"transcription":[]}')).toEqual({ language: null, segments: [] });
    expect(() => parseWhisperJson('{"result":{}}')).toThrow(/without a transcription/);
    expect(() => parseWhisperJson('not json')).toThrow(/unreadable result/);
    expect(parseWhisperJson('﻿{"transcription":[]}').segments).toEqual([]);
  });
});

describe('escapeControlCharsInStrings', () => {
  it('escapes only inside strings and leaves structure and escapes alone', () => {
    expect(escapeControlCharsInStrings('{\n\t"a": "x\ty\u0001",\n"b": "q\\"\n"}')).toBe('{\n\t"a": "x\\ty\\u0001",\n"b": "q\\"\\n"}');
  });
});

describe('segmentsToCues', () => {
  it('offsets to source time, trims and collapses spaces, drops non-speech', () => {
    const cues = segmentsToCues([
      { start: 0, end: 1, text: '  Hello   there. ' },
      { start: 1, end: 2, text: ' [BLANK_AUDIO]' },
      { start: 2, end: 3, text: ' ♪ ♪ ' },
      { start: 3, end: 4, text: '' },
      { start: 4, end: 5, text: ' ...' },
      { start: 5, end: 6, text: ' Line one\r\n  line two ' },
      { start: 6, end: 7, text: ' 42' },
    ], 100);
    expect(cues.map((c) => [c.start, c.end, c.text])).toEqual([[100, 101, 'Hello there.'], [105, 106, 'Line one\nline two'], [106, 107, '42']]);
    expect(new Set(cues.map((c) => c.id)).size).toBe(3);
  });

  it('repairs odd times: reversed, negative, past the chunk, zero length, not finite', () => {
    const cues = segmentsToCues([
      { start: 3, end: 2, text: 'reversed' },
      { start: -1, end: 0.5, text: 'negative' },
      { start: 9, end: 12, text: 'past the end' },
      { start: 5, end: 5, text: 'zero' },
      { start: 10, end: 10, text: 'zero at the end' },
      { start: NaN, end: 1, text: 'nan' },
    ], 10, 10);
    expect(cues.map((c) => [c.start, c.end, c.text])).toEqual([
      [12, 13, 'reversed'], [10, 10.5, 'negative'], [19, 20, 'past the end'], [15, 15.05, 'zero'], [19.95, 20, 'zero at the end'],
    ]);
    for (const c of cues) expect(c.end).toBeGreaterThan(c.start);
  });

  it('knows non-speech text', () => {
    for (const t of ['', '  ', '[BLANK_AUDIO]', '[ blank_audio ]', '...', '♪', '- -']) expect(isNonSpeech(t)).toBe(true);
    for (const t of ['a', 'Ça', '日本', '7', '(laughs)', '[Music] yes']) expect(isNonSpeech(t)).toBe(false);
  });
});

describe('stdout and stderr lines', () => {
  it('parses segment lines', () => {
    expect(parseSegmentLine('[00:00:01.000 --> 00:00:04.500]   Hello there.')).toEqual({ start: 1, end: 4.5, text: 'Hello there.' });
    expect(parseSegmentLine('[01:02:03.004 --> 01:02:05.000]  ')).toEqual({ start: 3723.004, end: 3725, text: '' });
    expect(parseSegmentLine('whisper_init: loading model')).toBeNull();
    expect(parseSegmentLine('')).toBeNull();
  });

  it('parses progress lines and caps them at 100 %', () => {
    expect(parseProgressLine('whisper_print_progress_callback: progress =  45%')).toBe(0.45);
    expect(parseProgressLine('whisper_print_progress_callback: progress = 100%')).toBe(1);
    expect(parseProgressLine('whisper_print_progress_callback: progress = 783%')).toBe(1);
    expect(parseProgressLine('main: processing')).toBeNull();
  });

  it('parses timestamps', () => {
    expect(parseWhisperTimestamp('00:00:01,5')).toBe(1.5);
    expect(parseWhisperTimestamp('10:00:00.000')).toBe(36000);
    expect(parseWhisperTimestamp('1:2')).toBeNaN();
    expect(parseWhisperTimestamp(undefined)).toBeNaN();
  });
});
