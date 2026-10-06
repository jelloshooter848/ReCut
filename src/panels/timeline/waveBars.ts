/**
 * Timeline waveform bars. Pure (no DOM): unit-tested in tests/unit/timeline-waveBars.test.ts.
 *
 * Deliberate rendering trade-off (roadmap §1, A4; see docs/attack/performance.md): a clip's waveform is drawn as
 * filled, device-pixel-aligned bars, one per device pixel column, with fillRect on integer coordinates (adjacent
 * columns of the same extent merged into one rect), instead of one anti-aliased path of fractional 1 px rects. It
 * paints cheaper while the timeline scrubs / plays, and the bar ends are snapped to whole device pixels rather than
 * anti-aliased.
 *
 * What stays exact:
 * - Each column's peak is the maximum of ALL waveform samples that overlap the column (peaksForRange; a sample on a
 *   column boundary counts for both columns), never a decimated sample, so a short transient (one sample) always
 *   shows at its full height in the column(s) it falls in.
 * - The peaks are absolute values (WaveformData), so the bar of a column spans -peak..+peak around the centre: it
 *   covers the min..max of every sample in the column.
 * - Bars stay inside the canvas (rows 0..heightDev) and every column gets a bar of at least 1 device pixel.
 * - Bar ends are rounded to the nearest device row (error <= 0.5 device px), symmetric about the centre line.
 */

/** A device pixel ratio usable for sizing: finite and > 0, else 1. */
export function validDpr(dpr: number): number {
  return dpr > 0 && Number.isFinite(dpr) ? dpr : 1;
}

/**
 * Backing store size (device px) of a canvas for a CSS box, and the CSS size that maps it 1:1 onto device pixels
 * (the CSS width is the device width / dpr, so columns land on device pixels without resampling).
 */
export function waveCanvasSize(cssW: number, cssH: number, dpr: number): { w: number; h: number; cssW: number; cssH: number } {
  const d = validDpr(dpr);
  const w = Math.max(1, Math.round(Math.max(0, cssW) * d));
  const h = Math.max(1, Math.round(Math.max(0, cssH) * d));
  return { w, h, cssW: w / d, cssH: h / d };
}

/**
 * Half height (device px) of a column's bar before snapping: the peak (0..255) scaled to the half height of the
 * canvas by `gain`, at least `minHalf`, at most the half height.
 */
export function waveHalfHeight(peak: number, heightDev: number, gain: number, minHalf: number): number {
  const mid = heightDev / 2;
  const v = (peak / 255) * mid * (gain > 0 && Number.isFinite(gain) ? gain : 0);
  return Math.max(0, Math.min(mid, Math.max(minHalf, v)));
}

/** Writes the snapped rows of a column (see waveBarRows) to out[k], out[k + 1]. */
function snapRows(halfDev: number, H: number, out: Int32Array, k: number): void {
  let top = Math.round(H / 2 - halfDev);
  if (top < 0) top = 0;
  let bottom = H - top;
  if (bottom - top < 1) { top = Math.floor(H / 2); bottom = top + 1; }
  out[k] = top;
  out[k + 1] = bottom;
}

/**
 * Snapped bar of one column: device rows [top, bottom). Symmetric about the centre (bottom = heightDev - top) where
 * the rounded extent allows it; a bar that would round to nothing becomes the single centre row
 * [floor(heightDev / 2), +1) (the row the clip's centre line sits on).
 */
export function waveBarRows(halfDev: number, heightDev: number): [number, number] {
  const r = new Int32Array(2);
  snapRows(halfDev, Math.max(1, Math.round(heightDev)), r, 0);
  return [r[0], r[1]];
}

/**
 * Bars of all columns: out[2 * i] = top row, out[2 * i + 1] = bottom row (exclusive) of column i. `minHalf` is the
 * smallest half height (device px) drawn for any column (the silent baseline).
 */
export function waveBarExtents(peaks: ArrayLike<number>, heightDev: number, gain: number, minHalf: number, out?: Int32Array): Int32Array {
  const n = peaks.length;
  const H = Math.max(1, Math.round(heightDev));
  const ext = out && out.length >= n * 2 ? out : new Int32Array(n * 2);
  for (let i = 0; i < n; i++) snapRows(waveHalfHeight(peaks[i], H, gain, minHalf), H, ext, 2 * i);
  return ext;
}

/** The subset of CanvasRenderingContext2D the drawing needs. */
export interface WaveTarget {
  fillRect(x: number, y: number, w: number, h: number): void;
}

/**
 * Fills the bars (device px, identity transform expected): one rect per run of adjacent columns with the same
 * extent, pixel-identical to one 1 px wide rect per column (integer coordinates, no overlap). Returns the rect count.
 */
export function drawWaveBars(ctx: WaveTarget, ext: Int32Array, n: number): number {
  let count = 0;
  let i = 0;
  while (i < n) {
    const t = ext[2 * i], b = ext[2 * i + 1];
    let j = i + 1;
    while (j < n && ext[2 * j] === t && ext[2 * j + 1] === b) j++;
    ctx.fillRect(i, t, j - i, b - t);
    count++;
    i = j;
  }
  return count;
}
