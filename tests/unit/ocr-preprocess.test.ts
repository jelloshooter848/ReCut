import { describe, expect, it } from 'vitest';
import {
  alphaBBox, compositeInvert, cropToInk, encodePgm, findBands, flipPolarity, prepareForOcr, sliceRows, upscaleYa8, type Gray8, type Ya8,
} from '../../electron/ocr/preprocess';

/** ya8 image with filled rectangles of (gray, alpha). */
function ya8(w: number, h: number, rects: { x: number; y: number; w: number; h: number; g: number; a: number }[]): Ya8 {
  const data = new Uint8Array(w * h * 2);
  for (const r of rects) {
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) { data[(y * w + x) * 2] = r.g; data[(y * w + x) * 2 + 1] = r.a; }
  }
  return { width: w, height: h, data };
}

const px = (g: Gray8, x: number, y: number) => g.data[y * g.width + x];

describe('preprocess', () => {
  it('alpha bounding box ignores faint alpha and returns null when transparent', () => {
    const im = ya8(50, 40, [{ x: 10, y: 5, w: 20, h: 8, g: 255, a: 255 }, { x: 0, y: 0, w: 3, h: 3, g: 255, a: 4 }]);
    expect(alphaBBox(im)).toEqual({ x: 10, y: 5, width: 20, height: 8 });
    expect(alphaBBox(ya8(10, 10, []))).toBeNull();
  });

  it('crops to the ink with a transparent margin, even past the source edges', () => {
    const im = ya8(50, 40, [{ x: 2, y: 30, w: 20, h: 8, g: 255, a: 255 }]);
    const c = cropToInk(im, 12)!;
    expect([c.width, c.height]).toEqual([44, 32]);
    expect(c.data[1]).toBe(0); // corner transparent
    expect(c.data[(12 * 44 + 12) * 2 + 1]).toBe(255); // ink starts at the pad
    expect(cropToInk(ya8(5, 5, []))).toBeNull();
  });

  it('composites on black and inverts: white text → black, black border and background → white', () => {
    const im = ya8(30, 10, [
      { x: 0, y: 0, w: 10, h: 10, g: 255, a: 255 }, // text
      { x: 10, y: 0, w: 10, h: 10, g: 0, a: 255 }, // border
      { x: 20, y: 0, w: 10, h: 10, g: 255, a: 128 }, // half-transparent white
    ]);
    const g = compositeInvert(im);
    expect([px(g, 5, 5), px(g, 15, 5), px(g, 25, 5)]).toEqual([0, 255, 127]);
    expect(flipPolarity(g).data[5]).toBe(255);
  });

  it('splits bands at >= 8 empty rows and keeps a margin', () => {
    // inverted gray: white page, two dark lines 3 rows apart (one band), then a sign 20 rows above
    const w = 40, h = 100;
    const d = new Uint8Array(w * h).fill(255);
    const ink = (y0: number, y1: number) => { for (let y = y0; y < y1; y++) for (let x = 5; x < 35; x++) d[y * w + x] = 0; };
    ink(10, 20); // sign
    ink(40, 50); // dialogue line 1
    ink(53, 63); // dialogue line 2 (3-row gap: same band)
    const bands = findBands({ width: w, height: h, data: d }, 8, 12);
    expect(bands).toEqual([{ y0: 0, y1: 30 }, { y0: 30, y1: 75 }]);
    // gap of exactly 7 rows does not split
    const d2 = new Uint8Array(w * 40).fill(255);
    for (const [a, b] of [[5, 10], [17, 22]]) for (let y = a; y < b; y++) d2[y * w + 1] = 0;
    expect(findBands({ width: w, height: 40, data: d2 }, 8, 12)).toHaveLength(1);
    expect(findBands({ width: w, height: 10, data: new Uint8Array(w * 10).fill(255) })).toEqual([]);
  });

  it('upscales ya8 bilinearly by an integer factor', () => {
    const im: Ya8 = { width: 2, height: 1, data: Uint8Array.from([0, 0, 200, 255]) };
    const up = upscaleYa8(im, 2);
    expect([up.width, up.height]).toEqual([4, 2]);
    // columns map to source x = -0.25 (clamped 0), 0.25, 0.75, 1.25 (clamped 1)
    expect(Array.from(up.data.subarray(0, 8))).toEqual([0, 0, 50, 64, 150, 191, 200, 255]);
    expect(Array.from(up.data.subarray(8))).toEqual(Array.from(up.data.subarray(0, 8)));
    expect(upscaleYa8(im, 1)).toBe(im);
    // a solid block stays solid and keeps its proportions
    const blk = upscaleYa8(ya8(10, 6, [{ x: 0, y: 0, w: 10, h: 6, g: 255, a: 255 }]), 3);
    expect([blk.width, blk.height, Math.min(...blk.data), Math.max(...blk.data)]).toEqual([30, 18, 255, 255]);
  });

  it('encodes PGM P5', () => {
    const g: Gray8 = { width: 3, height: 2, data: Uint8Array.from([0, 128, 255, 1, 2, 3]) };
    const pgm = encodePgm(g);
    const header = 'P5\n3 2\n255\n';
    expect(new TextDecoder().decode(pgm.subarray(0, header.length))).toBe(header);
    expect(Array.from(pgm.subarray(header.length))).toEqual([0, 128, 255, 1, 2, 3]);
    expect(sliceRows(g, 1, 2).data).toEqual(Uint8Array.from([1, 2, 3]));
  });

  it('prepareForOcr: a top sign and bottom dialogue become two black-on-white bands', () => {
    const im = ya8(400, 300, [
      { x: 150, y: 20, w: 100, h: 20, g: 255, a: 255 },
      { x: 50, y: 240, w: 300, h: 30, g: 255, a: 255 },
      { x: 48, y: 238, w: 2, h: 34, g: 0, a: 255 }, // black border: becomes white, still counts for the crop
    ]);
    const bands = prepareForOcr(im);
    expect(bands).toHaveLength(2);
    const [top, bottom] = bands;
    expect(top.width).toBe(302 + 24);
    expect(top.y).toBe(0);
    expect(top.height).toBe(12 + 20 + 12);
    expect(px(top, 150 - 48 + 12 + 5, 12 + 5)).toBe(0);
    expect(px(top, 0, 0)).toBe(255);
    // crop rows: 20 - 12 .. 271 + 12 (276 rows); the text ends at crop row 262 (the border is white after inversion),
    // and the band keeps a 12-row margin below it
    expect(bottom.y + bottom.height).toBe(262 + 12);
    expect(bottom.height + bottom.y).toBeLessThanOrEqual(276);
    expect(new TextDecoder().decode(bottom.pgm.subarray(0, 2))).toBe('P5');
    expect(prepareForOcr(ya8(10, 10, []))).toEqual([]);
  });
});
