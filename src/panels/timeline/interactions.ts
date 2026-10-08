/**
 * Pointer interactions for the tracks area: selection, marquee, move / trim / roll / slip / slide drags,
 * razor + track-select clicks, transition duration drags and the hand tool.
 *
 * Nothing is committed while dragging: a DragPreview drives ghost rendering and a single store action
 * runs on pointer-up (one undo step).
 */
import { useCallback, useRef, useState } from 'react';
import type React from 'react';
import type { Clip, ID, Rational, Sequence, Track } from '@shared/model';
import { formatSequenceTimecode } from '@shared/time';
import { clipEnd, findClip, linkedClips, maxClipEnd, maxDurationFrom } from '@shared/timeline';
import { useStore, mediaDurationLookup } from '@/state';
import type { Tool } from '@/state';
import type { DragPreview } from './types';
import { formatDelta, lodHit, rowAtY, snapDelta, snapFrame, snapThresholdFrames, type TrackLayout } from './viewMath';

export interface InteractionCtx {
  seqId: ID;
  zoom: number;
  scroll: number;
  layout: TrackLayout;
  tool: Tool;
  snapping: boolean;
  linkedSelection: boolean;
  contentEl: HTMLDivElement | null;
  /** Double-click on a clip body with the Select tool (detected here: pointer capture swallows dblclick on some platforms). */
  onClipDoubleClick?: (clip: Clip) => void;
}

type Drag =
  | { kind: 'move'; startX: number; startY: number; clipIds: ID[]; primaryId: ID; primaryKind: 'video' | 'audio'; originIndex: number; started: boolean; candidates: number[]; group: ID[] }
  | { kind: 'trim'; clipId: ID; trackId: ID; edge: 'start' | 'end'; ripple: boolean; startX: number; orig: number; min: number; max: number; candidates: number[]; duration: number; start: number }
  | { kind: 'roll'; outId: ID; inId: ID; trackId: ID; cut: number; startX: number; min: number; max: number; candidates: number[] }
  | { kind: 'slip'; clipId: ID; trackId: ID; startX: number; min: number; max: number }
  | { kind: 'slide'; clipId: ID; trackId: ID; startX: number; min: number; max: number }
  | { kind: 'marquee'; x0: number; y0: number; started: boolean; additive: boolean }
  | { kind: 'transition'; id: ID; trackId: ID; edge: 'left' | 'right'; startX: number; orig: number; centered: boolean; limit: number }
  | { kind: 'hand'; startX: number; startScroll: number };

interface Active { drag: Drag; pointerId: number; el: HTMLElement }

const DRAG_THRESHOLD = 3;

function fpsFrames(seconds: number, fps: Rational) { return Math.floor(seconds * fps.num / fps.den + 1e-6); }

/** Snap targets: edit points of clips not being dragged, markers, 0, playhead, in/out. */
export function snapTargets(seq: Sequence, exclude: Set<ID> = new Set()): number[] {
  const out: number[] = [0, seq.view.playhead];
  if (seq.view.inPoint !== null) out.push(seq.view.inPoint);
  if (seq.view.outPoint !== null) out.push(seq.view.outPoint);
  for (const m of seq.markers) out.push(m.time);
  for (const t of [...seq.videoTracks, ...seq.audioTracks]) for (const c of t.clips) if (!exclude.has(c.id)) { out.push(c.start); out.push(clipEnd(c)); }
  return out;
}

/**
 * Drag range of a clip edge (mirrors trimLimits / trimEnd / rippleTrimEnd in shared/timeline.ts). A limit
 * never lies on the inner side of the edge's current position: a clip already past its media end (or one
 * overlapping a neighbour) keeps its edge when dragged outward instead of jumping back. Exported for tests.
 */
export function trimRange(seq: Sequence, track: Track, clip: Clip, edge: 'start' | 'end', ripple: boolean, dur: (id: ID) => number): [number, number] {
  const idx = track.clips.indexOf(clip);
  const prev = track.clips[idx - 1]; const next = track.clips[idx + 1];
  const handleBefore = fpsFrames(clip.sourceIn / clip.speed, seq.fps);
  if (edge === 'start') {
    const minStart = ripple ? Math.max(0, clip.start - handleBefore) : Math.max(prev ? clipEnd(prev) : 0, clip.start - handleBefore, 0);
    return [Math.min(clip.start, minStart), clipEnd(clip) - 1];
  }
  const mediaEnd = maxClipEnd(clip, dur(clip.mediaId), seq.fps);
  const maxEnd = ripple ? mediaEnd : Math.max(clipEnd(clip), Math.min(next ? next.start : Number.MAX_SAFE_INTEGER, mediaEnd));
  return [clip.start + 1, maxEnd];
}

