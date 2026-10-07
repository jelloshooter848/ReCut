/**
 * The clips (and transitions) of one track lane, in content coordinates inside the translated scrolling layer.
 * Memoised per track: an edit re-renders only the lanes whose track (or per-lane inputs) changed, and a render
 * visits only the clips overlapping the view (binary search, viewMath.firstOverlapIndex) instead of every clip of
 * the track. ClipView itself stays memoised, so untouched clips skip render.
 */
import React, { memo, useRef } from 'react';
import type { Clip, ID, MediaItem, Rational, Track, Transition } from '@shared/model';
import { clipEnd } from '@shared/timeline';
import { ClipView, type FilterLook } from './ClipView';
import { TransitionView, transitionSpan } from './TransitionView';
import { LodLane } from './LodLane';
import { LOD_MIN_CLIP_PX, clipVisiblePx, firstOverlapIndex } from './viewMath';

const clipEndOf = (c: Clip) => c.start + c.duration;

interface TransitionIndex { clips: Clip[]; order: number[]; starts: number[]; maxDur: number }
const transitionIndexCache = new WeakMap<Transition[], TransitionIndex>();
/**
 * The track's transitions sorted by the frame their span starts at (centered on the cut when both clips exist,
 * like transitionSpan), with the longest stored duration; cached per (transitions, clips) arrays.
 */
function transitionIndexOf(track: Track, clipsById: Map<ID, Clip>): TransitionIndex {
  const hit = transitionIndexCache.get(track.transitions);
  if (hit && hit.clips === track.clips) return hit;
  const rows: { j: number; start: number }[] = [];
  let maxDur = 0;
  for (let j = 0; j < track.transitions.length; j++) {
    const tr = track.transitions[j];
    const out = tr.outClipId ? clipsById.get(tr.outClipId) : undefined;
    const inc = tr.inClipId ? clipsById.get(tr.inClipId) : undefined;
    const start = out && inc ? inc.start - tr.duration / 2 : inc ? inc.start : out ? clipEnd(out) - tr.duration : NaN;
    if (Number.isNaN(start)) continue;
    rows.push({ j, start });
    if (tr.duration > maxDur) maxDur = tr.duration;
  }
  rows.sort((a, b) => a.start - b.start);
  const ix = { clips: track.clips, order: rows.map((r) => r.j), starts: rows.map((r) => r.start), maxDur };
  transitionIndexCache.set(track.transitions, ix);
  return ix;
}
function lowerBound(xs: number[], v: number): number {
  let lo = 0, hi = xs.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (xs[m] < v) lo = m + 1; else hi = m; }
  return lo;
}

const clipsByIdCache = new WeakMap<Clip[], Map<ID, Clip>>();
/** id -> clip of a track, cached per (structurally shared) clips array. */
export function clipsByIdOf(track: Track): Map<ID, Clip> {
  let m = clipsByIdCache.get(track.clips);
  if (!m) { m = new Map(track.clips.map((c) => [c.id, c])); clipsByIdCache.set(track.clips, m); }
  return m;
}

export interface ClipLaneProps {
  track: Track;
  top: number;
  height: number;
  /** Width of the lane (the scrollable content width, px). */
  contentPx: number;
  zoom: number;
  /** Content-space pixel range of the clips to mount: the viewport (plus a few px of slack). */
  mountX0: number;
  mountX1: number;
  /** Content-space pixel range the mounted clips prepare media for (filmstrip tiles, waveform): viewport plus a margin. */
  viewX0: number;
  viewX1: number;
  selected: ReadonlySet<ID>;
  look: (clip: Clip) => FilterLook;
  offline: (clip: Clip) => boolean;
  media: Record<ID, MediaItem>;
  fps: Rational;
  showSourceTc: boolean;
  /** Linked-partner sync offsets of this lane's clips (absent = all in sync). */
  syncOffsets: ReadonlyMap<ID, number> | undefined;
  /** Live duration of the transition being dragged, when it is on this lane. */
  previewTransition: { id: ID; duration: number } | null;
  selectedTransitionId: ID | null;
  /** LOD canvas placement (content px of the viewport's left edge, viewport width). */
  lodOriginPx: number;
  lodWidthPx: number;
  /** Device pixel ratio (waveform canvases are sized in device pixels). */
  dpr?: number;
}

/**
 * React keys of the mounted clips ("slots"), kept per lane across renders. When most of a lane's mounted clips are
 * replaced at once (a page flip), the previous slots are handed to the new clips in order, so their ClipViews and DOM
 * nodes are updated in place instead of a page of subtrees unmounting and another mounting (fiber churn, DOM
 * removals and creations, GC, new canvases). The keys keep their previous relative order, so React moves no node
 * and the DOM order (the paint order of touching clips) stays the clip order. Otherwise (scrolling: a clip or two
 * enters or leaves) clips keep their slot and entering clips get new ones, exactly like keying by clip id.
 */
