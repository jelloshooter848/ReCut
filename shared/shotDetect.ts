/**
 * Shot-cut detection (#149): a TypeScript port of PySceneDetect's ContentDetector frame score and AdaptiveDetector
 * cut rule. PySceneDetect calls these cuts "scenes"; here they are shots.
 *
 * Derived from PySceneDetect (https://github.com/Breakthrough/PySceneDetect), scenedetect/detectors/content_detector.py
 * and adaptive_detector.py. Copyright (C) 2014, Brandon Castellano. BSD 3-Clause License (see THIRD_PARTY_NOTICES.md).
 *
 * Pure: no DOM, no Node. The main process decodes small RGB frames with FFmpeg and feeds them here.
 */

/** Frame size the detector analyses (FFmpeg scales every frame to this; aspect does not matter for the score). */
export const SHOT_ANALYSIS_WIDTH = 256;
export const SHOT_ANALYSIS_HEIGHT = 144;

/** AdaptiveDetector defaults (PySceneDetect). */
export const ADAPTIVE_DEFAULTS = {
  /** A frame's score must be this many times its neighbours' average. */
  adaptiveThreshold: 3.0,
  /** Frames on each side of the candidate whose scores make the average. */
  windowWidth: 2,
  /** A frame's own score must reach this too (0..255 scale), so near-still footage never cuts on noise. */
  minContentVal: 15.0,
  /** Frames between cuts, at least. */
  minShotFrames: 15,
} as const;

export interface AdaptiveOptions {
  adaptiveThreshold: number;
  windowWidth: number;
  minContentVal: number;
  minShotFrames: number;
}

/** HSV planes of one frame, 8-bit, OpenCV convention: H 0..179, S and V 0..255. */
export interface HsvFrame { h: Uint8Array; s: Uint8Array; v: Uint8Array }

/** Packed RGB24 (FFmpeg `format=rgb24`) to HSV planes, matching OpenCV's 8-bit COLOR_BGR2HSV. */
export function rgbToHsv(rgb: Uint8Array, pixels: number, out?: HsvFrame): HsvFrame {
  const h = out?.h ?? new Uint8Array(pixels);
  const s = out?.s ?? new Uint8Array(pixels);
  const v = out?.v ?? new Uint8Array(pixels);
  for (let i = 0, p = 0; i < pixels; i++, p += 3) {
    const r = rgb[p], g = rgb[p + 1], b = rgb[p + 2];
    const max = r > g ? (r > b ? r : b) : (g > b ? g : b);
    const min = r < g ? (r < b ? r : b) : (g < b ? g : b);
    const diff = max - min;
    v[i] = max;
    s[i] = max === 0 ? 0 : Math.round((255 * diff) / max);
    if (diff === 0) { h[i] = 0; continue; }
    let hue: number;
    if (max === r) hue = (60 * (g - b)) / diff;
    else if (max === g) hue = 120 + (60 * (b - r)) / diff;
    else hue = 240 + (60 * (r - g)) / diff;
    if (hue < 0) hue += 360;
    const hh = Math.round(hue / 2);
    h[i] = hh >= 180 ? hh - 180 : hh;
  }
  return { h, s, v };
}

/** Mean absolute difference of two 8-bit planes (PySceneDetect `_mean_pixel_distance`; hue is not wrapped). */
export function meanPixelDistance(a: Uint8Array, b: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; sum += d < 0 ? -d : d; }
  return a.length ? sum / a.length : 0;
}

/**
 * ContentDetector frame score: the average of the hue, saturation and value changes from the previous frame (default
 * weights 1/1/1, edges 0). The first frame scores 0.
 */
export class ContentScorer {
  private prev: HsvFrame | null = null;
  private spare: HsvFrame | null = null;
  constructor(private readonly pixels: number) {}

  score(rgb: Uint8Array): number {
    const cur = rgbToHsv(rgb, this.pixels, this.spare ?? undefined);
    const prev = this.prev;
    this.spare = prev;
    this.prev = cur;
    if (!prev) return 0;
    return (meanPixelDistance(cur.h, prev.h) + meanPixelDistance(cur.s, prev.s) + meanPixelDistance(cur.v, prev.v)) / 3;
  }
}

/**
 * AdaptiveDetector cut rule over a stream of frame scores. A frame is a cut when its score is at least
 * `adaptiveThreshold` times the average of the `windowWidth` frames on each side, reaches `minContentVal`, and is at
 * least `minShotFrames` after the previous cut (or the first frame). Decisions lag `windowWidth` frames: push() returns
 * the index of a cut frame once it can be decided.
 */
export class AdaptiveCutter {
  private readonly opts: AdaptiveOptions;
  private buf: { index: number; score: number }[] = [];
  private lastCut: number | null = null;
  constructor(opts: Partial<AdaptiveOptions> = {}) {
    this.opts = { ...ADAPTIVE_DEFAULTS, ...opts };
    if (this.opts.windowWidth < 1) throw new Error('windowWidth must be at least 1');
  }

  push(index: number, score: number): number | null {
    const { windowWidth: w, adaptiveThreshold, minContentVal, minShotFrames } = this.opts;
    if (this.lastCut === null) this.lastCut = index;
    const need = 1 + 2 * w;
    this.buf.push({ index, score });
    if (this.buf.length < need) return null;
    if (this.buf.length > need) this.buf.shift();
    const target = this.buf[w];
    let sum = 0;
    for (let i = 0; i < need; i++) if (i !== w) sum += this.buf[i].score;
    const avg = sum / (2 * w);
    let ratio = 0;
    if (Math.abs(avg) >= 0.00001) ratio = Math.min(target.score / avg, 255);
    else if (target.score >= minContentVal) ratio = 255;
    const thresholdMet = ratio >= adaptiveThreshold && target.score >= minContentVal;
    if (thresholdMet && target.index - this.lastCut >= minShotFrames) {
      this.lastCut = target.index;
      return target.index;
    }
    return null;
  }
}

/** Cut frame indices for a whole score series (score[i] = change from frame i-1 to frame i). */
export function adaptiveCuts(scores: ArrayLike<number>, opts: Partial<AdaptiveOptions> = {}): number[] {
  const cutter = new AdaptiveCutter(opts);
  const cuts: number[] = [];
  for (let i = 0; i < scores.length; i++) { const c = cutter.push(i, scores[i]); if (c !== null) cuts.push(c); }
  return cuts;
}

/**
 * The project's shot threshold setting (0..1, "higher detects fewer, stronger cuts"; default 0.35) as the adaptive
 * ratio: 0.35 gives PySceneDetect's default 3.0.
 */
export function adaptiveThresholdFor(setting: number): number {
  const t = Number.isFinite(setting) ? Math.min(1, Math.max(0, setting)) : 0.35;
  return Math.max(1.2, (t * 3.0) / 0.35);
}
