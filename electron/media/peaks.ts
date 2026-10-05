/**
 * Pure waveform-peak helpers. NO Node / Electron imports — safe to copy into `shared/` for the renderer.
 */

/**
 * Downsample a peaks array (one max-abs sample per 1/rate seconds) to `buckets` values covering
 * [startSec, endSec). Each output bucket is the maximum of the source buckets it overlaps.
 * Regions outside the data (negative time, beyond the end) yield 0.
 */
export function downsamplePeaks(
  peaks: Uint8Array,
  rate: number,
  startSec: number,
  endSec: number,
  buckets: number,
): Uint8Array {
  const out = new Uint8Array(Math.max(0, Math.floor(buckets)));
  if (out.length === 0 || !(rate > 0) || !(endSec > startSec) || peaks.length === 0) return out;
  const span = endSec - startSec;
  const secPerBucket = span / out.length;
  for (let i = 0; i < out.length; i++) {
    const t0 = startSec + i * secPerBucket;
    const t1 = t0 + secPerBucket;
    let s0 = Math.floor(t0 * rate);
    let s1 = Math.ceil(t1 * rate);
    if (s1 <= s0) s1 = s0 + 1;
    if (s0 < 0) s0 = 0;
    if (s1 > peaks.length) s1 = peaks.length;
    let m = 0;
    for (let s = s0; s < s1; s++) {
      const v = peaks[s];
      if (v > m) m = v;
    }
    out[i] = m;
  }
  return out;
}

/** Fold a block of unsigned 8-bit PCM samples into a single peak (0..255, 128 = silence). */
export function peakOfU8(samples: Uint8Array, from = 0, to = samples.length): number {
  let m = 0;
  for (let i = from; i < to; i++) {
    const d = samples[i] - 128;
    const a = d < 0 ? -d : d;
    if (a > m) m = a;
  }
  // 0..128 → 0..255
  const v = m * 2;
  return v > 255 ? 255 : v;
}