/** Slide delta range (mirrors slideClip). Always contains 0. Exported for tests. */
export function slideRange(seq: Sequence, track: Track, clip: Clip, dur: (id: ID) => number): [number, number] {
  const index = track.clips.indexOf(clip);
  const prev = track.clips[index - 1]; const next = track.clips[index + 1];
  let min = -Infinity, max = Infinity;
  if (prev) {
    const gap = clip.start - clipEnd(prev);
    if (gap === 0) {
      max = Math.min(max, maxClipEnd(prev, dur(prev.mediaId), seq.fps) - clipEnd(prev));
      min = Math.max(min, -(prev.duration - 1));
    } else min = Math.max(min, -Math.max(0, gap));
  } else min = Math.max(min, -clip.start);
  if (next) {
    const gap = next.start - clipEnd(clip);
    if (gap === 0) {
      min = Math.max(min, -fpsFrames(next.sourceIn / next.speed, seq.fps));
      max = Math.min(max, next.duration - 1);
    } else max = Math.min(max, Math.max(0, gap));
  }
  return [min, max];
}

/** Rolling-edit range of the cut between `a` and `b` (mirrors rollEdit). Always contains the cut. Exported for tests. */
export function rollRange(seq: Sequence, a: Clip, b: Clip, dur: (id: ID) => number): [number, number] {
  const maxA = maxClipEnd(a, dur(a.mediaId), seq.fps);
  const minB = b.start - fpsFrames(b.sourceIn / b.speed, seq.fps);
  return [Math.max(a.start + 1, minB), Math.min(maxA, clipEnd(b) - 1)];
}

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }

export interface TimelineDrag {
  preview: DragPreview | null;
  dragging: boolean;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
  cancel: () => void;
  /** Select a clip the Premiere way (link group, Shift add, Ctrl toggle). Returns the ids that make up the click group. */
  clickSelect: (clip: Clip, e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }) => ID[];
}

