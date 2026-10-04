/**
 * Subtitle parser / serializer attack.
 */
import { describe, it, expect } from 'vitest';
import { parseSubtitles, serializeSrt, serializeVtt } from '../../shared/subtitles';
import { createSequence } from '../../shared/project';
import { resolveSubtitleCues } from '../../shared/timeline';

const srtBlock = (i: number, s: string, e: string, text: string) => `${i}\n${s} --> ${e}\n${text}\n`;

describe('parseSubtitles', () => {
  it('parses 100k cues in bounded time and keeps them all, in order', () => {
    const parts: string[] = [];
    for (let i = 0; i < 100_000; i++) {
      const s = i * 1.5, e = s + 1;
      const f = (t: number) => `${String(Math.floor(t / 3600)).padStart(2, '0')}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')},${String(Math.round((t % 1) * 1000)).padStart(3, '0')}`;
      parts.push(srtBlock(i + 1, f(s), f(e), `line ${i}`));
    }
    const text = parts.join('\n');
    const t0 = Date.now();
    const r = parseSubtitles(text);
    const parseMs = Date.now() - t0;
    expect(r.cues.length).toBe(100_000);
    expect(r.cues[99_999].text).toBe('line 99999');
    expect(parseMs).toBeLessThan(5000);
    const t1 = Date.now();
    const out = serializeSrt(r.cues);
    expect(Date.now() - t1).toBeLessThan(5000);
    expect(parseSubtitles(out).cues.length).toBe(100_000);
    // resolving 100k manual cues in a sequence
    const seq = createSequence('S', { num: 24, den: 1 });
    seq.subtitleTracks.push({ id: 't', name: 't', language: 'en', enabled: true, cues: r.cues.map((c, i) => ({ id: `c${i}`, start: Math.round(c.start * 24), duration: 24, offset: 0, text: c.text })) });
    const t2 = Date.now();
    expect(resolveSubtitleCues(seq).length).toBe(100_000);
    expect(Date.now() - t2).toBeLessThan(5000);
  });

  it('overlapping cues are all kept', () => {
    const r = parseSubtitles(srtBlock(1, '00:00:01,000', '00:00:05,000', 'a') + '\n' + srtBlock(2, '00:00:02,000', '00:00:03,000', 'b'));
    expect(r.cues.map((c) => c.text)).toEqual(['a', 'b']);
  });

  it('negative times and end<start do not crash; end<start is clamped and warned', () => {
    const r = parseSubtitles(srtBlock(1, '-00:00:01,000', '00:00:02,000', 'neg') + '\n' + srtBlock(2, '00:00:05,000', '00:00:02,000', 'rev'));
    expect(r.cues.find((c) => c.text === 'neg')).toBeUndefined();
    const rev = r.cues.find((c) => c.text === 'rev')!;
    expect(rev.end).toBeGreaterThan(rev.start);
    expect(r.warnings.length).toBeGreaterThanOrEqual(2);
  });

  it('times beyond 24h and 3-digit hours are accepted (long concatenated sources)', () => {
    const r = parseSubtitles(srtBlock(1, '25:10:00,000', '25:10:01,000', 'day2') + '\n' + srtBlock(2, '100:00:00,000', '100:00:01,000', 'h100'));
    expect(r.cues.find((c) => c.text === 'day2')?.start).toBe(25 * 3600 + 600);
    expect(r.cues.find((c) => c.text === 'h100')?.start, '3-digit hour rejected').toBe(100 * 3600);
  });

  it('BOM + CRLF + missing final newline + stray blank lines', () => {
    const text = '﻿1\r\n00:00:01,000 --> 00:00:02,000\r\nhello\r\n\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nworld';
    const r = parseSubtitles(text);
    expect(r.format).toBe('srt');
    expect(r.cues.map((c) => c.text)).toEqual(['hello', 'world']);
  });

  it('WebVTT with header metadata, STYLE/NOTE blocks, cue ids, positioning and voice tags', () => {
    const vtt = `WEBVTT - some title\nKind: captions\nLanguage: en\n\nSTYLE\n::cue { color: red }\n\nNOTE this is a note\n\nintro\n00:01.000 --> 00:02.000 align:start position:10% line:0\n<v Bob>Hi <b>there</b>\n\n00:00:03.000 --> 00:00:04.000\n<00:00:03.500>karaoke\n`;
    const r = parseSubtitles(vtt);
    expect(r.format).toBe('vtt');
    expect(r.cues.map((c) => [c.start, c.end, c.text])).toEqual([[1, 2, 'Hi there'], [3, 4, 'karaoke']]);
  });

  it('an SRT with only an index / header yields no cues and a warning, never a throw', () => {
    for (const t of ['1\n', '', 'WEBVTT\n', '1\n00:00:01,000 --> 00:00:02,000\n']) {
      const r = parseSubtitles(t);
      expect(r.cues).toEqual([]);
      expect(r.warnings.length, `no warning for input ${JSON.stringify(t)} (format=${r.format})`).toBeGreaterThan(0);
    }
  });

  it('export → re-import equality for SRT and VTT (timing to 1 ms, text incl. multi-line)', () => {
    const cues = [
      { start: 0.001, end: 1.234, text: 'one' },
      { start: 1.5, end: 2.5, text: 'two\nlines' },
      { start: 3661.999, end: 3662.5, text: 'late' },
    ];
    for (const fmt of ['srt', 'vtt'] as const) {
      const text = fmt === 'srt' ? serializeSrt(cues) : serializeVtt(cues);
      const back = parseSubtitles(text).cues;
      expect(back.map((c) => c.text)).toEqual(cues.map((c) => c.text));
      back.forEach((c, i) => { expect(c.start).toBeCloseTo(cues[i].start, 3); expect(c.end).toBeCloseTo(cues[i].end, 3); });
    }
  });

  it('a cue whose text contains a blank line survives export → re-import', () => {
    const cues = [{ start: 1, end: 2, text: 'para one\n\npara two' }];
    const back = parseSubtitles(serializeSrt(cues));
    expect(back.cues.length, 'blank line inside a cue splits it into a cue + an orphan block').toBe(1);
    // SRT cannot represent an empty line inside a cue: blank lines are collapsed on export (QA-23 fix).
    expect(back.cues[0]?.text).toBe('para one\npara two');
  });

  it('a cue whose text line looks like a timing line is not mis-parsed', () => {
    const cues = [{ start: 1, end: 2, text: 'see 00:00:05,000 --> 00:00:06,000 later' }];
    const back = parseSubtitles(serializeSrt(cues));
    expect(back.cues.length).toBe(1);
    expect(back.cues[0].start).toBe(1);
  });
});
