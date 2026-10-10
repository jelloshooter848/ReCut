/**
 * Suggested scenes (#147): group a media item's shots into scenes from offline signals at each cut.
 *
 * - Speech: a line that runs across the cut, or lines on both sides with a short gap, is one conversation.
 * - Picture: the shot after the cut looks like one of the few shots before it (colour histograms), so the same
 *   location and lighting; comparing with the last three shots keeps shot / reverse-shot dialogue together.
 * - Sound: the level carries on across the cut (room tone, music); silence on both sides is a break.
 *
 * Each available signal scores the cut 0..1 (1 = same scene); the weighted mean links the shots when it reaches the
 * threshold. Pure: no DOM, no Node. The renderer gathers the histograms and audio peaks.
 */
import type { ID } from './model';

export interface ShotSpan { id: ID; start: number; end: number }
export interface SpeechCue { start: number; end: number }
export interface AudioPeaks { rate: number; peaks: ArrayLike<number> }

export interface SuggestInputs {
  shots: readonly ShotSpan[];
  cues?: readonly SpeechCue[] | null;
  /** One colour histogram per shot (histogramFromRgba), or null where none could be read. */
  hists?: readonly (ArrayLike<number> | null)[] | null;
  audio?: AudioPeaks | null;
  /** Sound scores per cut already worked out (audioLink, in the main process); used instead of `audio`. */
  audioLinks?: readonly (number | null)[] | null;
}

/** Scores of one cut (between shot i and i+1): null where the signal has nothing to say. */
export interface CutLink { speech: number | null; visual: number | null; audio: number | null; score: number }

const WEIGHTS = { speech: 0.5, visual: 0.35, audio: 0.15 };
/** Default link threshold: a cut whose score reaches it joins the shots into one scene. */
export const SUGGEST_THRESHOLD = 0.5;
/** Shots before the cut the next shot is compared with (shot / reverse-shot). */
const VISUAL_LOOKBACK = 3;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Speech across the cut at `b`: 1 when a line spans it; else by the gap between the lines either side; null if neither side speaks. */
export function speechLink(cues: readonly SpeechCue[], b: number): number | null {
  const EPS = 0.05, NEAR = 3;
  let before = -Infinity, after = Infinity;
  for (const c of cues) {
    if (c.start < b - EPS && c.end > b + EPS) return 1;
    if (c.end <= b + EPS && c.end > b - NEAR) before = Math.max(before, c.end);
    if (c.start >= b - EPS && c.start < b + NEAR) after = Math.min(after, c.start);
  }
  if (before === -Infinity && after === Infinity) return null;
  if (before === -Infinity || after === Infinity) return 0;
  const gap = after - before;
  return gap <= 0.6 ? 0.9 : gap <= 1.5 ? 0.6 : gap <= 3 ? 0.3 : 0;
}

/** Histogram intersection of two normalised histograms: 1 = same colours, 0 = none shared. */
export function histSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += Math.min(a[i], b[i]);
  return s;
}

function meanLevel(audio: AudioPeaks, from: number, to: number): number | null {
  const a = Math.max(0, Math.floor(from * audio.rate)), z = Math.min(audio.peaks.length, Math.ceil(to * audio.rate));
  if (z <= a) return null;
  let s = 0;
  for (let i = a; i < z; i++) s += audio.peaks[i];
  return s / (z - a);
}

/** Sound across the cut: silence on both sides 0, else how alike the levels are just before and after. */
export function audioLink(audio: AudioPeaks, b: number): number | null {
  const l = meanLevel(audio, b - 0.75, b - 0.1), r = meanLevel(audio, b + 0.1, b + 0.75);
  if (l === null || r === null) return null;
  const QUIET = 8; // of 255: about -30 dB
  if (l < QUIET && r < QUIET) return 0;
  return clamp01(1 - Math.abs(l - r) / Math.max(l, r, 1));
}

