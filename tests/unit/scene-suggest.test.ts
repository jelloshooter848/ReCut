/**
 * #147: suggested scenes group shots by speech across the cut, picture similarity and sound continuity.
 */
import { describe, expect, it } from 'vitest';
import { audioLink, cutLinks, groupShots, histogramFromRgba, histSimilarity, speechLink } from '../../shared/sceneSuggest';

/** RGBA pixels of one flat colour. */
const flat = (r: number, g: number, b: number, n = 64) => { const px = new Uint8ClampedArray(n * 4); for (let i = 0; i < n; i++) px.set([r, g, b, 255], i * 4); return px; };
const shots = (edges: number[]) => edges.slice(0, -1).map((s, i) => ({ id: `s${i}`, start: s, end: edges[i + 1] }));

describe('signals', () => {
  it('speech: a line across the cut, a short gap, a long gap, silence', () => {
    expect(speechLink([{ start: 4, end: 6 }], 5)).toBe(1);
    expect(speechLink([{ start: 2, end: 4.8 }, { start: 5.2, end: 7 }], 5)).toBe(0.9);
    expect(speechLink([{ start: 2, end: 4 }, { start: 6.5, end: 7 }], 5)).toBe(0.3);
    expect(speechLink([{ start: 0, end: 1 }], 5)).toBeNull();      // nothing near the cut
    expect(speechLink([{ start: 3, end: 4.5 }], 5)).toBe(0);        // speech stops at the cut
  });

  it('picture: same colours ~1, different colours ~0; brightness counts', () => {
    const red = histogramFromRgba(flat(200, 30, 30)), red2 = histogramFromRgba(flat(190, 40, 35)), blue = histogramFromRgba(flat(30, 40, 200));
    expect(histSimilarity(red, red2)).toBeGreaterThan(0.75);
    expect(histSimilarity(red, blue)).toBeLessThan(0.55);
    expect(histSimilarity(histogramFromRgba(flat(20, 20, 20)), histogramFromRgba(flat(230, 230, 230)))).toBeLessThan(0.1);
  });

  it('sound: silence on both sides is a break; a level that carries on links', () => {
    const peaks = new Uint8Array(100); // 10 per second
    for (let i = 0; i < 50; i++) peaks[i] = 120;
    for (let i = 50; i < 70; i++) peaks[i] = 125;
    expect(audioLink({ rate: 10, peaks }, 5)).toBeGreaterThan(0.9);
    expect(audioLink({ rate: 10, peaks }, 8.5)).toBe(0); // 7..10 s is silent
  });
});

describe('grouping', () => {
  const R = histogramFromRgba(flat(200, 30, 30)), R2 = histogramFromRgba(flat(185, 45, 40));
  const B = histogramFromRgba(flat(30, 40, 200)), B2 = histogramFromRgba(flat(45, 50, 185));
  const G = histogramFromRgba(flat(40, 190, 50));

  it('locations: red, red, blue, blue, blue, green -> three scenes', () => {
    const links = cutLinks({ shots: shots([0, 2, 4, 6, 8, 10, 12]), hists: [R, R2, B, B2, B, G] });
    expect(groupShots(links)).toEqual([[0, 1], [2, 3, 4], [5]]);
  });

  it('shot / reverse-shot (A B A B) in one place stays together through the lookback and the dialogue', () => {
    const cues = [{ start: 0.5, end: 2.2 }, { start: 2.4, end: 4.1 }, { start: 4.3, end: 6.2 }, { start: 6.3, end: 7.5 }];
    const links = cutLinks({ shots: shots([0, 2, 4, 6, 8, 10]), hists: [R, B, R2, B2, G], cues });
    expect(groupShots(links)).toEqual([[0, 1, 2, 3], [4]]);
  });

  it('no signals: every shot is its own scene; the threshold trades fewer for longer scenes', () => {
    expect(groupShots(cutLinks({ shots: shots([0, 1, 2, 3]) }))).toEqual([[0], [1], [2]]);
    const links = cutLinks({ shots: shots([0, 2, 4, 6]), hists: [R, R2, B] });
    expect(groupShots(links, 0.99).length).toBeGreaterThan(groupShots(links, 0.05).length);
  });
});
