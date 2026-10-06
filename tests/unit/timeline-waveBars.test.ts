/**
 * Timeline waveform bars (src/panels/timeline/waveBars.ts): the deliberate A4 rendering trade-off (filled
 * device-pixel bars instead of an anti-aliased path) must keep the waveform's information exact: every sample in a
 * column counts (no decimation), short transients keep their full height, bars stay inside the canvas at every
 * device pixel ratio, and the merged fillRects cover exactly the per-column bars.
 */
import { describe, it, expect } from 'vitest';
import type { WaveformData } from '../../shared/ipc';
import { peaksForRange } from '../../src/playback/thumbnails';
import { drawWaveBars, validDpr, waveBarExtents, waveBarRows, waveCanvasSize, waveHalfHeight } from '../../src/panels/timeline/waveBars';

const DPRS = [1, 1.25, 1.5, 2, 3];

let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

function wave(rate: number, values: number[]): WaveformData {
  return { rate, peaks: Uint8Array.from(values), duration: values.length / rate };
}

/** Max over every sample whose interval [i / rate, (i + 1) / rate) overlaps [t0, t1). */
function bruteColumnMax(w: WaveformData, t0: number, t1: number): number {
  let m = 0;
  for (let i = 0; i < w.peaks.length; i++) if (i / w.rate < t1 && (i + 1) / w.rate > t0) m = Math.max(m, w.peaks[i]);
  return m;
}

/** Rasterises fillRect calls into a coverage grid (integer rects only, as the bars use). */
function grid(w: number, h: number) {
  const px = new Uint8Array(w * h);
  const calls: number[][] = [];
  const bad: number[][] = [];
  return {
    px, calls, bad,
    fillRect(x: number, y: number, rw: number, rh: number) {
      calls.push([x, y, rw, rh]);
      if (![x, y, rw, rh].every(Number.isInteger) || x < 0 || y < 0 || rw < 1 || rh < 1 || x + rw > w || y + rh > h) bad.push([x, y, rw, rh]);
      for (let yy = Math.max(0, y); yy < Math.min(h, y + rh); yy++) for (let xx = Math.max(0, x); xx < Math.min(w, x + rw); xx++) px[yy * w + xx]++;
    },
  };
}

describe('waveform columns: min..max of all samples per pixel column', () => {
  it('each column peak covers every sample overlapping the column (no decimation), at many zooms', () => {
    for (let trial = 0; trial < 60; trial++) {
      const rate = [50, 100, 200, 441][trial % 4];
      const n = 200 + Math.floor(rnd() * 800);
      const w = wave(rate, Array.from({ length: n }, () => Math.floor(rnd() * 256)));
      const cols = 5 + Math.floor(rnd() * 400);
      const t0 = rnd() * w.duration * 0.5;
      const t1 = t0 + (0.01 + rnd()) * (w.duration - t0);
      const peaks = peaksForRange(w, t0, t1, cols);
      const span = (t1 - t0) / cols;
      for (let c = 0; c < cols; c++) {
        const a = t0 + c * span, b = a + span;
        // The column's peak is at least the max of every sample in it: it never under-represents a peak.
        expect(peaks[c]).toBeGreaterThanOrEqual(bruteColumnMax(w, a, b));
        // ... and at most the max of the column widened by one sample (boundary samples count for both columns).
        expect(peaks[c]).toBeLessThanOrEqual(bruteColumnMax(w, a - 1 / rate, b + 1 / rate));
      }
    }
  });

  it('the bar of a column spans -peak..+peak around the centre (covers the min..max of its samples)', () => {
    for (const H of [9, 10, 26, 27, 44, 88]) {
      for (let p = 0; p <= 255; p += 5) {
        for (const gain of [0.5, 1, 1.7]) {
          const half = waveHalfHeight(p, H, gain, 0);
          const [top, bottom] = waveBarRows(half, H);
          const trueTop = H / 2 - half, trueBottom = H / 2 + half;
          // Bar ends are the true extent rounded to the nearest device row.
          expect(Math.abs(top - trueTop)).toBeLessThanOrEqual(0.5 + 1e-9);
          if (bottom - top > 1) expect(Math.abs(bottom - trueBottom)).toBeLessThanOrEqual(0.5 + 1e-9);
          // Symmetric about the centre whenever it has more than one row.
          if (bottom - top > 1) expect(top + bottom).toBe(H);
          expect(bottom - top).toBeGreaterThanOrEqual(1);
        }
      }
    }
  });
});

