import React, { useCallback, useRef, useState } from 'react';
import { clamp } from '@shared/time';

export interface SliderProps {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
  onCommit?: (value: number) => void;
  disabled?: boolean;
  className?: string;
  title?: string;
  /** Value to reset to on double click. */
  defaultValue?: number;
}

export function Slider({ value, min = 0, max = 1, step = 0, onChange, onCommit, disabled, className = '', title, defaultValue }: SliderProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const pct = max > min ? ((clamp(value, min, max) - min) / (max - min)) * 100 : 0;

  const valueAt = useCallback((clientX: number) => {
    const el = ref.current; if (!el) return value;
    const r = el.getBoundingClientRect();
    let v = min + ((clientX - r.left) / Math.max(1, r.width)) * (max - min);
    if (step > 0) v = Math.round(v / step) * step;
    return clamp(v, min, max);
  }, [min, max, step, value]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(true);
    onChange(valueAt(e.clientX));
  };
  const onPointerMove = (e: React.PointerEvent) => { if (dragging) onChange(valueAt(e.clientX)); };
  const onPointerUp = (e: React.PointerEvent) => {
    if (!dragging) return;
    setDragging(false);
    const v = valueAt(e.clientX);
    onChange(v); onCommit?.(v);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const s = step > 0 ? step : (max - min) / 100;
    const mul = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); const v = clamp(value - s * mul, min, max); onChange(v); onCommit?.(v); }
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); const v = clamp(value + s * mul, min, max); onChange(v); onCommit?.(v); }
  };

  return (
    <div
      ref={ref}
      className={['slider', dragging ? 'dragging' : '', disabled ? 'disabled' : '', className].filter(Boolean).join(' ')}
      role="slider" tabIndex={disabled ? -1 : 0} aria-valuemin={min} aria-valuemax={max} aria-valuenow={value} title={title}
      style={disabled ? { opacity: 0.45 } : undefined}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
      onDoubleClick={() => { if (defaultValue !== undefined) { onChange(defaultValue); onCommit?.(defaultValue); } }}
      onKeyDown={onKeyDown}
    >
      <div className="slider-track" />
      <div className="slider-fill" style={{ width: `${pct}%` }} />
      <div className="slider-thumb" style={{ left: `${pct}%` }} />
    </div>
  );
}
