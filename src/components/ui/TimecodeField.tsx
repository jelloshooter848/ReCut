import React, { useEffect, useRef, useState } from 'react';
import type { Rational } from '@shared/model';
import { formatTimecode, formatSequenceTimecode, parseTimecode, parseSequenceTimecode, expandTimecodeDigits, clamp } from '@shared/time';

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
  /**
   * Show and enter SMPTE drop-frame (HH:MM:SS;FF) at 29.97 / 59.94: the app-wide rule (default true). False forces
   * non-drop display and entry. Other rates are always non-drop.
   */
  dropIndicator?: boolean;
  /** Dim style for durations/secondary values. */
  tone?: 'playhead' | 'default';
}

export { expandTimecodeDigits };

/**
 * Parse typed timecode text the way the field displays it. With `dropIndicator` (the default) this is the
 * app-wide rule, parseSequenceTimecode: at 29.97 / 59.94 the field shows drop-frame, and digit-only shorthand
 * ("1000000") and ':'-separated input ("1:00:00:00") are read as drop-frame labels too, so typing what you see
 * lands on the frame you saw. Without it (a field forced to non-drop) input is non-drop unless it contains ';'.
 * "+N" / "-N" stay frames relative to `current`.
 */
export function parseTimecodeEntry(input: string, fps: Rational, current = 0, dropIndicator = true): number | null {
  return dropIndicator ? parseSequenceTimecode(input, fps, current) : parseTimecode(expandTimecodeDigits(input), fps, current);
}

/** The text a TimecodeField shows for `value` (the app-wide rule, or non-drop when `dropIndicator` is false). */
export function timecodeFieldText(value: number, fps: Rational, dropIndicator = true): string {
  return dropIndicator ? formatSequenceTimecode(value, fps) : formatTimecode(value, fps);
}

/**
 * Timecode display/editor (HH:MM:SS:FF, or HH:MM:SS;FF drop-frame at 29.97 / 59.94). Click to type (accepts
 * "01:00:00:00", "1:00", "1512" = 15 s 12 f, "+24", "-12"), drag to scrub. Typed text is read in the format the
 * field displays: on a drop-frame field "1:00:00:00" / "1000000" mean the label 01:00:00;00 (see parseTimecodeEntry).
 */
export function TimecodeField({ value, fps, onChange, onCommit, min = -Infinity, max = Infinity, disabled, scrub = true, pxPerFrame = 3, className = '', title, dropIndicator = true, tone = 'playhead' }: TimecodeFieldProps) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [invalid, setInvalid] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const drag = useRef<{ startX: number; startValue: number; moved: boolean; pointerId: number } | null>(null);

  useEffect(() => { if (editing) { inputRef.current?.focus(); inputRef.current?.select(); } }, [editing]);

  const startEdit = () => { if (disabled) return; setText(timecodeFieldText(value, fps, dropIndicator)); setInvalid(false); setEditing(true); };
  const commit = () => {
    const parsed = parseTimecodeEntry(text, fps, value, dropIndicator);
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
        <span>{timecodeFieldText(value, fps, dropIndicator)}</span>
      )}
    </div>
  );
}