describe('waveform transients', () => {
  it('a single-sample spike shows at full height in its column at every zoom and dpr', () => {
    const rate = 100;
    for (const dpr of DPRS) {
      for (const samplesPerCssPx of [0.05, 0.3, 1, 3, 17, 120, 1000]) {
        const n = 4000;
        const values = new Array(n).fill(0);
        const spikeAt = 2321;
        values[spikeAt] = 255;
        const w = wave(rate, values);
        const cssW = 300;
        const { w: cols, h: H, cssW: boxW } = waveCanvasSize(cssW, 26, dpr);
        // Put the spike inside the canvas's time range.
        const secPerCssPx = samplesPerCssPx / rate;
        const t0 = Math.max(0, spikeAt / rate - secPerCssPx * boxW * 0.37);
        const t1 = t0 + secPerCssPx * boxW;
        const peaks = peaksForRange(w, t0, t1, cols);
        const ext = waveBarExtents(peaks, H, 1, 0.5 * dpr);
        const span = (t1 - t0) / cols;
        // Every column the spike sample overlaps shows it at full height (top row 0, bottom row H).
        let hit = 0;
        for (let c = 0; c < cols; c++) {
          const a = t0 + c * span, b = a + span;
          if (spikeAt / rate < b && (spikeAt + 1) / rate > a) { hit++; expect(ext[2 * c]).toBe(0); expect(ext[2 * c + 1]).toBe(H); }
        }
        expect(hit).toBeGreaterThanOrEqual(1);
        // Columns away from the spike stay at the silent baseline (>= 1 device px, <= 1 CSS px + rounding).
        for (let c = 0; c < cols; c++) {
          const a = t0 + c * span, b = a + span;
          if (b < spikeAt / rate - 1 / rate || a > (spikeAt + 2) / rate) {
            const h = ext[2 * c + 1] - ext[2 * c];
            expect(h).toBeGreaterThanOrEqual(1);
            expect(h).toBeLessThanOrEqual(Math.ceil(dpr) + 1);
          }
        }
      }
    }
  });

  it('a quiet single-sample transient still produces a bar of at least 1 device pixel', () => {
    for (const dpr of DPRS) {
      const { w: cols, h: H } = waveCanvasSize(120, 27, dpr);
      const values = new Array(1000).fill(0); values[500] = 1;
      const peaks = peaksForRange(wave(100, values), 0, 10, cols);
      const ext = waveBarExtents(peaks, H, 1, 0);
      for (let c = 0; c < cols; c++) expect(ext[2 * c + 1] - ext[2 * c]).toBeGreaterThanOrEqual(1);
    }
  });

  it('louder samples never draw a shorter bar (monotone in the peak)', () => {
    for (const dpr of DPRS) {
      const H = Math.round(26 * dpr);
      let prev = 0;
      for (let p = 0; p <= 255; p++) {
        const [t, b] = waveBarRows(waveHalfHeight(p, H, 1.3, 0.5 * dpr), H);
        expect(b - t).toBeGreaterThanOrEqual(prev);
        prev = b - t;
      }
    }
  });
});

