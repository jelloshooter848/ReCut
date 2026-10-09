/**
 * Inspector building blocks: collapsible Section (collapsed state persisted in localStorage), 2-column property Row,
 * copyable read-only Value, and small formatting helpers shared by the inspectors.
 */
import React, { useSyncExternalStore } from 'react';
import { ChevronDown, ChevronRight, Copy, RotateCcw } from 'lucide-react';
import type { MediaProbe, Rational } from '@shared/model';
import { formatSequenceTimecode, formatClock } from '@shared/time';
import { toast } from '@/components/ui/toastStore';
import { useStore } from '@/state';
import type { Recipe } from '@/state';

// ------------------------------------------------------------------ collapsed-state store
// frozen: changing this would reset every user's saved collapsed Inspector sections (the key is read from the browser storage the
// user-data folder carries along; it is invisible to users).
const KEY = 'recut.inspector.collapsed.v1';
let collapsed: Record<string, boolean> = (() => {
  try { const raw = localStorage.getItem(KEY); return raw ? (JSON.parse(raw) as Record<string, boolean>) : {}; } catch { return {}; }
})();
const listeners = new Set<() => void>();
function subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }
export function setSectionCollapsed(id: string, value: boolean): void {
  collapsed = { ...collapsed, [id]: value };
  try { localStorage.setItem(KEY, JSON.stringify(collapsed)); } catch { /* storage unavailable */ }
  listeners.forEach((l) => l());
}
export function useSectionCollapsed(id: string, fallback = false): boolean {
  return useSyncExternalStore(subscribe, () => collapsed[id] ?? fallback, () => fallback);
}

// ------------------------------------------------------------------ Section
export interface SectionProps {
  id: string;
  title: React.ReactNode;
  badge?: React.ReactNode;
  actions?: React.ReactNode;
  defaultCollapsed?: boolean;
  children: React.ReactNode;
}

export function Section({ id, title, badge, actions, defaultCollapsed = false, children }: SectionProps) {
  const isCollapsed = useSectionCollapsed(id, defaultCollapsed);
  const Chev = isCollapsed ? ChevronRight : ChevronDown;
  return (
    <div className="insp-section" data-section={id} data-collapsed={isCollapsed ? '1' : '0'}>
      <div className="insp-section-h" role="button" aria-expanded={!isCollapsed} title={isCollapsed ? 'Expand' : 'Collapse'}
        onClick={() => setSectionCollapsed(id, !isCollapsed)}>
        <Chev className="chev" />
        <span className="insp-section-title">{title}</span>
        {badge !== undefined && badge !== null ? <span className="insp-section-badge">{badge}</span> : null}
        {actions ? <span className="insp-section-actions" onClick={(e) => e.stopPropagation()}>{actions}</span> : null}
      </div>
      {!isCollapsed ? <div className="insp-section-body">{children}</div> : null}
    </div>
  );
}

// ------------------------------------------------------------------ Row
export interface RowProps {
  label: React.ReactNode;
  /** data-prop hook for tests / automation */
  prop?: string;
  children: React.ReactNode;
  onReset?: () => void;
  /** Reset button only enabled when the value differs from its default. */
  canReset?: boolean;
  title?: string;
  /** Align label to the top (multi-line controls). */
  top?: boolean;
  strong?: boolean;
}

