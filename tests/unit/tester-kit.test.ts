/**
 * The tester kit's pure helpers (scripts/tester-kit/lib.ts, used by scripts/tester-kit.mjs): subtitle normalising and
 * windowing, the deliberately messy SRT in trouble/ (checked against ReCut's own subtitle parser), shot picking for the
 * trailer project, and the MANIFEST / template formatting.
 */
import { describe, expect, it } from 'vitest';
import {
  bestWindow, fillTemplate, formatDuration, formatManifest, formatSize, kitText, messySrt, normalizeSubtitleBytes,
  parseFrameStats, pickShots, quietSpans, readCues, searchWord, windowCues, writeSrt, type FrameStat,
} from '../../scripts/tester-kit/lib';
import { parseSubtitles } from '../../shared/subtitles';

const enc = (s: string) => new TextEncoder().encode(s);

describe('tester kit: subtitles', () => {
  it('normalises official files: BOM after a blank line, CRLF, text glued to the timing line', () => {
    // As sintel_fr.srt (CRLF, then a BOM) and sintel_nl.srt (no newline after the timing) are published.
    const fr = normalizeSubtitleBytes(enc('\r\n﻿1\r\n00:01:47,250 --> 00:01:50,500\r\nCette lame a un sombre passé.\r\n'));
    expect(fr).toBe('1\n00:01:47,250 --> 00:01:50,500\nCette lame a un sombre passé.\n');
    const nl = normalizeSubtitleBytes(enc('1\n00:01:47,250 --> 00:01:50,500Dit wapen heeft een donker verleden.\n'));
    expect(nl).toBe('1\n00:01:47,250 --> 00:01:50,500\nDit wapen heeft een donker verleden.\n');
    expect(readCues(nl)).toMatchObject({ cues: [{ start: 107.25, end: 110.5, text: 'Dit wapen heeft een donker verleden.' }], warnings: [] });
  });

  it('decodes Windows-1252 when the bytes are not UTF-8', () => {
    const latin = new Uint8Array([...enc('1\n00:00:01,000 --> 00:00:02,000\nCaf'), 0xe9, 0x0a]);
    expect(normalizeSubtitleBytes(latin)).toContain('Café');
  });

  it('writes SRT with CRLF that ReCut reads back unchanged', () => {
    const cues = [{ start: 1, end: 2.5, text: 'One' }, { start: 3, end: 4, text: 'Two\nlines' }];
    const srt = writeSrt(cues);
    expect(srt).toContain('\r\n');
    expect(srt).not.toMatch(/[^\r]\n/);
    expect(readCues(srt)).toEqual({ cues, warnings: [] });
  });

  it('cuts a window of cues and finds the window with the most dialogue', () => {
    const cues = [
      { start: 2, end: 3, text: 'a' }, { start: 31, end: 33, text: 'a long line here' }, { start: 36, end: 38, text: 'and another one' },
    ];
    expect(windowCues(cues, 30, 10)).toEqual([{ start: 1, end: 3, text: 'a long line here' }, { start: 6, end: 8, text: 'and another one' }]);
    expect(bestWindow(cues, 100, 10)).toBe(30);
    expect(bestWindow(cues, 100, 10, { from: 50 })).toBe(50); // nothing after 50: the first window
    expect(bestWindow(cues, 8, 10)).toBe(0);
  });

  it('finds stretches without dialogue', () => {
    const cues = [{ start: 10, end: 12, text: 'x' }, { start: 30, end: 31, text: 'y' }];
    expect(quietSpans(cues, 0, 60, 8, 0.5)).toEqual([[0, 9.5], [12.5, 29.5], [31.5, 60]]);
    expect(quietSpans(cues, 0, 60, 20, 0.5)).toEqual([[31.5, 60]]);
  });
});

describe('tester kit: trouble/Messy subtitles.srt', () => {
  it('has every problem it promises, and ReCut keeps what TROUBLE.txt says', () => {
    const { text, expected } = messySrt();
    expect(text.startsWith('﻿')).toBe(true);
    expect(text).toContain('\r\n');
    expect(text).toContain('00:00:13.000'); // dot milliseconds
    const r = parseSubtitles(text);
    expect(r.format).toBe('srt');
    expect(r.cues).toHaveLength(expected.cues);
    expect(r.warnings).toHaveLength(expected.warnings);
    expect(r.warnings.join(' ')).toMatch(/end before start/);
    expect(r.warnings.join(' ')).toMatch(/empty text/);
    // Sorted by time although the file is not; overlaps are kept; the last one runs past the 30 s video.
    expect(r.cues.map((c) => c.start)).toEqual([...r.cues.map((c) => c.start)].sort((a, b) => a - b));
    expect(r.cues[0].text).toBe('The first line.');
    expect(r.cues.some((c, i) => i > 0 && c.start < r.cues[i - 1].end)).toBe(true);
    expect(Math.max(...r.cues.map((c) => c.end))).toBe(expected.lastEnd);
    expect(r.cues.find((c) => c.text.startsWith('This one overlaps'))?.text).not.toContain('<i>');
  });
});