describe('waveform bounds at every device pixel ratio', () => {
  it('canvas backing size is the CSS box times dpr, and its CSS size maps it 1:1 onto device pixels', () => {
    for (const dpr of DPRS) {
      for (const css of [0, 0.4, 1, 39.5, 40, 255.75, 256, 1000.3, 4096]) {
        const s = waveCanvasSize(css, 26, dpr);
        expect(s.w).toBe(Math.max(1, Math.round(css * dpr)));
        expect(s.h).toBe(Math.round(26 * dpr));
        expect(Number.isInteger(s.w) && Number.isInteger(s.h)).toBe(true);
        // CSS width * dpr is exactly the backing width: columns sit on device pixels, no resampling.
        expect(Math.abs(s.cssW * dpr - s.w)).toBeLessThan(1e-9);
        expect(Math.abs(s.cssH * dpr - s.h)).toBeLessThan(1e-9);
        // The box stays within half a device pixel of the requested CSS size.
        if (css * dpr >= 1) expect(Math.abs(s.cssW - css)).toBeLessThanOrEqual(0.5 / dpr + 1e-9);
      }
    }
  });

  it('bars stay inside the canvas, integer, non-empty, for any peak, gain and height', () => {
    for (const dpr of DPRS) {
      for (const cssH of [4, 9, 10, 26, 27, 60, 133]) {
        const H = waveCanvasSize(10, cssH, dpr).h;
        const peaks = Uint8Array.from({ length: 256 }, (_, i) => i);
        for (const gain of [0, 0.25, 1, 6, 12, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
          const ext = waveBarExtents(peaks, H, gain, 0.5 * dpr);
          const bad: number[] = [];
          for (let c = 0; c < peaks.length; c++) {
            const t = ext[2 * c], b = ext[2 * c + 1];
            if (!(Number.isInteger(t) && Number.isInteger(b) && t >= 0 && b <= H && b - t >= 1)) bad.push(c);
          }
          expect(bad, `dpr ${dpr} H ${H} gain ${gain}`).toEqual([]);
        }
      }
    }
  });

  it('a full-scale peak fills the canvas height exactly; the silent baseline is 1 CSS px (>= 1 device px) on the centre row', () => {
    for (const dpr of DPRS) {
      const H = waveCanvasSize(10, 26, dpr).h;
      expect(waveBarRows(waveHalfHeight(255, H, 1, 0.5 * dpr), H)).toEqual([0, H]);
      const [t, b] = waveBarRows(waveHalfHeight(0, H, 1, 0.5 * dpr), H);
      expect(b - t).toBeGreaterThanOrEqual(1);
      expect(b - t).toBeLessThanOrEqual(Math.max(1, Math.round(dpr)) + 1);
      expect(t <= Math.floor(H / 2) && Math.floor(H / 2) < b).toBe(true);
    }
  });

  it('validDpr falls back to 1 for unusable ratios', () => {
    expect(validDpr(0)).toBe(1);
    expect(validDpr(-2)).toBe(1);
    expect(validDpr(Number.NaN)).toBe(1);
    expect(validDpr(Number.POSITIVE_INFINITY)).toBe(1);
    expect(validDpr(1.5)).toBe(1.5);
  });
});

describe('drawWaveBars', () => {
  it('merged fillRects cover exactly one bar per column (pixel-identical to a rect per column)', () => {
    for (const dpr of DPRS) {
      const { w: cols, h: H } = waveCanvasSize(180, 27, dpr);
      // Runs of equal peaks (merged) mixed with noise.
      const peaks = Uint8Array.from({ length: cols }, (_, i) => (i % 40 < 15 ? 0 : i % 40 < 25 ? 200 : Math.floor(rnd() * 256)));
      const ext = waveBarExtents(peaks, H, 1, 0.5 * dpr);
      const g = grid(cols, H);
      const count = drawWaveBars(g, ext, cols);
      expect(count).toBe(g.calls.length);
      expect(count).toBeLessThan(cols);
      expect(g.bad).toEqual([]);
      const wrong: number[][] = [];
      for (let c = 0; c < cols; c++) {
        for (let y = 0; y < H; y++) if (g.px[y * cols + c] !== (y >= ext[2 * c] && y < ext[2 * c + 1] ? 1 : 0)) wrong.push([c, y]);
      }
      expect(wrong).toEqual([]);
    }
  });

  it('draws nothing for zero columns', () => {
    const g = grid(1, 1);
    expect(drawWaveBars(g, new Int32Array(0), 0)).toBe(0);
  });
});
