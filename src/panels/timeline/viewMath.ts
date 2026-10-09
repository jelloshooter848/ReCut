/**
 * Pure timeline view math. No DOM, no store: everything here is unit-testable.
 *
 * Coordinates: `zoom` is pixels per frame (float), `scroll` is the first visible frame (float).
 * x = (frame - scroll) * zoom.
 */
import type { Rational, Track } from '../../../shared/model';
import { formatSequenceTimecode, fpsValue } from '../../../shared/time';
import { VIEW_ZOOM_MAX, VIEW_ZOOM_MIN } from '../../../shared/limits';

/** Default lower zoom bound (px per frame); long sequences lower it dynamically (see minZoomFor). */
export const MIN_ZOOM = 0.01;
/** Absolute lower bound: ~2.3 days @24 fps in a 500 px lane. The same bounds normalizeProject clamps a loaded
 *  view's zoom to (shared/limits.ts), so a loaded zoom is always reachable here. */
export const ZOOM_FLOOR = VIEW_ZOOM_MIN;
export const MAX_ZOOM = VIEW_ZOOM_MAX;
/** Pixels within which an edge/snap target grabs the pointer. */
export const EDGE_PX = 6;
export const SNAP_PX = 8;

/** Zoom-to-fit padding (fraction of the lane width kept free on the right). */
export const FIT_PADDING = 0.04;

/**
 * Lowest zoom allowed for a sequence of `durationFrames` in a `widthPx` lane: MIN_ZOOM, lowered so zoom-to-fit
 * always shows the whole sequence (with some slack to zoom out a bit further), never below ZOOM_FLOOR.
 */
export function minZoomFor(durationFrames: number, widthPx: number): number {
  if (!(durationFrames > 0) || !(widthPx > 0)) return MIN_ZOOM;
  const fit = (widthPx * (1 - FIT_PADDING)) / durationFrames;
  return Math.max(ZOOM_FLOOR, Math.min(MIN_ZOOM, fit / 1.05));
}

export function clampZoom(zoom: number, minZoom = MIN_ZOOM): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(MAX_ZOOM, Math.max(Math.max(ZOOM_FLOOR, Math.min(MIN_ZOOM, minZoom)), zoom));
}

export function frameToX(frame: number, zoom: number, scroll: number): number {
  return (frame - scroll) * zoom;
}

/**
 * Where the playhead's composited layer goes (CSS px, relative to the lane's left edge, its containing block), so the
 * line lands on the window's device pixel nearest frameToX at any zoom, scroll and dpr. `originPx` is the viewport x
 * of the lane's left edge: a zone split can put it at a fractional device offset (e.g. x.5 at dpr 1.5), and the snap
 * must be on the window's grid (where clip edges are drawn), not the lane's.
 * - `shift`: the lane's offset past the device pixel boundary below it (CSS px, >= 0, in layout units of 1/64 device
 *   px). The layer is laid out at `left: -shift`, i.e. on a whole device pixel: Blink snaps a fractional *layout*
 *   offset into the layer's painting (crisp), but a fractional *transform* is resampled (a blurred 2-device-px line).
 * - `tx`: the layer's translation, always a whole number of device pixels (only this changes per frame).
 * The line's x from the lane's edge is tx - shift (playheadX). With a whole-pixel lane at dpr 1: shift 0 and
 * tx = Math.round(frameToX(...)), the line's former `left`.
 */
export function playheadLayerPos(frame: number, zoom: number, scroll: number, dpr: number, originPx = 0): { shift: number; tx: number } {
  const d = dpr > 0 && Number.isFinite(dpr) ? dpr : 1;
  const od = (Number.isFinite(originPx) ? originPx : 0) * d;
  // Device px of the boundary at or below the lane's edge (tolerant of float noise in getBoundingClientRect).
  const base = Math.floor(od + 1 / 128);
  const phase = Math.max(0, Math.round((od - base) * 64) / 64);
  const target = Math.round(od + frameToX(frame, zoom, scroll) * d);
  return { shift: phase / d, tx: (target - base) / d };
}

