/**
 * Pure timeline view math. No DOM, no store: everything here is unit-testable.
 *
 * Coordinates: `zoom` is pixels per frame (float), `scroll` is the first visible frame (float).
 * x = (frame - scroll) * zoom.
 */
import type { Rational } from '../../../shared/model';
import { formatTimecode, fpsValue } from '../../../shared/time';

export const MIN_ZOOM = 0.01;
export const MAX_ZOOM = 50;
/** Pixels within which an edge/snap target grabs the pointer. */
export const EDGE_PX = 6;
export const SNAP_PX = 8;

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export function frameToX(frame: number, zoom: number, scroll: number): number {
  return (frame - scroll) * zoom;
}

/** Fractional frame under a pixel offset. */
export function xToFrame(x: number, zoom: number, scroll: number): number {
  return scroll + x / zoom;
}

/** Integer frame under a pixel offset, clamped to >= 0. */
export function xToFrameInt(x: number, zoom: number, scroll: number): number {
  return Math.max(0, Math.round(xToFrame(x, zoom, scroll)));
}

export function visibleFrames(widthPx: number, zoom: number): number {
  return widthPx / zoom;
}

/** Zoom that fits `durationFrames` into `widthPx` with a little breathing room on the right. */
export function zoomToFit(durationFrames: number, widthPx: number, padding = 0.04): number {
  const usable = Math.max(1, widthPx * (1 - padding));
  return clampZoom(usable / Math.max(1, durationFrames));
}

/** Change zoom keeping the frame under `anchorX` (px from the left edge of the view) stationary. */
export function zoomAround(zoom: number, scroll: number, anchorX: number, newZoom: number): { zoom: number; scroll: number } {
  const z = clampZoom(newZoom);
  const anchorFrame = xToFrame(anchorX, zoom, scroll);
  return { zoom: z, scroll: Math.max(0, anchorFrame - anchorX / z) };
}

export function zoomByFactor(zoom: number, scroll: number, anchorX: number, factor: number) {
  return zoomAround(zoom, scroll, anchorX, zoom * factor);
}

/** Logarithmic slider mapping 0..1 <-> MIN_ZOOM..MAX_ZOOM. */
export function zoomToSlider(zoom: number): number {
  const lo = Math.log(MIN_ZOOM), hi = Math.log(MAX_ZOOM);
  return (Math.log(clampZoom(zoom)) - lo) / (hi - lo);
}
export function sliderToZoom(t: number): number {
  const lo = Math.log(MIN_ZOOM), hi = Math.log(MAX_ZOOM);
  return clampZoom(Math.exp(lo + Math.min(1, Math.max(0, t)) * (hi - lo)));
}

// ------------------------------------------------------------------
// Ruler
// ------------------------------------------------------------------

export interface RulerSpacing { major: number; minor: number }

const NICE_FRAME_DIVISORS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 30];
const NICE_SECONDS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];

/** Candidate tick intervals in frames, ascending: sub-second divisors of the frame rate, then nice second counts. */
export function tickCandidates(fps: Rational): number[] {
  const nominal = Math.max(1, Math.round(fpsValue(fps)));
  const frames = NICE_FRAME_DIVISORS.filter((d) => d < nominal && nominal % d === 0);
  return [...frames, ...NICE_SECONDS.map((s) => s * nominal)];
}

/**
 * Pick a major (labelled) interval so labels are at least `minMajorPx` apart, and a minor tick interval of
 * at least `minMinorPx` (0 when even single frames would be denser than that).
 */
export function rulerSpacing(fps: Rational, zoom: number, minMajorPx = 80, minMinorPx = 5): RulerSpacing {
  const cands = tickCandidates(fps);
  let major = cands[cands.length - 1];
  for (const c of cands) { if (c * zoom >= minMajorPx) { major = c; break; } }
  if (major * zoom < minMajorPx) {
    // beyond the table: multiples of hours
    const nominal = Math.max(1, Math.round(fpsValue(fps)));
    let h = 3600 * nominal;
    while (h * zoom < minMajorPx) h *= 2;
    major = h;
  }
  // Minor ticks: the finest interval of the same domain (frames when the major is sub-second, whole seconds
  // otherwise) that still leaves `minMinorPx` between ticks and divides the major evenly.
  const nominal = Math.max(1, Math.round(fpsValue(fps)));
  let minor = 0;
  for (const c of cands) {
    if (c >= major) break;
    if (major > nominal && c < nominal) continue;
    if (c * zoom >= minMinorPx && major % c === 0) { minor = c; break; }
  }
  return { major, minor };
}

export interface RulerTick { frame: number; x: number; label?: string; major: boolean }

/** Ticks covering [scroll, scroll + width/zoom]. Labels on majors as HH:MM:SS:FF. */
export function rulerTicks(fps: Rational, zoom: number, scroll: number, widthPx: number, minMajorPx = 80): RulerTick[] {
  const { major, minor } = rulerSpacing(fps, zoom, minMajorPx);
  const out: RulerTick[] = [];
  if (widthPx <= 0) return out;
  const first = Math.max(0, scroll);
  const last = scroll + widthPx / zoom;
  const step = minor > 0 ? minor : major;
  const start = Math.floor(first / step) * step;
  for (let f = start; f <= last; f += step) {
    if (f < 0) continue;
    const isMajor = f % major === 0;
    if (!isMajor && minor === 0) continue;
    out.push({ frame: f, x: frameToX(f, zoom, scroll), major: isMajor, label: isMajor ? formatTimecode(f, fps) : undefined });
  }
  return out;
}

// ------------------------------------------------------------------
// Snapping
// ------------------------------------------------------------------

