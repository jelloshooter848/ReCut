import React, { useEffect, useRef, useState } from 'react';
import { clamp } from '@shared/time';

export interface NumberFieldProps {
  value: number;
  onChange: (value: number) => void;
  /** Fires once at the end of a drag or on commit of typed value. */
  onCommit?: (value: number) => void;
  min?: number;
  max?: number;
  /** Value change per pixel of drag (default derived from step). */
  step?: number;
  /** Decimal places shown. */
  precision?: number;
  unit?: string;
  label?: string;
  disabled?: boolean;
  className?: string;
  title?: string;
  /** Pixels of drag per step (default 2). */
  pxPerStep?: number;
  /** Show '+' prefix for positive values. */
  signed?: boolean;
  /** Reset to this value on double click (Alt+click also resets). */
  defaultValue?: number;
  /** Override how the value is displayed. */
  format?: (v: number) => string;
  /** Override parsing of typed input; return null to reject. */
  parse?: (text: string) => number | null;
}

/**
 * Premiere-style scrubbable number: drag horizontally to change the value, click to type.
 * Shift = 10x step, Alt = 0.1x step.
 */
export function NumberField({
  value, onChange, onCommit, min = -Infinity, max = Infinity, step = 1, precision = 0, unit, label, disabled, className = '', title,
  pxPerStep = 2, signed, defaultValue, format, parse,
}: NumberFieldProps) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [scrubbing, setScrubbing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const drag = useRef<{ startX: number; startValue: number; moved: boolean; pointerId: number; lastX: number; acc: number } | null>(null);

  const round = (v: number) => { const f = Math.pow(10, precision); return Math.round(v * f) / f; };
  const display = (v: number) => {
    if (format) return format(v);
    const s = v.toFixed(precision);
    return signed && v > 0 ? `+${s}` : s;
  };

  /** Set when editing started from a typed character: keep the caret after it instead of selecting all. */
  const typedStart = useRef(false);
  useEffect(() => {
    if (!editing) return;
    const el = inputRef.current; if (!el) return;
    el.focus();
    if (typedStart.current) { typedStart.current = false; const n = el.value.length; el.setSelectionRange(n, n); } else el.select();
  }, [editing]);

  const startEdit = (initial?: string) => {
    if (disabled) return;
    typedStart.current = initial !== undefined;
    setText(initial ?? (precision > 0 ? value.toFixed(precision) : String(round(value))));
    setEditing(true);
  };
  const commitText = () => {
    setEditing(false);
    let v: number | null;
    if (parse) v = parse(text);
    else {
      const t = text.trim().replace(unit ?? '', '').trim();
      // allow simple relative input: "+5" / "-5" / "*2"
      if (/^[+-]\s*\d/.test(t) && t !== text.trim()) v = value + parseFloat(t);
      else { const n = parseFloat(t); v = Number.isFinite(n) ? n : null; }
    }
    if (v === null || !Number.isFinite(v)) return;
    v = round(clamp(v, min, max));
    onChange(v); onCommit?.(v);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (disabled || editing || e.button !== 0) return;
    if (e.altKey && defaultValue !== undefined) { onChange(defaultValue); onCommit?.(defaultValue); return; }
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startValue: value, moved: false, pointerId: e.pointerId, lastX: e.clientX, acc: 0 };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current; if (!d) return;
    const dx = e.clientX - d.startX;
    if (!d.moved && Math.abs(dx) < 3) return;
    if (!d.moved) { d.moved = true; setScrubbing(true); }
    const mul = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
    const delta = (e.clientX - d.lastX) / pxPerStep * step * mul;
    d.lastX = e.clientX; d.acc += delta;
    const v = round(clamp(d.startValue + d.acc, min, max));
    if (v !== value) onChange(v);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current; if (!d) return;
    drag.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture(d.pointerId);
    if (d.moved) { setScrubbing(false); onCommit?.(round(clamp(d.startValue + d.acc, min, max))); }
    else startEdit();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (editing) {
      // No preventDefault: a surrounding Dialog runs its primary action after the commit (Enter = Apply).
      if (e.key === 'Enter') commitText();
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditing(false); }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const mul = e.shiftKey ? 10 : 1;
        const n = parseFloat(text); if (!Number.isFinite(n)) return;
        const v = round(clamp(n + (e.key === 'ArrowUp' ? 1 : -1) * step * mul, min, max));
        setText(precision > 0 ? v.toFixed(precision) : String(v)); onChange(v);
      }
      e.stopPropagation();
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startEdit(); }
    else if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1 && /[0-9.+\-]/.test(e.key)) {
      // Typing a number on a focused field starts editing with that character (keyboard-first dialogs).
      e.preventDefault(); e.stopPropagation(); startEdit(e.key);
    }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const mul = e.shiftKey ? 10 : 1;
      const v = round(clamp(value + (e.key === 'ArrowUp' ? 1 : -1) * step * mul, min, max));
      onChange(v); onCommit?.(v);
    }
  };

  return (
    <div
      className={['numfield', editing ? 'editing' : '', scrubbing ? 'scrubbing' : '', className].filter(Boolean).join(' ')}
      title={title} tabIndex={disabled ? -1 : 0} role="spinbutton" aria-valuenow={value} aria-valuemin={Number.isFinite(min) ? min : undefined} aria-valuemax={Number.isFinite(max) ? max : undefined}
      style={disabled ? { opacity: 0.45 } : undefined}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
      onDoubleClick={() => { if (defaultValue !== undefined && !editing) { onChange(defaultValue); onCommit?.(defaultValue); } }}
      onKeyDown={onKeyDown}
    >
      {label ? <span className="nf-label">{label}</span> : null}
      {editing ? (
        <input ref={inputRef} value={text} onChange={(e) => setText(e.target.value)} onBlur={commitText} spellCheck={false} />
      ) : (
        <span>{display(value)}</span>
      )}
      {unit && !editing ? <span className="unit">{unit}</span> : null}
    </div>
  );
}