/** Playhead line x (CSS px from the lane's left edge): playheadLayerPos's tx - shift. */
export function playheadX(frame: number, zoom: number, scroll: number, dpr: number, originPx = 0): number {
  const p = playheadLayerPos(frame, zoom, scroll, dpr, originPx);
  return p.tx - p.shift;
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
export function zoomToFit(durationFrames: number, widthPx: number, padding = FIT_PADDING): number {
  const usable = Math.max(1, widthPx * (1 - padding));
  const d = Math.max(1, durationFrames);
  return clampZoom(usable / d, minZoomFor(d, widthPx));
}

/** Change zoom keeping the frame under `anchorX` (px from the left edge of the view) stationary. */
export function zoomAround(zoom: number, scroll: number, anchorX: number, newZoom: number, minZoom = MIN_ZOOM): { zoom: number; scroll: number } {
  const z = clampZoom(newZoom, minZoom);
  const anchorFrame = xToFrame(anchorX, zoom, scroll);
  return { zoom: z, scroll: Math.max(0, anchorFrame - anchorX / z) };
}

export function zoomByFactor(zoom: number, scroll: number, anchorX: number, factor: number, minZoom = MIN_ZOOM) {
  return zoomAround(zoom, scroll, anchorX, zoom * factor, minZoom);
}

/** Logarithmic slider mapping 0..1 <-> minZoom..MAX_ZOOM. */
export function zoomToSlider(zoom: number, minZoom = MIN_ZOOM): number {
  const lo = Math.log(clampZoom(minZoom, minZoom)), hi = Math.log(MAX_ZOOM);
  return (Math.log(clampZoom(zoom, minZoom)) - lo) / (hi - lo);
}
export function sliderToZoom(t: number, minZoom = MIN_ZOOM): number {
  const lo = Math.log(clampZoom(minZoom, minZoom)), hi = Math.log(MAX_ZOOM);
  return clampZoom(Math.exp(lo + Math.min(1, Math.max(0, t)) * (hi - lo)), minZoom);
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
    while (h * zoom < minMajorPx && Number.isFinite(h)) h *= 2; // bounded even for a zero / negative zoom
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

/** Ticks covering [scroll, scroll + width/zoom]. Labels on majors as display timecode (formatSequenceTimecode: HH:MM:SS;FF drop-frame at 29.97 / 59.94). */
export function rulerTicks(fps: Rational, zoom: number, scroll: number, widthPx: number, minMajorPx = 80): RulerTick[] {
  const out: RulerTick[] = [];
  if (!(widthPx > 0) || !(zoom > 0) || !Number.isFinite(zoom) || !Number.isFinite(scroll)) return out;
  const { major, minor } = rulerSpacing(fps, zoom, minMajorPx);
  const first = Math.max(0, scroll);
  const last = scroll + widthPx / zoom;
  const step = minor > 0 ? minor : major;
  const start = Math.floor(first / step) * step;
  // Iterate by index with a bound derived from the viewport (not `f += step`): at huge scroll positions
  // (beyond 2^53) `f + step === f` and an accumulating loop never terminates. Frames that collapse onto the
  // previous one at that magnitude are skipped.
  const count = Math.min(Math.floor((last - start) / step) + 1, Math.ceil(widthPx / (step * zoom)) + 2, 100_000);
  let prev = -Infinity;
  for (let i = 0; i < count; i++) {
    const f = start + i * step;
    if (f < 0 || f <= prev) continue;
    if (f > last) break;
    prev = f;
    const isMajor = f % major === 0;
    if (!isMajor && minor === 0) continue;
    out.push({ frame: f, x: frameToX(f, zoom, scroll), major: isMajor, label: isMajor ? formatSequenceTimecode(f, fps) : undefined });
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
 * Track targets of a media or sequence drop on `row` (#120): that track for its own kind, and the track at the same
 * index for the other kind (V2 -> A2, A2 -> V2), so the linked half never lands on, and overwrites, another track.
 */
export function dropTracks(row: Pick<TrackRow, 'id' | 'kind' | 'index'> | null | undefined):
  { videoTrackId?: string; audioTrackId?: string; videoTrackIndex?: number; audioTrackIndex?: number } {
  if (!row) return {};
  return row.kind === 'video' ? { videoTrackId: row.id, audioTrackIndex: row.index } : { audioTrackId: row.id, videoTrackIndex: row.index };
}

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

/**
 * Content-space pixel range [x0, x1] of the clips the timeline mounts, with the view it was computed for. The view
 * (scroll position plus `slackPx` either side) is always inside it. It is kept while the view stays inside, so small
 * scroll steps (wheel, trackpad) change no clip lane at all; when an incremental scroll (at most half a viewport) leaves
 * it, the new range reaches `aheadPx` further in the scroll direction. A jump (page flip, scrollbar drag, zoom or width
 * change) gets the view alone, so it mounts no more clips than before.
 */
export interface MountRange { x0: number; x1: number; zoom: number; width: number; scrollPx: number }

export function nextMountRange(prev: MountRange | null, scrollPx: number, width: number, zoom: number, slackPx: number, aheadPx: number): MountRange {
  const v0 = scrollPx - slackPx, v1 = scrollPx + width + slackPx;
  const same = !!prev && prev.zoom === zoom && prev.width === width;
  if (same && v0 >= prev.x0 && v1 <= prev.x1) return prev.scrollPx === scrollPx ? prev : { ...prev, scrollPx };
  const incremental = same && Math.abs(scrollPx - prev.scrollPx) <= width / 2;
  if (incremental && v1 > prev.x1) return { x0: v0, x1: v1 + aheadPx, zoom, width, scrollPx };
  if (incremental && v0 < prev.x0) return { x0: Math.max(v0 - aheadPx, Math.min(v0, 0)), x1: v1, zoom, width, scrollPx };
  return { x0: v0, x1: v1, zoom, width, scrollPx };
}

/**
 * The mounted range a scroll in direction `dir` (+1 right, -1 left) should be extended to ahead of time (in idle time,
 * so that the scroll steps that follow change no lane): when fewer than `lowPx` of mounted range are left ahead of the
 * view (plus `slackPx`), the range reaches `targetPx` ahead and the part behind the view is dropped. Null when nothing
 * is needed. Uses the view the range was last computed for (`prev.scrollPx`, `prev.width`).
 */
export function prefetchMountRange(prev: MountRange, dir: number, slackPx: number, lowPx: number, targetPx: number): MountRange | null {
  const v0 = prev.scrollPx - slackPx, v1 = prev.scrollPx + prev.width + slackPx;
  if (dir > 0) {
    if (prev.x1 - v1 >= lowPx) return null;
    return { ...prev, x0: Math.max(prev.x0, v0), x1: v1 + targetPx };
  }
  if (dir < 0) {
    const floor = Math.min(v0, 0);
    if (v0 - prev.x0 >= lowPx || prev.x0 <= floor) return null;
    return { ...prev, x0: Math.max(v0 - targetPx, floor), x1: Math.min(prev.x1, v1) };
  }
  return null;
}

/**
 * Splits a content scroll position (CSS px) into the part a scroller holds (`base`: whole device pixels, which is all a
 * scroll offset keeps) and the sub-device-pixel rest (`frac`, CSS px, >= 0) that a transform supplies, so that
 * base + frac === scrollPx and content lands exactly where a translateX(-scrollPx) put it.
 */
export function splitScroll(scrollPx: number, dpr: number): { base: number; baseDev: number; frac: number } {
  const d = dpr > 0 && Number.isFinite(dpr) ? dpr : 1;
  const baseDev = Math.max(0, Math.floor(scrollPx * d + 1e-6));
  const base = baseDev / d;
  const frac = scrollPx - base;
  return { base, baseDev, frac: frac > 1e-6 ? frac : 0 };
}

/** Frame range [from, to) that needs rendering for a viewport, with a pixel margin. */
export function visibleRange(zoom: number, scroll: number, widthPx: number, marginPx = 200): { from: number; to: number } {
  return { from: Math.max(0, scroll - marginPx / zoom), to: scroll + (widthPx + marginPx) / zoom };
}

export function clipOverlaps(start: number, duration: number, from: number, to: number): boolean {
  return start < to && start + duration > from;
}

/** "+12 (00:00:00:12)" style delta label (timecode part follows the app-wide display rule, formatSequenceTimecode). */
export function formatDelta(frames: number, fps: Rational): string {
  const sign = frames > 0 ? '+' : frames < 0 ? '-' : '';
  return `${sign}${Math.abs(frames)} (${sign}${formatSequenceTimecode(Math.abs(frames), fps)})`;
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

// ------------------------------------------------------------------
// Level of detail (P-05)
// ------------------------------------------------------------------

/** Clips narrower than this (px) are not DOM nodes: they are drawn into one canvas per track lane. */
export const LOD_MIN_CLIP_PX = 6;
/** Clips narrower than this (px) request no filmstrip / waveform. */
export const MEDIA_MIN_CLIP_PX = 40;
/** A clip's filmstrip / waveform request waits until its visible range has been stable this long (ms). */
export const MEDIA_SETTLE_MS = 150;

export interface LodClip { start: number; duration: number }
export interface LodRect { x: number; w: number; first: number; last: number }

/**
 * Merge clips (sorted by start, in frames) into pixel runs for the canvas lane: clips whose pixel extents touch
 * (gap below `mergeGapPx`) become one rect. `originPx` is subtracted from every x. `first`/`last` index `clips`.
 * Only clips overlapping [x0, x1) (pixels, after the origin shift) are considered.
 */
export function mergeLodRuns(clips: readonly LodClip[], zoom: number, originPx: number, x0: number, x1: number, mergeGapPx = 1): LodRect[] {
  const out: LodRect[] = [];
  let cur: LodRect | null = null;
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    const a = c.start * zoom - originPx;
    const b = Math.max(a + 1, (c.start + c.duration) * zoom - originPx);
    if (b <= x0 || a >= x1) continue;
    if (cur && a - (cur.x + cur.w) < mergeGapPx) { cur.w = Math.max(cur.w, b - cur.x); cur.last = i; continue; }
    cur = { x: a, w: b - a, first: i, last: i };
    out.push(cur);
  }
  return out;
}

/**
 * Clip of `clips` (sorted by start) under `frame`, for hit-testing a canvas-drawn lane: the clip containing the
 * frame, else the nearest one within `tolPx` pixels (tiny clips are hard to hit exactly).
 */
export function lodClipAt<T extends LodClip>(clips: readonly T[], frame: number, zoom: number, tolPx = 3): T | undefined {
  let lo = 0, hi = clips.length - 1, idx = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (clips[mid].start <= frame) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
  let best: T | undefined; let bestD = tolPx / Math.max(zoom, 1e-9);
  for (let i = Math.max(0, idx - 2); i <= Math.min(clips.length - 1, idx + 2); i++) {
    const c = clips[i];
    if (frame >= c.start && frame < c.start + c.duration) return c;
    const d = frame < c.start ? c.start - frame : frame - (c.start + c.duration);
    if (d <= bestD) { bestD = d; best = c; }
  }
  return best;
}

/** Hit-test a canvas-drawn (LOD) lane: the clip of track `trackId` under `frame`, as findClip would locate it. */
export function lodHit(
  tracks: { videoTracks: readonly Track[]; audioTracks: readonly Track[] }, trackId: string, frame: number, zoom: number,
): { track: Track; clip: Track['clips'][number]; index: number } | undefined {
  const track = tracks.videoTracks.find((t) => t.id === trackId) ?? tracks.audioTracks.find((t) => t.id === trackId);
  if (!track) return undefined;
  const clip = lodClipAt(track.clips, frame, zoom);
  return clip ? { track, clip, index: track.clips.indexOf(clip) } : undefined;
}


// ------------------------------------------------------------------
// Range queries over start-sorted lists (clips of a track, resolved cues)
// ------------------------------------------------------------------

const maxEndCache = new WeakMap<readonly object[], Float64Array>();

/**
 * Index of the first item of `items` (sorted by start) whose extent can reach past `from`: a binary search over the
 * prefix maximum of the item ends, computed once per (immutable) array and cached. Every item before the returned
 * index ends at or before `from`; callers iterate from it while `start < to` and still test each item for overlap.
 * Overlapping items are handled (the prefix maximum is monotonic either way).
 */
export function firstOverlapIndex<T extends object>(items: readonly T[], from: number, endOf: (item: T) => number): number {
  let m = maxEndCache.get(items);
  if (!m || m.length !== items.length) {
    m = new Float64Array(items.length);
    let mx = -Infinity;
    for (let i = 0; i < items.length; i++) { const e = endOf(items[i]); if (e > mx) mx = e; m[i] = mx; }
    maxEndCache.set(items, m);
  }
  let lo = 0, hi = items.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (m[mid] > from) hi = mid; else lo = mid + 1; }
  return lo;
}

/** Items of `items` (sorted by start) overlapping [from, to): `firstOverlapIndex` plus a forward scan. */
export function itemsInRange<T extends object>(items: readonly T[], from: number, to: number, startOf: (item: T) => number, endOf: (item: T) => number): T[] {
  const out: T[] = [];
  for (let i = firstOverlapIndex(items, from, endOf); i < items.length; i++) {
    const it = items[i];
    const s = startOf(it);
    if (s >= to) break;
    if (endOf(it) > from) out.push(it);
  }
  return out;
}
