import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';

export interface VirtualListHandle {
  scrollToIndex(index: number, align?: 'nearest' | 'center'): void;
  element(): HTMLDivElement | null;
}

export interface VirtualListProps<T> {
  rows: T[];
  heightOf: (row: T, index: number) => number;
  render: (row: T, index: number) => React.ReactNode;
  keyOf: (row: T, index: number) => string;
  overscan?: number;
  className?: string;
  /** Rendered after the rows (inside the scroll area) e.g. empty state / padding. */
  footer?: React.ReactNode;
  containerProps?: Omit<React.HTMLAttributes<HTMLDivElement>, 'className' | 'onScroll'>;
  /** Called with the visible index range whenever it changes (thumbnail prefetch etc.). */
  onRange?: (start: number, end: number) => void;
}

/**
 * Minimal windowed list with variable (but known) row heights. Only the rows intersecting the viewport
 * (+ overscan) are mounted; rows are absolutely positioned so scrolling never relayouts siblings.
 */
function VirtualListInner<T>(
  { rows, heightOf, render, keyOf, overscan = 6, className = '', footer, containerProps, onRange }: VirtualListProps<T>,
  ref: React.ForwardedRef<VirtualListHandle>,
) {
  const el = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(0);

  const offsets = useMemo(() => {
    const out = new Float64Array(rows.length + 1);
    let acc = 0;
    for (let i = 0; i < rows.length; i++) { out[i] = acc; acc += heightOf(rows[i], i); }
    out[rows.length] = acc;
    return out;
  }, [rows, heightOf]);
  const total = offsets[rows.length] ?? 0;

  useLayoutEffect(() => {
    const node = el.current; if (!node) return;
    const measure = () => setViewH(node.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    return () => ro.disconnect();
  }, []);

  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => { setScrollTop(e.currentTarget.scrollTop); }, []);

  const findIndex = (y: number): number => {
    let lo = 0, hi = rows.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (offsets[mid] <= y) lo = mid; else hi = mid - 1; }
    return lo;
  };
  let start = 0, end = -1;
  if (rows.length > 0 && viewH > 0) {
    start = Math.max(0, findIndex(scrollTop) - overscan);
    end = Math.min(rows.length - 1, findIndex(scrollTop + viewH) + overscan);
  } else if (rows.length > 0) {
    end = Math.min(rows.length - 1, overscan * 3);
  }

  useEffect(() => { onRange?.(start, end); }, [start, end, onRange]);

  useImperativeHandle(ref, () => ({
    element: () => el.current,
    scrollToIndex(index, align = 'nearest') {
      const node = el.current; if (!node || index < 0 || index >= rows.length) return;
      const top = offsets[index], bottom = offsets[index + 1];
      const h = node.clientHeight;
      if (align === 'center') { node.scrollTop = Math.max(0, top - h / 2 + (bottom - top) / 2); return; }
      if (top < node.scrollTop) node.scrollTop = top;
      else if (bottom > node.scrollTop + h) node.scrollTop = bottom - h;
    },
  }), [offsets, rows.length]);

  const items: React.ReactNode[] = [];
  for (let i = start; i <= end; i++) {
    const row = rows[i];
    items.push(
      <div key={keyOf(row, i)} className="pp-vl-row" style={{ top: offsets[i], height: offsets[i + 1] - offsets[i] }} data-index={i}>
        {render(row, i)}
      </div>,
    );
  }

  return (
    <div ref={el} className={['pp-vl', className].filter(Boolean).join(' ')} onScroll={onScroll} {...containerProps}>
      <div className="pp-vl-inner" style={{ height: total }}>{items}</div>
      {footer}
    </div>
  );
}

export const VirtualList = forwardRef(VirtualListInner) as <T>(p: VirtualListProps<T> & { ref?: React.Ref<VirtualListHandle> }) => React.ReactElement;
