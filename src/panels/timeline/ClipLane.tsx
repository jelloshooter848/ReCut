/**
 * The clips (and transitions) of one track lane, in content coordinates inside the translated scrolling layer.
 * Memoised per track: an edit re-renders only the lanes whose track (or per-lane inputs) changed, and a render
 * visits only the clips overlapping the view (binary search, viewMath.firstOverlapIndex) instead of every clip of
 * the track. ClipView itself stays memoised, so untouched clips skip render.
 */
import React, { memo } from 'react';
import type { Clip, ID, MediaItem, Rational, Track } from '@shared/model';
import { clipEnd } from '@shared/timeline';
import { ClipView, type FilterLook } from './ClipView';
import { TransitionView, transitionSpan } from './TransitionView';
import { LodLane } from './LodLane';
import { LOD_MIN_CLIP_PX, clipVisiblePx, firstOverlapIndex } from './viewMath';

const clipEndOf = (c: Clip) => c.start + c.duration;

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
}

export const ClipLane = memo(function ClipLane(p: ClipLaneProps) {
  const { track, zoom, viewX0, viewX1, mountX0, mountX1 } = p;
  const clips = track.clips;
  const from = Math.max(0, mountX0 / zoom);
  const to = mountX1 / zoom;
  const nodes: React.ReactNode[] = [];
  const narrow: Clip[] = [];
  for (let i = firstOverlapIndex(clips, from, clipEndOf); i < clips.length; i++) {
    const clip = clips[i];
    if (clip.start >= to) break;
    if (clip.start + clip.duration <= from) continue;
    // Level of detail (P-05): narrow clips are canvas-drawn by the lane, not mounted.
    if (clip.duration * zoom < LOD_MIN_CLIP_PX) { narrow.push(clip); continue; }
    const vis = clipVisiblePx(clip.start * zoom, clip.duration * zoom, viewX0, viewX1);
    if (!vis) continue;
    const prev = clips[i - 1], next = clips[i + 1];
    nodes.push(
      <ClipView key={clip.id} clip={clip} trackId={track.id} trackKind={track.kind} trackLocked={track.locked} height={p.height} zoom={zoom}
        selected={p.selected.has(clip.id)} filter={p.look(clip)} media={p.media[clip.mediaId]} fps={p.fps} showSourceTc={p.showSourceTc}
        visFrom={vis.visFrom} visTo={vis.visTo} cutAtStart={!!prev && clipEnd(prev) === clip.start} cutAtEnd={!!next && next.start === clipEnd(clip)}
        syncOffset={p.syncOffsets?.get(clip.id)} />,
    );
  }
  if (track.transitions.length) {
    const clipsById = clipsByIdOf(track);
    const pt = p.previewTransition;
    for (const tr of track.transitions) {
      const previewing = !!pt && pt.id === tr.id;
      const span = transitionSpan(tr, clipsById, zoom, previewing ? pt!.duration : tr.duration);
      if (!span || span.x + span.w < mountX0 || span.x > mountX1) continue;
      if (span.w < LOD_MIN_CLIP_PX && !previewing && tr.id !== p.selectedTransitionId) continue;
      nodes.push(<TransitionView key={tr.id} transition={tr} trackId={track.id} x={span.x} w={span.w} height={p.height} selected={tr.id === p.selectedTransitionId} />);
    }
  }
  return (
    <div className="tl-track-clips" data-track-id={track.id} style={{ top: p.top, height: p.height, width: p.contentPx }}>
      {narrow.length ? <LodLane kind={track.kind} clips={narrow} zoom={zoom} originPx={p.lodOriginPx} widthPx={p.lodWidthPx} height={p.height} selected={p.selected} look={p.look} offline={p.offline} /> : null}
      {nodes}
    </div>
  );
});