/** Link scores of every cut, in order (shots.length - 1 entries). */
export function cutLinks(inp: SuggestInputs): CutLink[] {
  const { shots } = inp;
  const out: CutLink[] = [];
  for (let i = 0; i < shots.length - 1; i++) {
    const b = shots[i + 1].start;
    const speech = inp.cues?.length ? speechLink(inp.cues, b) : null;
    let visual: number | null = null;
    const next = inp.hists?.[i + 1];
    if (next) {
      let best = -1;
      for (let k = i; k >= 0 && k > i - VISUAL_LOOKBACK; k--) { const h = inp.hists?.[k]; if (h) best = Math.max(best, histSimilarity(h, next)); }
      if (best >= 0) visual = clamp01((best - 0.45) / 0.4);
    }
    const audio = inp.audioLinks ? inp.audioLinks[i] ?? null : inp.audio ? audioLink(inp.audio, b) : null;
    let sum = 0, w = 0;
    if (speech !== null) { sum += WEIGHTS.speech * speech; w += WEIGHTS.speech; }
    if (visual !== null) { sum += WEIGHTS.visual * visual; w += WEIGHTS.visual; }
    if (audio !== null) { sum += WEIGHTS.audio * audio; w += WEIGHTS.audio; }
    let score = w ? sum / w : 0;
    // A line running across the cut is one conversation whatever the picture does.
    if (speech !== null && speech >= 0.9) score = Math.max(score, 0.6);
    out.push({ speech, visual, audio, score });
  }
  return out;
}

/** Shot indices grouped into scenes: consecutive shots whose cut scores at least `threshold`. */
export function groupShots(links: readonly CutLink[], threshold = SUGGEST_THRESHOLD): number[][] {
  const groups: number[][] = [[0]];
  for (let i = 0; i < links.length; i++) {
    if (links[i].score >= threshold) groups[groups.length - 1].push(i + 1);
    else groups.push([i + 1]);
  }
  return groups;
}

/** Hue bins (saturated pixels) and value bins (all pixels) of histogramFromRgba. */
const HUE_BINS = 18, VAL_BINS = 8;

/**
 * Colour histogram of an RGBA image (canvas ImageData), or packed RGB with `channels` 3 (FFmpeg rgb24): hue of the
 * saturated pixels and brightness of all pixels,
 * normalised to sum 1, so histSimilarity compares location and lighting rather than detail.
 */
export function histogramFromRgba(px: ArrayLike<number>, channels: 3 | 4 = 4): Float32Array {
  const h = new Float32Array(HUE_BINS + VAL_BINS);
  const n = Math.floor(px.length / channels);
  if (!n) return h;
  for (let i = 0; i < n; i++) {
    const r = px[i * channels], g = px[i * channels + 1], b = px[i * channels + 2];
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    // Soft binning: a pixel is shared between its two nearest bins, so near-identical colours do not fall apart
    // at a bin edge.
    const v = (max / 255) * (VAL_BINS - 1), vl = Math.min(VAL_BINS - 2, Math.floor(v)), vf = v - vl;
    h[HUE_BINS + vl] += 1 - vf; h[HUE_BINS + vl + 1] += vf;
    if (max === 0 || d / max < 0.2 || d < 12) continue;
    let hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    if (hue < 0) hue += 6;
    const hp = (hue / 6) * HUE_BINS - 0.5, hl = Math.floor(hp), hf = hp - hl;
    h[(hl + HUE_BINS) % HUE_BINS] += 1 - hf; h[(hl + 1) % HUE_BINS] += hf;
  }
  let total = 0;
  for (let i = 0; i < h.length; i++) total += h[i];
  for (let i = 0; i < h.length; i++) h[i] /= total;
  return h;
}

/** Average of several histograms (frames of one shot); null when there are none. */
export function meanHistogram(list: readonly ArrayLike<number>[]): Float32Array | null {
  if (!list.length) return null;
  const out = new Float32Array(list[0].length);
  for (const h of list) for (let i = 0; i < out.length; i++) out[i] += h[i] / list.length;
  return out;
}