describe('tester kit: shots for the trailer', () => {
  const stats = (): FrameStat[] => {
    const out: FrameStat[] = [];
    for (let i = 0; i < 24 * 60; i++) {
      const t = i / 24;
      // A cut every 6 s; the shot from 24 to 30 s is dark.
      out.push({ t, scene: i > 0 && i % (24 * 6) === 0 ? 0.9 : 0.01, yavg: t >= 24 && t < 30 ? 10 : 100 });
    }
    return out;
  };
  it('picks bright shots between cuts, trimmed around their middle, spread over the range', () => {
    const shots = pickShots(stats(), { from: 0, to: 60, n: 3, maxLen: 3 });
    expect(shots).toHaveLength(3);
    for (const [a, b] of shots) {
      expect(b - a).toBeCloseTo(3, 3);
      expect(Math.floor(a / 6)).toBe(Math.floor(b / 6)); // inside one shot
      expect(a >= 24 && a < 30).toBe(false); // not the dark one
    }
    expect(shots[0][0]).toBeLessThan(shots[2][0]);
  });
  it('leaves out washed-out shots', () => {
    const bright = stats().map((f) => (f.t >= 6 && f.t < 12 ? { ...f, yavg: 250 } : f));
    for (const [a] of pickShots(bright, { from: 0, to: 60, n: 10, maxLuma: 200 })) expect(a >= 6 && a < 12).toBe(false);
  });
  it('returns every usable shot when there are fewer than asked', () => {
    expect(pickShots(stats(), { from: 0, to: 13, n: 5 })).toHaveLength(2);
  });
  it('parses FFmpeg metadata=print output', () => {
    const text = 'frame:0    pts:0       pts_time:0\nlavfi.scene_score=0.000000\nlavfi.signalstats.YAVG=81.5\n'
      + 'frame:1    pts:512     pts_time:0.041667\nlavfi.scene_score=0.512000\nlavfi.signalstats.YMIN=16\nlavfi.signalstats.YAVG=40.25\n';
    expect(parseFrameStats(text)).toEqual([{ t: 0, scene: 0, yavg: 81.5 }, { t: 0.041667, scene: 0.512, yavg: 40.25 }]);
  });
});

describe('tester kit: search words', () => {
  const cue = (text: string) => ({ start: 0, end: 1, text });
  const tos = [cue("You're a jerk, Thom."), cue('Celia, the robots are here.'), cue('Robots everywhere. Celia, run!'), cue('I was alone.')];
  const sintel = [cue('The dragon is gone.'), cue('I am alone now, alone.'), cue('(roars) Scales!')];
  it('prefers a listed word, else the most frequent one', () => {
    expect(searchWord(tos, [], ['robots'])).toBe('robots');
    expect(searchWord(tos)).toBe('robots'); // 'celia' is as frequent, 'robots' longer
    expect(searchWord(sintel)).toBe('alone');
  });
  it('finds a word both films say', () => {
    expect(searchWord(tos, [sintel])).toBe('alone');
    expect(searchWord([cue('Robots')], [sintel])).toBeNull();
  });
});

describe('tester kit: text', () => {
  it('formats sizes and durations', () => {
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(2048)).toBe('2 KB');
    expect(formatSize(5 * 1024 * 1024 + 300000)).toBe('5.3 MB');
    expect(formatDuration(7.5)).toBe('0:07.5');
    expect(formatDuration(9.96)).toBe('0:10.0');
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(7200)).toBe('2:00:00');
    expect(formatDuration(1 / 24)).toBe('0:00.042');
    expect(formatDuration(null)).toBe('');
  });
  it('lists files by folder in MANIFEST.txt', () => {
    const m = formatManifest([
      { path: 'formats/b.mp4', size: 2 * 1024 * 1024, duration: 30, codec: 'h264 1280x720 24 fps', purpose: 'B' },
      { path: 'README-FIRST.txt', size: 100, codec: 'text', purpose: 'Start here' },
      { path: 'formats/a.mkv', size: 1024, duration: 20, codec: 'h264', purpose: 'A' },
    ], ['Header']);
    expect(m.indexOf('a.mkv')).toBeLessThan(m.indexOf('b.mp4'));
    expect(m.indexOf('README-FIRST.txt')).toBeLessThan(m.indexOf('formats/'));
    expect(m.split('(kit folder)')).toHaveLength(2);
    expect(m).toContain('formats/\n  a.mkv\n      1 KB | 0:20 | h264\n      A');
    expect(m).toContain('3 files, 2.0 MB in total');
  });
  it('fills templates strictly', () => {
    expect(fillTemplate('ReCut {{VERSION}}', { VERSION: '0.9.0' })).toBe('ReCut 0.9.0');
    expect(() => fillTemplate('{{NOPE}}', {})).toThrow(/NOPE/);
    expect(() => fillTemplate('x', { VERSION: '1' })).toThrow(/not used/);
  });
  it('writes kit text files with CRLF and no trailing spaces', () => {
    expect(kitText('a  \nb\n\n\n')).toBe('a\r\nb\r\n');
  });
});
