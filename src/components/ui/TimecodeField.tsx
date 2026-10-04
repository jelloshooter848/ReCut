import React, { useEffect, useRef, useState } from 'react';
import type { Rational } from '@shared/model';
import { formatTimecode, parseTimecode, clamp } from '@shared/time';

export interface TimecodeFieldProps {
  /** Frames at `fps`. */
  value: number;
  fps: Rational;
  onChange: (frames: number) => void;
  onCommit?: (frames: number) => void;
  min?: number;
  max?: number;
  disabled?: boolean;
  /** Allow horizontal drag to scrub frames (default true). */
  scrub?: boolean;
  /** Pixels per frame when scrubbing (default 3). Shift = 10 frames per step. */
  pxPerFrame?: number;
  className?: string;
  title?: string;
  /** Use ';' for drop-frame rates. */
  dropIndicator?: boolean;
  /** Dim style for durations/secondary values. */
  tone?: 'playhead' | 'default';
}

/**
 * Premiere-style entry for an unseparated digit string: fields fill FF, SS, MM, HH from the right in pairs
 * ("1512" → "15:12", "500" → "5:00", "11500" → "1:15:00"). Anything else ("+24", "1:00", "1.10") is returned as is.
 */
export function expandTimecodeDigits(input: string): string {
  const t = input.trim();
  if (!/^\d+$/.test(t)) return t;
  const parts: string[] = [];
  for (let end = t.length; end > 0; end -= 2) parts.unshift(t.slice(Math.max(0, end - 2), end));
  return parts.slice(-4).join(':');
}

/** Parse typed timecode text (see `expandTimecodeDigits`; "+N" / "-N" stay frames relative to `current`). */
export function parseTimecodeEntry(input: string, fps: Rational, current = 0): number | null {
  return parseTimecode(expandTimecodeDigits(input), fps, current);
}

/**
 * Timecode display/editor (HH:MM:SS:FF). Click to type (accepts "01:00:00:00", "1:00", "1512" = 15 s 12 f, "+24", "-12"), drag to scrub.
 */
export function TimecodeField({ value, fps, onChange, onCommit, min = -Infinity, max = Infinity, disabled, scrub = true, pxPerFrame = 3, className = '', title, dropIndicator = true, tone = 'playhead' }: TimecodeFieldProps) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [invalid, setInvalid] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const drag = useRef<{ startX: number; startValue: number; moved: boolean; pointerId: number } | null>(null);

  useEffect(() => { if (editing) { inputRef.current?.focus(); inputRef.current?.select(); } }, [editing]);

  const startEdit = () => { if (disabled) return; setText(formatTimecode(value, fps, { dropIndicator })); setInvalid(false); setEditing(true); };
  const commit = () => {
    const parsed = parseTimecodeEntry(text, fps, value);
    if (parsed === null) { setInvalid(true); return; }
    const v = Math.round(clamp(parsed, min, max));
    setEditing(false); onChange(v); onCommit?.(v);
  };

  return (
    <div
      className={['numfield', 'tcfield', 'mono', tone === 'default' ? 'text-dim' : '', editing ? 'editing' : '', invalid ? 'invalid' : '', className].filter(Boolean).join(' ')}
      style={{ ...(disabled ? { opacity: 0.45 } : null), ...(scrub ? null : { cursor: 'text' }), ...(tone === 'default' ? { color: 'var(--text)' } : null) }}
      title={title} tabIndex={disabled ? -1 : 0}
      onPointerDown={(e) => {
        if (disabled || editing || e.button !== 0) return;
        e.preventDefault();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        drag.current = { startX: e.clientX, startValue: value, moved: false, pointerId: e.pointerId };
      }}
      onPointerMove={(e) => {
        const d = drag.current; if (!d || !scrub) return;
        const dx = e.clientX - d.startX;
        if (!d.moved && Math.abs(dx) < 3) return;
        d.moved = true;
        const frames = Math.round(dx / pxPerFrame) * (e.shiftKey ? 10 : 1);
        const v = clamp(d.startValue + frames, min, max);
        if (v !== value) onChange(v);
      }}
      onPointerUp={(e) => {
        const d = drag.current; if (!d) return;
        drag.current = null;
        (e.currentTarget as HTMLElement).releasePointerCapture(d.pointerId);
        if (d.moved) onCommit?.(value); else startEdit();
      }}
      onKeyDown={(e) => {
        if (editing) {
          if (e.key === 'Enter') commit(); // no preventDefault: a surrounding Dialog may run its primary action
          else if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
          e.stopPropagation();
          return;
        }
        if (e.key === 'Enter') { e.preventDefault(); startEdit(); }
      }}
    >
      {editing ? (
        <input ref={inputRef} className="mono" value={text} onChange={(e) => { setText(e.target.value); setInvalid(false); }} onBlur={() => { if (editing) commit(); if (invalid) setEditing(false); }} spellCheck={false} />
      ) : (
        <span>{formatTimecode(value, fps, { dropIndicator })}</span>
      )}
    </div>
  );
}
