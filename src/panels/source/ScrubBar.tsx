import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { DetectedScene, Rational, SubtitleCue } from '@shared/model';
import { clamp, formatSequenceTimecode, secondsToFrames } from '@shared/time';

export interface ScrubBarProps {
  /** Media duration in seconds (finite, > 0 to be interactive). */
  duration: number;
  /** Current time in seconds. */
  time: number;
  inPoint: number | null;
  outPoint: number | null;
  fps: Rational;
  scenes: readonly DetectedScene[];
  cues: readonly SubtitleCue[];
  /** Seek to a media frame (frame-centered by the player). */
  onSeekFrame: (frame: number) => void;
  onScrubStart?: () => void;
  onScrubEnd?: () => void;
}

/**
 * Full-width strip under the video: in/out range, playhead, detected scenes as faint ticks and subtitle cues
 * as faint blocks. Click/drag scrubs; hovering shows a timecode tooltip.
 */
export function ScrubBar({ duration, time, inPoint, outPoint, fps, scenes, cues, onSeekFrame, onScrubStart, onScrubEnd }: ScrubBarProps) {
  const ref = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<{ x: number; frame: number } | null>(null);
  const dragging = useRef<number | null>(null);
  const valid = Number.isFinite(duration) && duration > 0;
  const totalFrames = valid ? Math.max(1, secondsToFrames(duration, fps)) : 1;

  useEffect(() => {
    const el = ref.current; if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Scene ticks + cue blocks are static per media; draw them once per size change.
  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas || width === 0) return;
    const h = canvas.clientHeight || 20;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, h);
    if (!valid) return;
    const px = (sec: number) => (sec / duration) * width;
    // subtitle cues: faint blocks in the lower half
    ctx.fillStyle = 'rgba(232, 163, 61, 0.22)';
    for (const c of cues) {
      const x0 = px(c.start); const x1 = Math.max(x0 + 1, px(c.end));
      ctx.fillRect(x0, h * 0.55, x1 - x0, h * 0.35);
    }
    // detected scenes: faint tick at each boundary
    ctx.fillStyle = 'rgba(255, 255, 255, 0.28)';
    for (const s of scenes) {
      const x = Math.round(px(s.start));
      ctx.fillRect(x, 2, 1, h * 0.45);
    }
    // baseline
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(0, h - 1, width, 1);
  }, [width, duration, valid, scenes, cues]);

  const frameAt = useCallback((clientX: number): number => {
    const el = ref.current; if (!el) return 0;
    const r = el.getBoundingClientRect();
    const frac = clamp((clientX - r.left) / Math.max(1, r.width), 0, 1);
    return clamp(Math.floor(frac * totalFrames), 0, totalFrames - 1);
  }, [totalFrames]);

  const pct = (sec: number) => `${valid ? clamp(sec / duration, 0, 1) * 100 : 0}%`;
  const rangeIn = inPoint ?? (outPoint !== null ? 0 : null);
  const rangeOut = outPoint ?? (inPoint !== null ? duration : null);

  return (
    <div
      ref={ref}
      className="source-scrub"
      role="slider"
      aria-label="Scrub"
      aria-valuemin={0}
      aria-valuemax={totalFrames}
      aria-valuenow={valid ? secondsToFrames(time, fps) : 0}
      onPointerDown={(e) => {
        if (!valid || e.button !== 0) return;
        e.preventDefault();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        dragging.current = e.pointerId;
        onScrubStart?.();
        onSeekFrame(frameAt(e.clientX));
      }}
      onPointerMove={(e) => {
        if (!valid) return;
        const r = e.currentTarget.getBoundingClientRect();
        const frame = frameAt(e.clientX);
        setHover({ x: clamp(e.clientX - r.left, 0, r.width), frame });
        if (dragging.current !== null) onSeekFrame(frame);
      }}
      onPointerUp={(e) => {
        if (dragging.current === null) return;
        dragging.current = null;
        try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
        onScrubEnd?.();
      }}
      onPointerCancel={() => { dragging.current = null; onScrubEnd?.(); }}
      onPointerLeave={() => { if (dragging.current === null) setHover(null); }}
    >
      <canvas ref={canvasRef} />
      {valid && rangeIn !== null && rangeOut !== null ? (
        <div className="scrub-range" style={{ left: pct(rangeIn), width: `calc(${pct(rangeOut)} - ${pct(rangeIn)})` }} />
      ) : null}
      {valid ? <div className="scrub-playhead" style={{ left: pct(time) }} /> : null}
      {valid && hover ? (
        <div className="scrub-tip" style={{ left: hover.x }}>{formatSequenceTimecode(hover.frame, fps)}</div>
      ) : null}
    </div>
  );
}
