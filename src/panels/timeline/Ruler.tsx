/**
 * Timecode ruler: canvas ticks + DOM markers / in-out band. Scrubs the playhead on click/drag, drags markers.
 *
 * Everything sits in a horizontal scroller whose scroll offset follows the view's scroll (like the tracks), so a scroll
 * step moves the markers and the band without a style change, re-layout or re-layerization of the page. They are
 * positioned at their view position plus that offset (pixel for pixel where they were). The tick canvas covers the
 * timeline's mounted range in content coordinates (it only moves when that range does) and is redrawn for each view
 * with exactly the view's ticks, offset to the viewport's place in it.
 */
import React, { useLayoutEffect, useRef, useState } from 'react';
import type { Marker, Rational } from '@shared/model';
import { formatSequenceTimecode } from '@shared/time';
import { useStore } from '@/state';
import { frameToX, rulerTicks, snapFrame, snapThresholdFrames, splitScroll, xToFrameInt } from './viewMath';
import { RULER_H } from './types';

export interface RulerProps {
  seqId: string;
  fps: Rational;
  zoom: number;
  scroll: number;
  width: number;
  /** Width of the scrollable content (px), as the tracks. */
  contentPx: number;
  /** Content-space pixel range of the clips the timeline mounts: the canvas covers it, markers in it stay mounted. */
  mountX0: number;
  mountX1: number;
  markers: Marker[];
  selectedMarkerId: string | null;
  inPoint: number | null;
  outPoint: number | null;
  snapping: boolean;
  /** Snap targets for the playhead / markers (edit points, in/out). */
  snapCandidates: () => number[];
  onMarkerEdit: (marker: Marker, at: { x: number; y: number }) => void;
  onMarkerMenu: (marker: Marker, e: React.MouseEvent) => void;
  onContextMenu: (frame: number, e: React.MouseEvent) => void;
  onScrubStart?: () => void;
  onScrubEnd?: () => void;
}

const COLORS = { bg: '#232323', major: '#8c8c8c', minor: '#4a4a4a', label: '#a8a8a8', edge: '#3a3a3a' };
const RULER_FONT = '10px "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace';

