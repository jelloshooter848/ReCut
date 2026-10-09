/** #114: Program monitor subtitles wrap instead of overflowing both edges of the frame. */
import { describe, it, expect } from 'vitest';
import { activeWordIndex, wrapSubtitleText, wrapWords } from '../../src/playback/subtitleWrap';

const measure = (s: string) => s.length; // one unit per character

describe('wrapSubtitleText', () => {
  it('packs words greedily into lines no wider than the limit', () => {
    expect(wrapSubtitleText('the quick brown fox jumps over the lazy dog', 15, measure))
      .toEqual(['the quick brown', 'fox jumps over', 'the lazy dog']);
  });

  it('keeps explicit line breaks and collapses extra spaces', () => {
    expect(wrapSubtitleText('one  two\nthree', 100, measure)).toEqual(['one two', 'three']);
  });

  it('gives a word wider than the limit its own line', () => {
    expect(wrapSubtitleText('a supercalifragilistic b', 5, measure)).toEqual(['a', 'supercalifragilistic', 'b']);
  });

  it('returns no lines for empty or blank text', () => {
    expect(wrapSubtitleText('', 10, measure)).toEqual([]);
    expect(wrapSubtitleText(' \n ', 10, measure)).toEqual([]);
  });
});

describe('karaoke helpers (#119)', () => {
  const words = [{ start: 10 }, { start: 12 }, { start: 15 }];
  it('activeWordIndex: the last word that has started, -1 before the first', () => {
    expect(activeWordIndex(words, 9)).toBe(-1);
    expect(activeWordIndex(words, 10)).toBe(0);
    expect(activeWordIndex(words, 14.9)).toBe(1);
    expect(activeWordIndex(words, 99)).toBe(2);
    expect(activeWordIndex(undefined, 10)).toBe(-1);
  });

  it('wrapWords lays words out like wrapSubtitleText, as word indices', () => {
    const texts = ['the', 'quick', 'brown', 'fox', 'jumps', 'over', 'the', 'lazy', 'dog'];
    const lines = wrapWords(texts, 15, measure);
    expect(lines.map((l) => l.map((i) => texts[i]).join(' '))).toEqual(wrapSubtitleText(texts.join(' '), 15, measure));
    expect(lines.flat()).toEqual(texts.map((_, i) => i));
  });
});