export interface SnapResult { frame: number; snapped: boolean; target: number | null }

/** Snap `frame` to the nearest candidate within `threshold` frames. */
export function snapFrame(frame: number, candidates: ArrayLike<number>, threshold: number): SnapResult {
  let best: number | null = null; let bestDist = Infinity;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const d = Math.abs(c - frame);
    if (d <= threshold && d < bestDist) { best = c; bestDist = d; }
  }
  return best === null ? { frame, snapped: false, target: null } : { frame: best, snapped: true, target: best };
}

/**
 * Best common delta to add to every position so that at least one of them lands on a candidate.
 * Returns 0 when nothing is within `threshold`.
 */
export function snapDelta(positions: number[], candidates: ArrayLike<number>, threshold: number): { delta: number; target: number | null } {
  let bestDelta = 0; let bestDist = Infinity; let target: number | null = null;
  for (const p of positions) {
    const r = snapFrame(p, candidates, threshold);
    if (!r.snapped) continue;
    const d = Math.abs(r.frame - p);
    if (d < bestDist) { bestDist = d; bestDelta = r.frame - p; target = r.frame; }
  }
  return { delta: bestDelta, target };
}

export function snapThresholdFrames(zoom: number, px = SNAP_PX): number { return px / zoom; }

// ------------------------------------------------------------------
// Track layout
// ------------------------------------------------------------------

export interface TrackLayoutInput { id: string; height: number; kind: 'video' | 'audio' }
export interface TrackRow { id: string; kind: 'video' | 'audio'; top: number; height: number; /** index within its kind list (0 = V1/A1) */ index: number }
export interface TrackLayout { rows: TrackRow[]; total: number; dividerTop: number; subtitleLane: number }

export const TRACK_DIVIDER_PX = 6;
export const SUBTITLE_LANE_PX = 18;
export const MIN_TRACK_HEIGHT = 24;
export const MAX_TRACK_HEIGHT = 240;

/**
 * Premiere ordering: video tracks stacked with V1 nearest the divider (V3 on top), audio A1 just under the divider.
 * `heights` lets a live drag override a track height without touching the store.
 */
export function layoutTracks(
  video: TrackLayoutInput[], audio: TrackLayoutInput[],
  opts: { subtitleLane?: boolean; heights?: Record<string, number>; divider?: number } = {},
): TrackLayout {
  const divider = opts.divider ?? TRACK_DIVIDER_PX;
  const lane = opts.subtitleLane ? SUBTITLE_LANE_PX : 0;
  const h = (t: TrackLayoutInput) => Math.max(MIN_TRACK_HEIGHT, Math.min(MAX_TRACK_HEIGHT, Math.round(opts.heights?.[t.id] ?? t.height)));
  const rows: TrackRow[] = [];
  let y = lane;
  for (let i = video.length - 1; i >= 0; i--) {
    const t = video[i];
    rows.push({ id: t.id, kind: 'video', top: y, height: h(t), index: i });
    y += h(t);
  }
  const dividerTop = y;
  y += divider;
  audio.forEach((t, i) => { rows.push({ id: t.id, kind: 'audio', top: y, height: h(t), index: i }); y += h(t); });
  return { rows, total: y, dividerTop, subtitleLane: lane };
}

export function rowAtY(layout: TrackLayout, y: number): TrackRow | null {
  for (const r of layout.rows) if (y >= r.top && y < r.top + r.height) return r;
  return null;
}

// ------------------------------------------------------------------
// Misc
// ------------------------------------------------------------------

/** New scroll when the playhead leaves the view during playback (Premiere "page flip"); null when still visible. */
export function pageFlipScroll(playhead: number, scroll: number, visible: number): number | null {
  if (visible <= 0) return null;
  if (playhead >= scroll + visible) return playhead;
  if (playhead < scroll) return Math.max(0, playhead);
  return null;
}

/** Content width (frames) the horizontal scrollbar should expose. */
export function scrollContentFrames(durationFrames: number, scroll: number, visible: number): number {
  return Math.max(durationFrames + visible * 0.5, scroll + visible, visible);
}

/** Frame range [from, to) that needs rendering for a viewport, with a pixel margin. */
export function visibleRange(zoom: number, scroll: number, widthPx: number, marginPx = 200): { from: number; to: number } {
  return { from: Math.max(0, scroll - marginPx / zoom), to: scroll + (widthPx + marginPx) / zoom };
}

export function clipOverlaps(start: number, duration: number, from: number, to: number): boolean {
  return start < to && start + duration > from;
}

/** "+12 (00:00:00:12)" style delta label. */
export function formatDelta(frames: number, fps: Rational): string {
  const sign = frames > 0 ? '+' : frames < 0 ? '-' : '';
  return `${sign}${Math.abs(frames)} (${sign}${formatTimecode(Math.abs(frames), fps)})`;
}

export function linearToDb(v: number): number { return v <= 0 ? -Infinity : 20 * Math.log10(v); }
export function dbToLinear(db: number): number { return !Number.isFinite(db) ? 0 : Math.pow(10, db / 20); }

/**
 * Pixel range [visFrom, visTo) of a clip that is on screen, quantised to `chunk` px so small scrolls do not
 * change the result (keeps memoised clips from re-rendering on every scroll tick).
 */
export function clipVisiblePx(clipX: number, clipW: number, viewX0: number, viewX1: number, chunk = 256): { visFrom: number; visTo: number } | null {
  const a = Math.max(0, viewX0 - clipX);
  const b = Math.min(clipW, viewX1 - clipX);
  if (b <= a) return null;
  return { visFrom: Math.floor(a / chunk) * chunk, visTo: Math.min(clipW, Math.ceil(b / chunk) * chunk) };
}
