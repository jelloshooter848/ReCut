/**
 * #155: a filmstrip's frames are split into balanced batches (one FFmpeg each) that fill the 3 extraction slots in as
 * few rounds as possible, instead of fixed batches of 12 (48 frames ran 3 + 1: two rounds).
 */
import { describe, expect, it } from 'vitest';
import { filmstripBatches } from '../../electron/media/thumbs';

const sizes = (n: number) => filmstripBatches(Array.from({ length: n }, (_, i) => i)).map((b) => b.length);

describe('filmstripBatches', () => {
  it('48 frames: 3 batches of 16, one round', () => {
    expect(sizes(48)).toEqual([16, 16, 16]);
  });

  it('fills the 3 slots evenly, 8 to 16 per batch, in the fewest rounds; a short filmstrip is one batch', () => {
    expect(sizes(0)).toEqual([]);
    expect(sizes(1)).toEqual([1]);
    expect(sizes(7)).toEqual([7]);
    expect(sizes(16)).toEqual([8, 8]);
    expect(sizes(24)).toEqual([8, 8, 8]);
    expect(sizes(49)).toEqual([9, 8, 8, 8, 8, 8]); // two rounds of 3
    expect(sizes(100)).toEqual([12, 11, 11, 11, 11, 11, 11, 11, 11]);
    for (const n of [5, 17, 48, 49, 96, 97, 300]) {
      const s = sizes(n);
      expect(s.reduce((a, b) => a + b, 0)).toBe(n);
      expect(Math.max(...s)).toBeLessThanOrEqual(16);
      expect(Math.max(...s) - Math.min(...s)).toBeLessThanOrEqual(1);
      if (s.length > 1) expect(Math.min(...s)).toBeGreaterThanOrEqual(8);
      expect(s.length).toBeLessThanOrEqual(3 * Math.ceil(n / 48));
    }
  });

  it('keeps time order: each batch is a run of consecutive frames', () => {
    const b = filmstripBatches(Array.from({ length: 10 }, (_, i) => i));
    expect(b.flat()).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});