export function useTimelineDrag(ctxRef: React.MutableRefObject<InteractionCtx>, suppressFlip: React.MutableRefObject<boolean>): TimelineDrag {
  const active = useRef<Active | null>(null);
  const lastClipDown = useRef<{ clipId: ID; at: number; x: number; y: number } | null>(null);
  const [preview, setPreview] = useState<DragPreview | null>(null);
  const [dragging, setDragging] = useState(false);

  const seqOf = () => { const st = useStore.getState(); return st.project.sequences[ctxRef.current.seqId] ?? null; };
  const local = (e: { clientX: number; clientY: number }) => {
    const el = ctxRef.current.contentEl;
    const r = el ? el.getBoundingClientRect() : { left: 0, top: 0 };
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const frameAt = (x: number) => ctxRef.current.scroll + x / ctxRef.current.zoom;

  const clickSelect = useCallback<TimelineDrag['clickSelect']>((clip, e) => {
    const seq = seqOf(); const st = useStore.getState();
    if (!seq) return [clip.id];
    const group = ctxRef.current.linkedSelection && !e.altKey ? linkedClips(seq, clip).map((c) => c.id) : [clip.id];
    if (e.shiftKey) st.select(group, 'add');
    else if (e.ctrlKey || e.metaKey) st.select(group, 'toggle');
    else if (!st.ui.selectedClipIds.includes(clip.id)) st.select(group, 'set');
    return group;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finish = (e?: React.PointerEvent) => {
    const a = active.current;
    active.current = null;
    suppressFlip.current = false;
    setDragging(false);
    setPreview(null);
    if (a && e) { try { a.el.releasePointerCapture(a.pointerId); } catch { /* ignore */ } }
  };

  const begin = (e: React.PointerEvent<HTMLDivElement>, drag: Drag) => {
    const el = e.currentTarget;
    try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    active.current = { drag, pointerId: e.pointerId, el };
    suppressFlip.current = true;
    setDragging(true);
  };

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const ctx = ctxRef.current;
    const seq = seqOf(); const st = useStore.getState();
    if (!seq || active.current) return;
    const target = e.target as HTMLElement;
    const clipEl = target.closest<HTMLElement>('[data-clip-id]');
    const edgeEl = target.closest<HTMLElement>('.tl-clip-edge');
    const trEl = target.closest<HTMLElement>('[data-transition-id]');
    const trEdgeEl = target.closest<HTMLElement>('.tl-tr-edge');
    const rowEl = target.closest<HTMLElement>('[data-track-id]');
    const trackId = rowEl?.dataset.trackId ?? null;
    const { x, y } = local(e);
    const dur = mediaDurationLookup(st.project);
    // Clips narrower than LOD_MIN_CLIP_PX are canvas-drawn (LodLane): hit-test those by position.
    const loc = clipEl ? findClip(seq, clipEl.dataset.clipId!)
      : trackId && target.closest('[data-lod-lane]') ? lodHit(seq, trackId, frameAt(x), ctx.zoom) : undefined;

    if (e.button === 1 || ctx.tool === 'hand') {
      e.preventDefault();
      begin(e, { kind: 'hand', startX: e.clientX, startScroll: ctx.scroll });
      return;
    }
    if (e.button === 2) {
      // right-click selects the clip under the pointer (keeps an existing multi-selection that contains it)
      if (loc && !st.ui.selectedClipIds.includes(loc.clip.id)) clickSelect(loc.clip, { shiftKey: false, ctrlKey: false, metaKey: false, altKey: e.altKey });
      if (trEl && !loc) st.selectTransition(trEl.dataset.transitionId!);
      return;
    }
    if (e.button !== 0) return;
    e.preventDefault();

    // ---- razor
    if (ctx.tool === 'razor') {
      if (!loc || loc.track.locked) return;
      let f = Math.round(frameAt(x));
      if (ctx.snapping && !e.altKey) f = snapFrame(f, snapTargets(seq), snapThresholdFrames(ctx.zoom)).frame;
      if (f <= loc.clip.start || f >= clipEnd(loc.clip)) return;
      st.razor(seq.id, f, e.shiftKey ? undefined : [loc.track.id]);
      return;
    }
    // ---- track select
    if (ctx.tool === 'track') {
      if (!trackId) return;
      const f = frameAt(x);
      const tracks = e.shiftKey ? [...seq.videoTracks, ...seq.audioTracks] : [...seq.videoTracks, ...seq.audioTracks].filter((t) => t.id === trackId);
      const ids: ID[] = [];
      const seen = new Set<ID>();
      for (const t of tracks) for (const c of t.clips) {
        if (clipEnd(c) <= f) continue;
        // Linked selection (default on, Alt bypasses): include the linked partners so a drag keeps sync.
        const group = ctx.linkedSelection && !e.altKey ? linkedClips(seq, c) : [c];
        for (const g of group) if (!seen.has(g.id)) { seen.add(g.id); ids.push(g.id); }
      }
      st.select(ids, e.ctrlKey ? 'toggle' : 'set');
      return;
    }
    // ---- transitions (any remaining tool)
    if (trEl) {
      const id = trEl.dataset.transitionId!;
      st.selectTransition(id);
      if (trEdgeEl && trackId) {
        const track = [...seq.videoTracks, ...seq.audioTracks].find((t) => t.id === trackId);
        const tr = track?.transitions.find((t) => t.id === id);
        if (!track || !tr || track.locked) return;
        const a = tr.outClipId ? track.clips.find((c) => c.id === tr.outClipId) : undefined;
        const b = tr.inClipId ? track.clips.find((c) => c.id === tr.inClipId) : undefined;
        const limit = Math.min(a ? a.duration : Infinity, b ? b.duration : Infinity);
        begin(e, { kind: 'transition', id, trackId, edge: trEdgeEl.dataset.edge as 'left' | 'right', startX: e.clientX, orig: tr.duration, centered: !!(a && b), limit });
      }
      return;
    }
    // ---- edge tools
    if (edgeEl && loc) {
      const edge = edgeEl.dataset.edge as 'start' | 'end';
      if (ctx.tool === 'select' || ctx.tool === 'ripple') {
        if (loc.track.locked) return;
        const ripple = ctx.tool === 'ripple';
        const [min, max] = trimRange(seq, loc.track, loc.clip, edge, ripple, dur);
        const orig = edge === 'start' ? loc.clip.start : clipEnd(loc.clip);
        if (!st.ui.selectedClipIds.includes(loc.clip.id)) clickSelect(loc.clip, e);
        begin(e, { kind: 'trim', clipId: loc.clip.id, trackId: loc.track.id, edge, ripple, startX: e.clientX, orig, min, max, candidates: snapTargets(seq, new Set([loc.clip.id])), duration: loc.clip.duration, start: loc.clip.start });
        return;
      }
      if (ctx.tool === 'rolling') {
        if (loc.track.locked) return;
        const i = loc.index;
        const a = edge === 'end' ? loc.clip : loc.track.clips[i - 1];
        const b = edge === 'end' ? loc.track.clips[i + 1] : loc.clip;
        if (!a || !b || clipEnd(a) !== b.start) return;
        const [min, max] = rollRange(seq, a, b, dur);
        begin(e, { kind: 'roll', outId: a.id, inId: b.id, trackId: loc.track.id, cut: b.start, startX: e.clientX, min, max, candidates: snapTargets(seq, new Set([a.id, b.id])) });
        return;
      }
    }
    // ---- clip body
    if (loc) {
      if (ctx.tool === 'slip') {
        if (loc.track.locked) return;
        clickSelect(loc.clip, e);
        const handleBefore = fpsFrames(loc.clip.sourceIn / loc.clip.speed, seq.fps);
        const handleAfter = maxDurationFrom(loc.clip.sourceIn, loc.clip.speed, dur(loc.clip.mediaId), seq.fps) - loc.clip.duration;
        begin(e, { kind: 'slip', clipId: loc.clip.id, trackId: loc.track.id, startX: e.clientX, min: -handleBefore, max: Math.max(0, handleAfter) });
        return;
      }
      if (ctx.tool === 'slide') {
        if (loc.track.locked) return;
        clickSelect(loc.clip, e);
        const [min, max] = slideRange(seq, loc.track, loc.clip, dur);
        begin(e, { kind: 'slide', clipId: loc.clip.id, trackId: loc.track.id, startX: e.clientX, min, max });
        return;
      }
      // Double-click (Select tool, no modifiers): two presses on the same clip within 500 ms and 5 px. Detected here
      // rather than with dblclick, which pointer capture from the first press swallows on some platforms (Windows).
      if (ctx.tool === 'select' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const now = performance.now();
        const p = lastClipDown.current;
        if (p && p.clipId === loc.clip.id && now - p.at < 500 && Math.abs(e.clientX - p.x) <= 5 && Math.abs(e.clientY - p.y) <= 5) {
          lastClipDown.current = null;
          ctx.onClipDoubleClick?.(loc.clip);
          return;
        }
        lastClipDown.current = { clipId: loc.clip.id, at: now, x: e.clientX, y: e.clientY };
      } else lastClipDown.current = null;
      // select / ripple: selection + move
      const group = clickSelect(loc.clip, e);
      const selected = useStore.getState().ui.selectedClipIds;
      const movable = selected.filter((id) => { const l = findClip(seq, id); return l && !l.track.locked; });
      if (loc.track.locked || !movable.includes(loc.clip.id)) return;
      const row = ctx.layout.rows.find((r) => r.id === loc.track.id);
      begin(e, {
        kind: 'move', startX: e.clientX, startY: e.clientY, clipIds: movable, primaryId: loc.clip.id, primaryKind: loc.track.kind,
        originIndex: row?.index ?? 0, started: false, candidates: snapTargets(seq, new Set(movable)), group,
      });
      return;
    }
    // ---- empty area: marquee (and clear selection unless additive)
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    if (!additive) { st.select([], 'clear'); st.selectTransition(null); }
    begin(e, { kind: 'marquee', x0: x, y0: y, started: false, additive });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const a = active.current; if (!a) return;
    const ctx = ctxRef.current;
    const seq = seqOf(); if (!seq) return;
    const d = a.drag;
    const dx = d.kind === 'marquee' ? 0 : e.clientX - d.startX;
    const thr = snapThresholdFrames(ctx.zoom);
    const snapOn = ctx.snapping && !e.altKey;

    switch (d.kind) {
      case 'hand': {
        useStore.getState().setView(seq.id, { scroll: Math.max(0, d.startScroll - dx / ctx.zoom) });
        return;
      }
      case 'move': {
        if (!d.started) { if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(e.clientY - d.startY) < DRAG_THRESHOLD) return; d.started = true; }
        const clips = d.clipIds.map((id) => findClip(seq, id)).filter((l): l is NonNullable<typeof l> => !!l);
        if (!clips.length) return;
        let delta = Math.round(dx / ctx.zoom);
        let minStart = Infinity;
        for (const l of clips) minStart = Math.min(minStart, l.clip.start); // no spread: selections can be huge
        let snapTarget: number | null = null;
        if (snapOn) {
          const positions: number[] = [];
          for (const l of clips) { positions.push(l.clip.start + delta, clipEnd(l.clip) + delta); }
          const s = snapDelta(positions, d.candidates, thr);
          if (s.target !== null) { delta += s.delta; snapTarget = s.target; }
        }
        if (minStart + delta < 0) { delta = -minStart; snapTarget = null; }
        // vertical: move within the grabbed clip's track kind
        const { y } = local(e);
        const row = rowAtY(ctx.layout, y);
        let offset = 0;
        if (row && row.kind === d.primaryKind) {
          offset = row.index - d.originIndex;
          const list = d.primaryKind === 'video' ? seq.videoTracks : seq.audioTracks;
          for (const l of clips) {
            if (l.track.kind !== d.primaryKind) continue;
            const i = list.findIndex((t) => t.id === l.track.id);
            offset = clamp(offset, -i, list.length - 1 - i);
          }
        }
        const ghosts = clips.map((l) => {
          let trackId = l.track.id;
          if (offset !== 0 && l.track.kind === d.primaryKind) {
            const list = d.primaryKind === 'video' ? seq.videoTracks : seq.audioTracks;
            const i = list.findIndex((t) => t.id === l.track.id);
            trackId = list[clamp(i + offset, 0, list.length - 1)].id;
          }
          return { clipId: l.clip.id, trackId, start: l.clip.start + delta, duration: l.clip.duration, kind: l.track.kind, name: l.clip.name };
        });
        const primary = clips.find((l) => l.clip.id === d.primaryId) ?? clips[0];
        const tip = `${formatDelta(delta, seq.fps)}  ${formatSequenceTimecode(primary.clip.start + delta, seq.fps)}${e.ctrlKey ? '  INSERT' : ''}`;
        setPreview({ kind: 'move', ghosts, delta, insert: e.ctrlKey, snapTarget, tip });
        return;
      }
      case 'trim': {
        let f = d.orig + Math.round(dx / ctx.zoom);
        let snapTarget: number | null = null;
        if (snapOn) { const s = snapFrame(f, d.candidates, thr); if (s.snapped) { f = s.frame; snapTarget = s.target; } }
        f = clamp(f, d.min, d.max);
        if (f !== snapTarget) snapTarget = null;
        const start = d.edge === 'start' ? f : d.start;
        const end = d.edge === 'end' ? f : d.start + d.duration;
        const delta = f - d.orig;
        const tip = `${d.ripple ? 'Ripple ' : ''}${formatDelta(delta, seq.fps)}  dur ${formatSequenceTimecode(end - start, seq.fps)}`;
        setPreview({ kind: 'trim', clipId: d.clipId, trackId: d.trackId, start, duration: end - start, edge: d.edge, ripple: d.ripple, tip, snapTarget });
        return;
      }
      case 'roll': {
        let f = d.cut + Math.round(dx / ctx.zoom);
        if (snapOn) f = snapFrame(f, d.candidates, thr).frame;
        f = clamp(f, d.min, d.max);
        setPreview({ kind: 'roll', trackId: d.trackId, frame: f, tip: `Roll ${formatDelta(f - d.cut, seq.fps)}  ${formatSequenceTimecode(f, seq.fps)}` });
        return;
      }
      case 'slip': {
        const loc = findClip(seq, d.clipId); if (!loc) return;
        const delta = clamp(-Math.round(dx / ctx.zoom), d.min, d.max);
        const newIn = Math.max(0, loc.clip.sourceIn + delta * seq.fps.den / seq.fps.num * loc.clip.speed);
        const tip = `Slip ${formatDelta(delta, seq.fps)}  src ${formatSequenceTimecode(Math.round(newIn * seq.fps.num / seq.fps.den), seq.fps)}`;
        setPreview({ kind: 'slip', clipId: d.clipId, trackId: d.trackId, start: loc.clip.start, duration: loc.clip.duration, tip });
        return;
      }
      case 'slide': {
        const loc = findClip(seq, d.clipId); if (!loc) return;
        const delta = clamp(Math.round(dx / ctx.zoom), d.min, d.max);
        setPreview({ kind: 'slide', clipId: d.clipId, trackId: d.trackId, start: loc.clip.start + delta, duration: loc.clip.duration, tip: `Slide ${formatDelta(delta, seq.fps)}  ${formatSequenceTimecode(loc.clip.start + delta, seq.fps)}` });
        return;
      }
      case 'marquee': {
        const { x, y } = local(e);
        if (!d.started) { if (Math.abs(x - d.x0) < DRAG_THRESHOLD && Math.abs(y - d.y0) < DRAG_THRESHOLD) return; d.started = true; }
        setPreview({ kind: 'marquee', x0: d.x0, y0: d.y0, x1: x, y1: y });
        return;
      }
      case 'transition': {
        const dFrames = dx / ctx.zoom;
        let duration = d.centered ? d.orig + 2 * (d.edge === 'right' ? dFrames : -dFrames) : d.orig + (d.edge === 'right' ? dFrames : -dFrames);
        duration = clamp(Math.round(duration), 1, Math.max(1, d.limit));
        setPreview({ kind: 'transition', id: d.id, trackId: d.trackId, duration, tip: `${duration} f  ${formatSequenceTimecode(duration, seq.fps)}` });
        return;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const a = active.current; if (!a) return;
    const ctx = ctxRef.current;
    const st = useStore.getState();
    const seq = st.project.sequences[ctx.seqId];
    const d = a.drag;
    const current = previewRef.current;
    finish(e);
    if (!seq) return;
    switch (d.kind) {
      case 'move': {
        if (!d.started) {
          // plain click on an already-selected clip collapses the selection to that clip (+ links)
          if (!e.shiftKey && !e.ctrlKey && !e.metaKey && st.ui.selectedClipIds.length > d.group.length) st.select(d.group, 'set');
          return;
        }
        if (!current || current.kind !== 'move') return;
        const changed = current.ghosts.some((g) => { const l = findClip(seq, g.clipId); return !l || l.clip.start !== g.start || l.track.id !== g.trackId; });
        if (!changed) return;
        st.moveClips(seq.id, current.ghosts.map((g) => ({ clipId: g.clipId, toTrackId: g.trackId, toStart: g.start })), e.ctrlKey ? 'insert' : 'overwrite');
        return;
      }
      case 'trim': {
        if (!current || current.kind !== 'trim') return;
        const f = current.edge === 'start' ? current.start : current.start + current.duration;
        if (f !== d.orig) st.trimClipEdge(seq.id, d.clipId, d.edge, f, d.ripple);
        return;
      }
      case 'roll': {
        if (current && current.kind === 'roll' && current.frame !== d.cut) st.rollEdit(seq.id, d.outId, d.inId, current.frame);
        return;
      }
      case 'slip': {
        const delta = clamp(-Math.round((e.clientX - d.startX) / ctx.zoom), d.min, d.max);
        if (delta !== 0) st.slip(seq.id, d.clipId, delta);
        return;
      }
      case 'slide': {
        const delta = clamp(Math.round((e.clientX - d.startX) / ctx.zoom), d.min, d.max);
        if (delta !== 0) st.slide(seq.id, d.clipId, delta);
        return;
      }
      case 'marquee': {
        if (!d.started || !current || current.kind !== 'marquee') return;
        const x0 = Math.min(current.x0, current.x1), x1 = Math.max(current.x0, current.x1);
        const y0 = Math.min(current.y0, current.y1), y1 = Math.max(current.y0, current.y1);
        const f0 = ctx.scroll + x0 / ctx.zoom, f1 = ctx.scroll + x1 / ctx.zoom;
        const ids: ID[] = [];
        for (const row of ctx.layout.rows) {
          if (row.top + row.height < y0 || row.top > y1) continue;
          const track = [...seq.videoTracks, ...seq.audioTracks].find((t) => t.id === row.id);
          if (!track) continue;
          for (const c of track.clips) if (c.start < f1 && clipEnd(c) > f0) ids.push(c.id);
        }
        if (ids.length) st.select(ids, d.additive ? 'add' : 'set');
        return;
      }
      case 'transition': {
        if (current && current.kind === 'transition' && current.duration !== d.orig) st.setTransitionDuration(seq.id, d.id, current.duration);
        return;
      }
      default: return;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // keep the latest preview reachable from pointer-up without re-creating callbacks
  const previewRef = useRef<DragPreview | null>(null);
  previewRef.current = preview;

  const cancel = useCallback(() => { if (active.current) { const a = active.current; try { a.el.releasePointerCapture(a.pointerId); } catch { /* ignore */ } } finish(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return { preview, dragging, onPointerDown, onPointerMove, onPointerUp, cancel, clickSelect };
}