export function Row({ label, prop, children, onReset, canReset = true, title, top, strong }: RowProps) {
  return (
    <div className={['insp-row', top ? 'top' : ''].filter(Boolean).join(' ')} data-prop={prop} title={title}>
      <div className={['insp-label', strong ? 'strong' : ''].filter(Boolean).join(' ')}>{label}</div>
      <div className="insp-ctl">
        {children}
        {onReset ? (
          <button type="button" className="insp-reset" title="Reset to default" aria-label="Reset" disabled={!canReset} onClick={onReset}>
            <RotateCcw />
          </button>
        ) : null}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Value (read-only, copyable)
export interface ValueProps {
  children: React.ReactNode;
  /** Text copied on click (defaults to none → not copyable). */
  copy?: string;
  onClick?: () => void;
  title?: string;
  dim?: boolean;
  className?: string;
  testId?: string;
  /** Allow wrapping onto several lines instead of truncating with an ellipsis. */
  wrap?: boolean;
}

export function copyText(text: string): void {
  try {
    navigator.clipboard?.writeText(text)
      .then(() => toast.info(`Copied ${text.length > 40 ? text.slice(0, 40) + '…' : text}`))
      .catch(() => { /* clipboard permission denied */ });
  } catch { /* clipboard unavailable */ }
}

export function Value({ children, copy, onClick, title, dim, className = '', testId, wrap }: ValueProps) {
  const clickable = !!copy || !!onClick;
  return (
    <span
      data-testid={testId}
      className={['insp-val', copy ? 'copy' : '', onClick ? 'link' : '', dim ? 'dim' : '', wrap ? 'wrap' : '', className].filter(Boolean).join(' ')}
      title={title ?? (copy ? 'Click to copy' : undefined)}
      role={clickable ? 'button' : undefined}
      onClick={clickable ? () => { if (onClick) onClick(); else if (copy) copyText(copy); } : undefined}
    >
      <span className="insp-val-text">{children}</span>
      {copy && !onClick ? <Copy /> : null}
    </span>
  );
}

/** "a → b" range that wraps at the arrow when the column is narrow (never clips). */
export function Range({ a, b, copy = true, dim, testId }: { a: string; b: string; copy?: boolean; dim?: boolean; testId?: string }) {
  return (
    <Value copy={copy ? `${a} → ${b}` : undefined} dim={dim} testId={testId} wrap>
      <span className="nowrap">{a}</span>{' '}<span className="nowrap"><span className="arrow">→ </span>{b}</span>
    </Value>
  );
}

// ------------------------------------------------------------------ transactional edits (scrub = one undo step)
/**
 * NumberField / Slider fire onChange for every scrub step and onCommit once at the end (also after a typed value).
 * Routing onChange → `transient` and onCommit → `finish(label)` turns the whole drag into one history entry.
 */
export function transient(recipe: Recipe): void { useStore.getState().updateTransient(recipe); }
export function finish(label: string): void { useStore.getState().endTransaction(label); }

// ------------------------------------------------------------------ formatting helpers
export const MIXED = '—';

/** Select options for a file's audio streams: value = absolute stream index, label = "#<n> codec layout lang — title". */
export function audioStreamOptions(probe: MediaProbe | undefined): { value: string; label: string }[] {
  return (probe?.audio ?? []).map((a, i) => ({ value: String(a.index), label: `#${i + 1} ${a.codec} ${a.layout || `${a.channels}ch`}${a.language ? ` ${a.language}` : ''}${a.title ? ` — ${a.title}` : ''}` }));
}

export function allSame<T, V>(items: T[], pick: (t: T) => V): boolean {
  if (items.length <= 1) return true;
  const first = pick(items[0]);
  return items.every((i) => pick(i) === first);
}

export function tc(frames: number, fps: Rational): string { return formatSequenceTimecode(frames, fps); }
export function framesLabel(frames: number, fps: Rational): string { return `${tc(frames, fps)} · ${frames} fr`; }
export function secondsLabel(sec: number): string { return `${sec.toFixed(3)}s`; }
export function clock(sec: number): string { return formatClock(sec, true); }

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes; let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : v < 10 ? 2 : 1)} ${units[i]}`;
}

export function dbFromLinear(v: number): number { return v <= 0 ? -60 : Math.max(-60, 20 * Math.log10(v)); }
export function linearFromDb(db: number): number { return db <= -60 ? 0 : Math.pow(10, db / 20); }

export function pluralize(n: number, one: string, many = `${one}s`): string { return `${n} ${n === 1 ? one : many}`; }

export function openInFolder(path: string): void {
  const api = typeof window !== 'undefined' ? window.recut : undefined;
  if (api?.showItemInFolder) void api.showItemInFolder(path).catch(() => toast.warn('Could not reveal file'));
  else copyText(path);
}