export function Ruler(p: RulerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ kind: 'scrub' | 'marker'; markerId?: string; startX: number; startTime?: number; moved: boolean; pointerId: number } | null>(null);
  const [markerLive, setMarkerLive] = useState<{ id: string; time: number } | null>(null);
  const lastClick = useRef<{ id: string; at: number }>({ id: '', at: 0 });

  const offRef = useRef<OffscreenCanvas | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const dpr = window.devicePixelRatio || 1;
  // The scroller holds the whole device pixels of the view's scroll (set before paint, like the tracks scroller);
  // view positions plus `base` are content positions.
  const { base, baseDev } = splitScroll(p.scroll * p.zoom, dpr);
  const baseRef = useRef(base);
  baseRef.current = base;
  useLayoutEffect(() => { const el = scrollerRef.current; if (el) el.scrollLeft = base; }, [base, p.contentPx, p.width]);
  /** The offset belongs to the view: undo any other scroll of the (hidden-bar) scroller. */
  const onScrollerScroll = () => { const el = scrollerRef.current; if (el && Math.abs(el.scrollLeft - baseRef.current) > 1) el.scrollLeft = baseRef.current; };
  // Canvas placement: the mounted range on the device pixel grid.
  const cvDev0 = Math.floor(Math.max(0, Math.min(p.mountX0, base)) * dpr);
  const cvDevW = Math.max(1, Math.ceil(Math.max(p.mountX1, base + p.width) * dpr) - cvDev0);

  useLayoutEffect(() => {
    const cv = canvasRef.current; if (!cv || p.width <= 0) return;
    const W = Math.round(p.width), H = RULER_H;
    if (cv.width !== cvDevW) cv.width = cvDevW;
    if (cv.height !== Math.round(H * dpr)) cv.height = Math.round(H * dpr);
    const left = `${cvDev0 / dpr}px`, width = `${cvDevW / dpr}px`, height = `${H}px`;
    if (cv.style.left !== left) cv.style.left = left;
    if (cv.style.width !== width) cv.style.width = width;
    if (cv.style.height !== height) cv.style.height = height;
    const ctx = cv.getContext('2d'); if (!ctx) return;
    // Draw into an OffscreenCanvas and copy it over: fillText on a canvas that is in the document first brings the
    // document's style up to date (the canvas' computed font / direction), which in the middle of a commit means a
    // forced style recalc of everything React just changed (a page flip mounts a page of clips). An offscreen canvas
    // has no element, so its text needs no style; the copied pixels are the same.
    let off: OffscreenCanvas | null = null;
    let octx: OffscreenCanvasRenderingContext2D | null = null;
    if (typeof OffscreenCanvas !== 'undefined') {
      off = offRef.current ?? (offRef.current = new OffscreenCanvas(cv.width, cv.height));
      if (off.width !== cv.width) off.width = cv.width;
      if (off.height !== cv.height) off.height = cv.height;
      octx = off.getContext('2d');
    }
    const g = octx ?? ctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = COLORS.bg; g.fillRect(0, 0, cvDevW, cv.height);
    // The view's drawing, in view coordinates, moved by whole device pixels to where the viewport is on the canvas.
    g.setTransform(dpr, 0, 0, dpr, baseDev - cvDev0, 0);
    g.fillRect(0, 0, W, H);
    const ticks = rulerTicks(p.fps, p.zoom, p.scroll, W);
    g.font = RULER_FONT;
    g.textBaseline = 'alphabetic';
    // One path (and one stroke) per tick kind instead of one per tick: this runs on every scroll / page flip.
    // Ticks never overlap, so the pixels are the same as stroking them one by one.
    g.lineWidth = 1;
    g.strokeStyle = COLORS.minor; g.beginPath();
    for (const t of ticks) if (!t.major) { const x = Math.round(t.x) + 0.5; g.moveTo(x, H - 5); g.lineTo(x, H); }
    g.stroke();
    g.strokeStyle = COLORS.major; g.beginPath();
    for (const t of ticks) if (t.major) { const x = Math.round(t.x) + 0.5; g.moveTo(x, H - 12); g.lineTo(x, H); }
    g.stroke();
    g.fillStyle = COLORS.label;
    for (const t of ticks) if (t.major && t.label) g.fillText(t.label, Math.round(t.x) + 0.5 + 3, 11);
    g.strokeStyle = COLORS.edge; g.beginPath(); g.moveTo(0, H - 0.5); g.lineTo(W, H - 0.5); g.stroke();
    if (off && octx) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.drawImage(off, 0, 0);
    }
  }, [p.fps, p.zoom, p.scroll, p.width, dpr, baseDev, cvDev0, cvDevW]);

  const frameAt = (clientX: number, e?: { altKey: boolean }) => {
    const r = rootRef.current!.getBoundingClientRect();
    const f = xToFrameInt(clientX - r.left, p.zoom, p.scroll);
    if (p.snapping && !e?.altKey) return snapFrame(f, p.snapCandidates(), snapThresholdFrames(p.zoom)).frame;
    return f;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const markerEl = (e.target as HTMLElement).closest<HTMLElement>('[data-marker-id]');
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (markerEl) {
      const id = markerEl.dataset.markerId!;
      const m = p.markers.find((x) => x.id === id);
      drag.current = { kind: 'marker', markerId: id, startX: e.clientX, startTime: m?.time ?? 0, moved: false, pointerId: e.pointerId };
      useStore.getState().selectMarker(id);
      return;
    }
    drag.current = { kind: 'scrub', startX: e.clientX, moved: false, pointerId: e.pointerId };
    p.onScrubStart?.();
    useStore.getState().setView(p.seqId, { playhead: frameAt(e.clientX, e) });
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current; if (!d) return;
    if (d.kind === 'scrub') { useStore.getState().setView(p.seqId, { playhead: frameAt(e.clientX, e) }); return; }
    const dx = e.clientX - d.startX;
    if (!d.moved && Math.abs(dx) < 3) return;
    d.moved = true;
    let t = Math.max(0, Math.round((d.startTime ?? 0) + dx / p.zoom));
    if (p.snapping && !e.altKey) t = snapFrame(t, p.snapCandidates(), snapThresholdFrames(p.zoom)).frame;
    setMarkerLive({ id: d.markerId!, time: t });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current; if (!d) return;
    drag.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(d.pointerId); } catch { /* ignore */ }
    if (d.kind === 'scrub') { p.onScrubEnd?.(); return; }
    const id = d.markerId!;
    if (d.moved && markerLive && markerLive.id === id) {
      useStore.getState().updateMarker(p.seqId, id, { time: markerLive.time });
    } else if (!d.moved) {
      // manual double-click detection (pointer capture swallows dblclick on some platforms)
      const now = performance.now();
      if (lastClick.current.id === id && now - lastClick.current.at < 350) {
        const m = p.markers.find((x) => x.id === id);
        if (m) p.onMarkerEdit(m, { x: e.clientX, y: e.clientY });
        lastClick.current = { id: '', at: 0 };
      } else lastClick.current = { id, at: now };
    }
    setMarkerLive(null);
  };

  // In / out band: view position plus `base` (content), not clipped to the view (the clipped-off part is invisible); an
  // open end reaches just past the content edge, as it reached past the view's.
  const inX = p.inPoint !== null ? frameToX(p.inPoint, p.zoom, p.scroll) + base : null;
  const outX = p.outPoint !== null ? frameToX(p.outPoint, p.zoom, p.scroll) + base : null;
  const showInOut = inX !== null || outX !== null;
  const bandL = inX ?? -2;
  const bandR = outX ?? p.contentPx + 2;

  return (
    <div
      ref={rootRef} className="tl-ruler" style={{ height: RULER_H }}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
      onContextMenu={(e) => {
        const markerEl = (e.target as HTMLElement).closest<HTMLElement>('[data-marker-id]');
        if (markerEl) { const m = p.markers.find((x) => x.id === markerEl.dataset.markerId); if (m) { p.onMarkerMenu(m, e); return; } }
        const r = rootRef.current!.getBoundingClientRect();
        p.onContextMenu(xToFrameInt(e.clientX - r.left, p.zoom, p.scroll), e);
      }}
      title="Click or drag to scrub"
    >
      <div className="tl-ruler-scroll" ref={scrollerRef} onScroll={onScrollerScroll}>
        <div className="tl-ruler-content" style={{ width: p.contentPx }}>
          <canvas ref={canvasRef} />
          {showInOut ? (
            <div className={['tl-ruler-inout', inX === null ? 'open-start' : '', outX === null ? 'open-end' : ''].filter(Boolean).join(' ')}
              style={{ left: Math.max(-2, bandL), width: Math.max(0, Math.min(p.contentPx + 2, bandR) - Math.max(-2, bandL)) }} />
          ) : null}
          <div className="tl-ruler-markers">
            {p.markers.map((m) => {
              const time = markerLive?.id === m.id ? markerLive.time : m.time;
              const vx = frameToX(time, p.zoom, p.scroll);
              const x = vx + base;
              // A marker within 12 px of the view shows; one further out is invisible, so it may stay mounted while the
              // timeline's mounted range holds it (scroll steps then change no marker). Its span still follows the view
              // margin as it always did.
              const inView = vx >= -12 && vx <= p.width + 12;
              if (!inView && (x < p.mountX0 - 12 || x > p.mountX1 + 12)) return null;
              const sel = m.id === p.selectedMarkerId;
              const spanW = m.duration > 0 && inView ? m.duration * p.zoom : 0;
              return (
                <React.Fragment key={m.id}>
                  {spanW > 0 ? <div className="tl-marker-span" style={{ left: x, width: spanW, background: m.color }} /> : null}
                  {sel ? <div className="tl-marker-ring" style={{ left: x }} /> : null}
                  <div
                    className={['tl-marker', m.kind, m.resolved ? 'resolved' : '', sel ? 'selected' : ''].filter(Boolean).join(' ')}
                    data-marker-id={m.id} style={{ left: x, background: m.color }}
                    title={`${m.name || 'Marker'} · ${formatSequenceTimecode(time, p.fps)}${m.note ? `\n${m.note}` : ''}`}
                    onDoubleClick={(e) => { e.stopPropagation(); p.onMarkerEdit(m, { x: e.clientX, y: e.clientY }); }}
                  />
                </React.Fragment>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
