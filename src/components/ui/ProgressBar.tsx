import React from 'react';

export interface ProgressBarProps {
  /** 0..1; omit for indeterminate */
  value?: number;
  tone?: 'accent' | 'ok' | 'danger';
  className?: string;
  title?: string;
}

export function ProgressBar({ value, tone = 'accent', className = '', title }: ProgressBarProps) {
  const indeterminate = value === undefined || Number.isNaN(value);
  const pct = indeterminate ? 0 : Math.max(0, Math.min(1, value!)) * 100;
  return (
    <div className={['progress', tone !== 'accent' ? tone : '', indeterminate ? 'indeterminate' : '', className].filter(Boolean).join(' ')} title={title}
      role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={indeterminate ? undefined : Math.round(pct)}>
      <div className="progress-bar" style={{ width: `${pct}%` }} />
    </div>
  );
}