interface Slots { byClip: Map<ID, string>; next: number }

function assignSlots(slots: Slots, ids: readonly ID[]): string[] {
  let fresh = 0;
  for (const id of ids) if (!slots.byClip.has(id)) fresh++;
  const replace = fresh > 0 && fresh >= ids.length - fresh;
  const old = replace ? [...slots.byClip.values()] : null;
  const byClip = new Map<ID, string>();
  const keys = ids.map((id, j) => {
    const k = (old ? old[j] : slots.byClip.get(id)) ?? `clip-slot-${slots.next++}`;
    byClip.set(id, k);
    return k;
  });
  slots.byClip = byClip;
  return keys;
}

export const ClipLane = memo(function ClipLane(p: ClipLaneProps) {
  const { track, zoom, viewX0, viewX1, mountX0, mountX1 } = p;
  const clips = track.clips;
  const from = Math.max(0, mountX0 / zoom);
  const to = mountX1 / zoom;
  const slotsRef = useRef<Slots>({ byClip: new Map(), next: 0 });
  const mounted: { clip: Clip; i: number; visFrom: number; visTo: number }[] = [];
  const narrow: Clip[] = [];
  for (let i = firstOverlapIndex(clips, from, clipEndOf); i < clips.length; i++) {
    const clip = clips[i];
    if (clip.start >= to) break;
    if (clip.start + clip.duration <= from) continue;
    // Level of detail (P-05): narrow clips are canvas-drawn by the lane, not mounted.
    if (clip.duration * zoom < LOD_MIN_CLIP_PX) { narrow.push(clip); continue; }
    const vis = clipVisiblePx(clip.start * zoom, clip.duration * zoom, viewX0, viewX1);
    if (!vis) continue;
    mounted.push({ clip, i, visFrom: vis.visFrom, visTo: vis.visTo });
  }
  const keys = assignSlots(slotsRef.current, mounted.map((m) => m.clip.id));
  const nodes: React.ReactNode[] = mounted.map(({ clip, i, visFrom, visTo }, j) => {
    const prev = clips[i - 1], next = clips[i + 1];
    return (
      <ClipView key={keys[j]} clip={clip} trackId={track.id} trackKind={track.kind} trackLocked={track.locked} height={p.height} zoom={zoom}
        selected={p.selected.has(clip.id)} filter={p.look(clip)} media={p.media[clip.mediaId]} fps={p.fps} showSourceTc={p.showSourceTc}
        visFrom={visFrom} visTo={visTo} cutAtStart={!!prev && clipEnd(prev) === clip.start} cutAtEnd={!!next && next.start === clipEnd(clip)}
        syncOffset={p.syncOffsets?.get(clip.id)} dpr={p.dpr} />
    );
  });
  if (track.transitions.length) {
    const clipsById = clipsByIdOf(track);
    const pt = p.previewTransition;
    const push = (tr: Transition) => {
      const previewing = !!pt && pt.id === tr.id;
      const span = transitionSpan(tr, clipsById, zoom, previewing ? pt!.duration : tr.duration);
      if (!span || span.x + span.w < mountX0 || span.x > mountX1) return;
      if (span.w < LOD_MIN_CLIP_PX && !previewing && tr.id !== p.selectedTransitionId) return;
      nodes.push(<TransitionView key={tr.id} transition={tr} trackId={track.id} x={span.x} w={span.w} height={p.height} selected={tr.id === p.selectedTransitionId} />);
    };
    // Candidates by frame range (index sorted by start, cached per track), then the exact pixel test above: a lane
    // render visits the transitions near the view instead of every transition of the track.
    const ix = transitionIndexOf(track, clipsById);
    const f0 = mountX0 / zoom - ix.maxDur - 1, f1 = mountX1 / zoom + 1;
    const near: number[] = [];
    for (let k = lowerBound(ix.starts, f0); k < ix.starts.length && ix.starts[k] <= f1; k++) near.push(ix.order[k]);
    // A transition being resized may be longer than any stored duration: always test it.
    if (pt) { const j = track.transitions.findIndex((t) => t.id === pt.id); if (j >= 0 && !near.includes(j)) near.push(j); }
    near.sort((a, b) => a - b); // track order, as before (DOM order of the transition nodes)
    for (const j of near) push(track.transitions[j]);
  }
  return (
    <div className="tl-track-clips" data-track-id={track.id} style={{ top: p.top, height: p.height, width: p.contentPx }}>
      {narrow.length ? <LodLane kind={track.kind} clips={narrow} zoom={zoom} originPx={p.lodOriginPx} widthPx={p.lodWidthPx} height={p.height} selected={p.selected} look={p.look} offline={p.offline} /> : null}
      {nodes}
    </div>
  );
});

