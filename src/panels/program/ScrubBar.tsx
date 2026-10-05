import React, { useCallback, useRef } from 'react';
import type { Marker } from '@shared/model';
import { clamp } from '@shared/time';
import { useFrame, type FrameSignal } from './frameSignal';

export interface ScrubBarProps {
  durationFrames: number;
  inPoint: number | null;
  outPoint: number | null;
  markers: readonly Marker[];
  frame: FrameSignal;
  /** Called with the frame under the pointer while scrubbing. */
  onScrub(frame: number, phase: 'start' | 'move' | 'end'): void;
}

function Playhead({ frame, duration }: { frame: FrameSignal; duration: number }) {
  const f = useFrame(frame);
  const pct = duration > 0 ? clamp(f / duration, 0, 1) * 100 : 0;
  return <div className="pm-scrub-playhead" style={{ left: `${pct}%` }} data-testid="program-scrub-playhead" />;
}

/** Duration strip under the video: in/out range, markers, playhead. Click or drag scrubs. */
export function ScrubBar({ durationFrames, inPoint, outPoint, markers, frame, onScrub }: ScrubBarProps) {
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const duration = Math.max(1, durationFrames);

  const frameAt = useCallback((clientX: number) => {
    const el = ref.current; if (!el) return 0;
    const r = el.getBoundingClientRect();
    return clamp(Math.round(((clientX - r.left) / Math.max(1, r.width)) * duration), 0, duration);
  }, [duration]);

  const pct = (f: number) => `${clamp(f / duration, 0, 1) * 100}%`;
  const rangeIn = inPoint ?? (outPoint !== null ? 0 : null);
  const rangeOut = outPoint ?? (inPoint !== null ? duration : null);

  return (
    <div
      ref={ref} className="pm-scrub" role="slider" aria-label="Scrub" aria-valuemin={0} aria-valuemax={duration} data-testid="program-scrub"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        dragging.current = true;
        onScrub(frameAt(e.clientX), 'start');
      }}
      onPointerMove={(e) => { if (dragging.current) onScrub(frameAt(e.clientX), 'move'); }}
      onPointerUp={(e) => {
        if (!dragging.current) return;
        dragging.current = false;
        try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
        onScrub(frameAt(e.clientX), 'end');
      }}
      onPointerCancel={() => { dragging.current = false; }}
    >
      <div className="pm-scrub-track" />
      {rangeIn !== null && rangeOut !== null && rangeOut > rangeIn ? (
        <div className="pm-scrub-range" style={{ left: pct(rangeIn), width: `calc(${pct(rangeOut)} - ${pct(rangeIn)})` }} />
      ) : null}
      {markers.map((m) => (
        <div
          key={m.id}
          className={['pm-scrub-marker', m.kind === 'continuity' ? 'continuity' : '', m.duration > 0 ? 'span' : ''].filter(Boolean).join(' ')}
          style={{
            left: pct(m.time),
            ...(m.duration > 0 ? { width: `calc(${pct(m.time + m.duration)} - ${pct(m.time)})`, transform: 'none' } : null),
            ...(m.kind === 'continuity' ? null : { background: m.color || 'var(--label-forest)' }),
          }}
          title={`${m.kind === 'continuity' ? 'Continuity: ' : ''}${m.name || 'Marker'}`}
        />
      ))}
      <Playhead frame={frame} duration={duration} />
    </div>
  );
}
