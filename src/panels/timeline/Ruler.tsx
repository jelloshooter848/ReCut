/**
 * Timecode ruler: canvas ticks + DOM markers / in-out band. Scrubs the playhead on click/drag, drags markers.
 */
import React, { useLayoutEffect, useRef, useState } from 'react';
import type { Marker, Rational } from '@shared/model';
import { formatTimecode } from '@shared/time';
import { useStore } from '@/state';
import { frameToX, rulerTicks, snapFrame, snapThresholdFrames, xToFrameInt } from './viewMath';
import { RULER_H } from './types';

export interface RulerProps {
  seqId: string;
  fps: Rational;
  zoom: number;
  scroll: number;
  width: number;
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

export function Ruler(p: RulerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ kind: 'scrub' | 'marker'; markerId?: string; startX: number; startTime?: number; moved: boolean; pointerId: number } | null>(null);
  const [markerLive, setMarkerLive] = useState<{ id: string; time: number } | null>(null);
  const lastClick = useRef<{ id: string; at: number }>({ id: '', at: 0 });

  useLayoutEffect(() => {
    const cv = canvasRef.current; if (!cv || p.width <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(p.width), H = RULER_H;
    if (cv.width !== Math.round(W * dpr)) cv.width = Math.round(W * dpr);
    if (cv.height !== Math.round(H * dpr)) cv.height = Math.round(H * dpr);
    cv.style.width = `${W}px`; cv.style.height = `${H}px`;
    const ctx = cv.getContext('2d'); if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = COLORS.bg; ctx.fillRect(0, 0, W, H);
    const ticks = rulerTicks(p.fps, p.zoom, p.scroll, W);
    ctx.font = '10px "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace';
    ctx.textBaseline = 'alphabetic';
    for (const t of ticks) {
      const x = Math.round(t.x) + 0.5;
      if (t.major) {
        ctx.strokeStyle = COLORS.major; ctx.beginPath(); ctx.moveTo(x, H - 12); ctx.lineTo(x, H); ctx.stroke();
        if (t.label) { ctx.fillStyle = COLORS.label; ctx.fillText(t.label, x + 3, 11); }
      } else {
        ctx.strokeStyle = COLORS.minor; ctx.beginPath(); ctx.moveTo(x, H - 5); ctx.lineTo(x, H); ctx.stroke();
      }
    }
    ctx.strokeStyle = COLORS.edge; ctx.beginPath(); ctx.moveTo(0, H - 0.5); ctx.lineTo(W, H - 0.5); ctx.stroke();
  }, [p.fps, p.zoom, p.scroll, p.width]);

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

  const inX = p.inPoint !== null ? frameToX(p.inPoint, p.zoom, p.scroll) : null;
  const outX = p.outPoint !== null ? frameToX(p.outPoint, p.zoom, p.scroll) : null;
  const showInOut = inX !== null || outX !== null;
  const bandL = inX ?? -2;
  const bandR = outX ?? p.width + 2;

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
      <canvas ref={canvasRef} />
      {showInOut && bandR > 0 && bandL < p.width ? (
        <div className={['tl-ruler-inout', inX === null ? 'open-start' : '', outX === null ? 'open-end' : ''].filter(Boolean).join(' ')}
          style={{ left: Math.max(-2, bandL), width: Math.max(0, Math.min(p.width + 2, bandR) - Math.max(-2, bandL)) }} />
      ) : null}
      <div className="tl-ruler-markers">
        {p.markers.map((m) => {
          const time = markerLive?.id === m.id ? markerLive.time : m.time;
          const x = frameToX(time, p.zoom, p.scroll);
          if (x < -12 || x > p.width + 12) return null;
          const sel = m.id === p.selectedMarkerId;
          const spanW = m.duration > 0 ? m.duration * p.zoom : 0;
          return (
            <React.Fragment key={m.id}>
              {spanW > 0 ? <div className="tl-marker-span" style={{ left: x, width: spanW, background: m.color }} /> : null}
              {sel ? <div className="tl-marker-ring" style={{ left: x }} /> : null}
              <div
                className={['tl-marker', m.kind, m.resolved ? 'resolved' : '', sel ? 'selected' : ''].filter(Boolean).join(' ')}
                data-marker-id={m.id} style={{ left: x, background: m.color }}
                title={`${m.name || 'Marker'} · ${formatTimecode(time, p.fps)}${m.note ? `\n${m.note}` : ''}`}
                onDoubleClick={(e) => { e.stopPropagation(); p.onMarkerEdit(m, { x: e.clientX, y: e.clientY }); }}
              />
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}
