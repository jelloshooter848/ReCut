/** #114: Program monitor subtitles wrap instead of overflowing both edges of the frame. */
import { describe, it, expect } from 'vitest';
import { wrapSubtitleText } from '../../src/playback/subtitleWrap';

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
