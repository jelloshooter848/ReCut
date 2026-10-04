import { describe, it, expect } from 'vitest';
import { parseSubtitles, serializeSrt, serializeVtt, searchCues } from '../../shared/subtitles';
import type { SubtitleCue } from '../../shared/model';

const SRT_BASIC = [
  '1',
  '00:00:01,000 --> 00:00:02,500',
  'Hello there.',
  '',
  '2',
  '00:00:03,000 --> 00:00:04,000',
  '<i>General</i> Kenobi!',
  '',
].join('\n');

describe('parseSubtitles (SRT)', () => {
  it('parses a basic file, strips HTML tags, detects format', () => {
    const r = parseSubtitles(SRT_BASIC);
    expect(r.format).toBe('srt');
    expect(r.warnings).toEqual([]);
    expect(r.cues).toHaveLength(2);
    expect(r.cues[0]).toMatchObject({ start: 1, end: 2.5, text: 'Hello there.' });
    expect(r.cues[1]).toMatchObject({ start: 3, end: 4, text: 'General Kenobi!' });
    expect(r.cues[0].id).toBeTruthy();
    expect(r.cues[0].id).not.toBe(r.cues[1].id);
  });

  it('handles CRLF line endings and a UTF-8 BOM', () => {
    const r = parseSubtitles('﻿' + SRT_BASIC.replace(/\n/g, '\r\n'));
    expect(r.format).toBe('srt');
    expect(r.warnings).toEqual([]);
    expect(r.cues.map((c) => c.text)).toEqual(['Hello there.', 'General Kenobi!']);
    expect(r.cues[0].start).toBe(1);
  });

  it('accepts blocks with a missing index', () => {
    const r = parseSubtitles('00:00:01,000 --> 00:00:02,000\nNo index here\n\n00:00:03,000 --> 00:00:04,000\nStill fine\n');
    expect(r.cues.map((c) => c.text)).toEqual(['No index here', 'Still fine']);
    expect(r.warnings).toEqual([]);
  });

  it('strips ASS-style override tags and keeps multi-line text joined with \\n', () => {
    const r = parseSubtitles('1\n00:00:01,000 --> 00:00:02,000\n{\\an8}Line one\n<b>Line</b> two\n');
    expect(r.cues[0].text).toBe('Line one\nLine two');
  });

  it('sorts out-of-order cues by start time', () => {
    const r = parseSubtitles('1\n00:00:10,000 --> 00:00:11,000\nLate\n\n2\n00:00:01,000 --> 00:00:02,000\nEarly\n');
    expect(r.cues.map((c) => c.text)).toEqual(['Early', 'Late']);
  });

  it('skips malformed blocks with a warning and keeps the rest', () => {
    const r = parseSubtitles('1\nthis block has no timing\n\n2\n00:00:03,000 --> 00:00:04,000\nGood\n\n3\n00:00:xx,000 --> 00:00:05,000\nBad time\n');
    expect(r.cues.map((c) => c.text)).toEqual(['Good']);
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings[0]).toMatch(/Block 1: missing timing/);
    expect(r.warnings[1]).toMatch(/Block 3: unparseable timing/);
  });

  it('warns when end <= start and forces a positive duration', () => {
    const r = parseSubtitles('1\n00:00:05,000 --> 00:00:04,000\nBackwards\n');
    expect(r.warnings.some((w) => /end before start/.test(w))).toBe(true);
    expect(r.cues).toHaveLength(1);
    expect(r.cues[0].start).toBe(5);
    expect(r.cues[0].end).toBeGreaterThan(5);
  });

  it('warns on empty text (e.g. tags only) and drops the cue', () => {
    const r = parseSubtitles('1\n00:00:01,000 --> 00:00:02,000\n<i></i>\n');
    expect(r.cues).toHaveLength(0);
    expect(r.warnings).toContain('Block 1: empty text');
  });

  it('parses fractional ms with 1-3 digits and hours', () => {
    const r = parseSubtitles('1\n01:02:03,5 --> 01:02:04,25\nx\n');
    expect(r.cues[0].start).toBeCloseTo(3723.5, 9);
    expect(r.cues[0].end).toBeCloseTo(3724.25, 9);
  });

  it('reports unknown format for garbage input', () => {
    const r = parseSubtitles('just some text\n\nnothing to see');
    expect(r.format).toBe('unknown');
    expect(r.cues).toHaveLength(0);
    expect(r.warnings[0]).toMatch(/No subtitle cues recognised/);
  });
});

describe('parseSubtitles (WebVTT)', () => {
  const VTT = [
    'WEBVTT - Some title',
    'Kind: captions',
    '',
    'NOTE this is a comment',
    'spanning two lines',
    '',
    'STYLE',
    '::cue { color: red }',
    '',
    '00:01.000 --> 00:02.000 line:0 position:50%',
    'Hour-less with settings',
    '',
    'intro',
    '00:00:03.000 --> 00:00:04.000',
    '<v Han>Named cue</v>',
    '',
    '2',
    '00:00:05.000 --> 00:00:06.000 align:start',
    'Numbered cue',
    '',
  ].join('\n');

  it('parses header, skips NOTE/STYLE blocks, handles cue settings, hour-less times and identifiers', () => {
    const r = parseSubtitles(VTT);
    expect(r.format).toBe('vtt');
    expect(r.warnings).toEqual([]);
    expect(r.cues).toHaveLength(3);
    expect(r.cues[0]).toMatchObject({ start: 1, end: 2, text: 'Hour-less with settings' });
    expect(r.cues[1]).toMatchObject({ start: 3, end: 4, text: 'Named cue' });
    expect(r.cues[2]).toMatchObject({ start: 5, end: 6, text: 'Numbered cue' });
  });

  it('handles a BOM + CRLF VTT', () => {
    const r = parseSubtitles('﻿WEBVTT\r\n\r\n00:00:01.000 --> 00:00:02.000\r\nHi\r\n');
    expect(r.format).toBe('vtt');
    expect(r.cues).toHaveLength(1);
    expect(r.cues[0].text).toBe('Hi');
  });
});

describe('serialize', () => {
  it('serializeSrt produces numbered blocks and roundtrips through the parser', () => {
    const cues = [
      { start: 1, end: 2.5, text: 'Hello there.' },
      { start: 3723.5, end: 3724.25, text: 'Two\nlines' },
    ];
    const srt = serializeSrt(cues);
    expect(srt).toBe('1\n00:00:01,000 --> 00:00:02,500\nHello there.\n\n2\n01:02:03,500 --> 01:02:04,250\nTwo\nlines\n');
    const back = parseSubtitles(srt);
    expect(back.format).toBe('srt');
    expect(back.warnings).toEqual([]);
    expect(back.cues.map(({ start, end, text }) => ({ start, end, text }))).toEqual(cues);
  });

  it('serializeVtt writes a header and dot-separated milliseconds; parser reads it back', () => {
    const cues = [{ start: 0.04, end: 1.999, text: 'x' }];
    const vtt = serializeVtt(cues);
    expect(vtt).toBe('WEBVTT\n\n00:00:00.040 --> 00:00:01.999\nx\n');
    const back = parseSubtitles(vtt);
    expect(back.format).toBe('vtt');
    expect(back.cues[0]).toMatchObject({ start: 0.04, end: 1.999, text: 'x' });
  });

  it('serializeSrt rounds to whole milliseconds', () => {
    expect(serializeSrt([{ start: 0.0005, end: 0.9996, text: 'r' }])).toContain('00:00:00,001 --> 00:00:01,000');
  });
});

describe('searchCues', () => {
  const cues: SubtitleCue[] = [
    { id: 'a', start: 0, end: 1, text: 'I have a bad feeling about this' },
    { id: 'b', start: 1, end: 2, text: 'This is the way' },
    { id: 'c', start: 2, end: 3, text: 'Do. Or do not. There is no try.' },
    { id: 'd', start: 3, end: 4, text: 'The way is shut' },
  ];

  it('is case-insensitive and requires ALL terms (AND semantics)', () => {
    expect(searchCues(cues, 'THE WAY').map((m) => m.cue.id)).toEqual(['b', 'd']);
    expect(searchCues(cues, 'way shut').map((m) => m.cue.id)).toEqual(['d']);
    expect(searchCues(cues, 'way feeling')).toEqual([]);
  });

  it('returns index and before/after context', () => {
    const [m] = searchCues(cues, 'try');
    expect(m.index).toBe(2);
    expect(m.before).toBe('This is the way');
    expect(m.after).toBe('The way is shut');
    const [first] = searchCues(cues, 'feeling');
    expect(first.before).toBe('');
    const [last] = searchCues(cues, 'shut');
    expect(last.after).toBe('');
  });

  it('returns nothing for an empty query and respects maxResults', () => {
    expect(searchCues(cues, '   ')).toEqual([]);
    expect(searchCues(cues, 'the', 1)).toHaveLength(1);
  });
});

describe('attack fixes (QA-23/24/30)', () => {
  it('serializeSrt / serializeVtt collapse blank lines inside a cue so it survives a round trip', () => {
    const cues = [{ start: 1, end: 2, text: 'para one\n\n \npara two' }, { start: 3, end: 4, text: 'next' }];
    for (const out of [serializeSrt(cues), serializeVtt(cues)]) {
      const back = parseSubtitles(out);
      expect(back.cues.map((c) => c.text)).toEqual(['para one\npara two', 'next']);
    }
  });

  it('accepts 1–3 digit hours', () => {
    const r = parseSubtitles('1\n5:00:00,000 --> 5:00:01,000\na\n\n2\n100:00:00,000 --> 100:00:01,500\nb\n');
    expect(r.format).toBe('srt');
    expect(r.cues.map((c) => [c.text, c.start, c.end])).toEqual([['a', 18000, 18001], ['b', 360000, 360001.5]]);
    expect(parseSubtitles('1\n1000:00:00,000 --> 1000:00:01,000\nx\n').cues).toEqual([]);
  });

  it('a header-only WebVTT yields a warning', () => {
    expect(parseSubtitles('WEBVTT\n').warnings.length).toBeGreaterThan(0);
  });
});
